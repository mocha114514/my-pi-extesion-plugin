/**
 * Minimal JSONL-RPC subprocess client for the symbiotic relay worker.
 *
 * Spawns `pi --mode rpc` with full extension/MCP discovery enabled (unlike the
 * subagent plugin's restricted sandbox), passing an env marker so relay-mode
 * itself stays inactive inside the worker. Handles UTF-8 chunk boundaries,
 * EPIPE safety, UI request retention, and Windows/Unix process-tree cleanup.
 */

import { type ChildProcess, execFile, execFileSync, spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import { homedir } from "node:os";
import * as path from "node:path";
import { StringDecoder } from "node:string_decoder";

function anchorAgentDir(raw: string): string {
	const home = homedir();
	let expanded = raw;
	if (expanded === "~") expanded = home;
	else if (expanded.startsWith("~/") || (process.platform === "win32" && expanded.startsWith("~\\"))) {
		expanded = path.join(home, expanded.slice(2));
	}
	return path.isAbsolute(expanded) ? path.resolve(expanded) : path.resolve(process.cwd(), expanded);
}

export interface RpcEvent {
	type: string;
	[key: string]: unknown;
}

interface PendingRequest {
	resolve: (data: unknown) => void;
	reject: (error: Error) => void;
}

export type RpcUIResponse = { value: string } | { cancelled: true };
export type RpcUIResponder = (response: RpcUIResponse) => boolean;
export type RpcUIRequestHandler = (request: Record<string, unknown>, respond: RpcUIResponder) => boolean;

/** Locate the current Pi binary/entrypoint using the host argv[1] first. */
export function getPiInvocation(extraArgs: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	if (currentScript && fs.existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...extraArgs] };
	}
	if (process.platform === "win32") {
		return { command: "cmd.exe", args: ["/d", "/s", "/c", "pi", ...extraArgs] };
	}
	return { command: "pi", args: extraArgs };
}

function taskkillTree(pid: number, force: boolean): void {
	try {
		const root = process.env.SystemRoot || "C:\\Windows";
		const exe = path.join(root, "System32", "taskkill.exe");
		const args = force ? ["/pid", String(pid), "/T", "/F"] : ["/pid", String(pid), "/T"];
		const killer = spawn(exe, args, { stdio: "ignore" });
		killer.on("error", () => {});
		killer.unref();
	} catch {
		// Best effort only.
	}
}

export class RelayRpcClient {
	private proc: ChildProcess | null = null;
	private buffer = "";
	private stdoutDecoder = new StringDecoder("utf-8");
	private stderrDecoder = new StringDecoder("utf-8");
	private nextId = 0;
	private pending = new Map<string, PendingRequest>();
	private listeners = new Set<(event: RpcEvent) => void>();
	private exitListeners = new Set<(code: number | null) => void>();
	private processExitListeners = new Set<() => void>();
	private uiRequestHandler: RpcUIRequestHandler | undefined;
	private seenUIRequests = new Set<string>();
	private stderrTail: string[] = [];
	private processExited = false;
	private stopPromise: Promise<void> | undefined;
	private lastUnixSnapshot:
		| { rootPid: number; rootStartId?: string; pids: Map<number, string>; pgids: Map<number, Set<number>> }
		| undefined;
	private rootStartId: string | undefined;
	private snapshotRefreshInFlight = false;

	alive = false;
	private readonly cwd: string;
	private readonly args: string[];
	private readonly env?: Record<string, string>;

	constructor(cwd: string, args: string[], env?: Record<string, string>) {
		this.cwd = cwd;
		this.args = args;
		this.env = env;
	}

	onEvent(listener: (event: RpcEvent) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	onExit(listener: (code: number | null) => void): () => void {
		this.exitListeners.add(listener);
		return () => this.exitListeners.delete(listener);
	}

	/** Fires only when the underlying OS child process actually exits. */
	onProcessExit(listener: () => void): () => void {
		this.processExitListeners.add(listener);
		return () => this.processExitListeners.delete(listener);
	}

	onUIRequest(handler: RpcUIRequestHandler): () => void {
		this.uiRequestHandler = handler;
		return () => {
			if (this.uiRequestHandler === handler) this.uiRequestHandler = undefined;
		};
	}

	stderrText(): string {
		return this.stderrTail.join("\n");
	}

	pid(): number | undefined {
		return this.proc?.pid;
	}

	hasExited(): boolean {
		const proc = this.proc;
		return this.processExited || !proc || proc.exitCode !== null || proc.signalCode !== null;
	}

	async start(onSpawn?: (pid: number) => void): Promise<void> {
		const invocation = getPiInvocation(this.args);
		const spawnEnv: NodeJS.ProcessEnv = this.env ? { ...process.env, ...this.env } : { ...process.env };
		if (spawnEnv.PI_CODING_AGENT_DIR) {
			spawnEnv.PI_CODING_AGENT_DIR = anchorAgentDir(spawnEnv.PI_CODING_AGENT_DIR);
		}
		const proc = spawn(invocation.command, invocation.args, {
			cwd: this.cwd,
			shell: false,
			stdio: ["pipe", "pipe", "pipe"],
			env: spawnEnv,
			detached: process.platform !== "win32",
		});
		this.proc = proc;
		this.rootStartId = undefined;
		this.lastUnixSnapshot = undefined;
		if (typeof proc.pid === "number") {
			onSpawn?.(proc.pid);
			this.refreshUnixSnapshotAsync();
		}
		this.alive = true;
		this.processExited = false;
		this.stopPromise = undefined;
		let drainTimer: ReturnType<typeof setTimeout> | undefined;

		proc.stdout?.on("data", (chunk: Buffer) => this.handleData(this.stdoutDecoder.write(chunk)));
		proc.stderr?.on("data", (chunk: Buffer) => {
			this.stderrTail.push(this.stderrDecoder.write(chunk));
			if (this.stderrTail.length > 20) this.stderrTail.shift();
		});
		proc.stdin?.on("error", () => {
			if (this.alive) this.handleClose(null);
		});
		proc.on("error", () => {
			this.processExited = true;
			if (drainTimer) {
				clearTimeout(drainTimer);
				drainTimer = undefined;
			}
			this.handleClose(null);
		});
		proc.on("exit", (code) => {
			this.processExited = true;
			if (process.platform !== "win32" && this.lastUnixSnapshot) {
				// Reap any verified detached descendants (e.g. Bash tool process groups)
				// that survived an unexpected worker crash or external termination.
				this.reapUnixSnapshot(this.lastUnixSnapshot);
			}
			for (const listener of [...this.processExitListeners]) {
				try {
					listener();
				} catch {
					// Ignore listener errors.
				}
			}
			this.processExitListeners.clear();
			// If a grandchild retains stdout/stderr, `close` may be delayed
			// indefinitely after both unexpected exit AND deliberate shutdown.
			// Allow a brief 250ms drain, then settle pending requests and close
			// inherited pipes so file descriptors do not leak across reloads.
			if (!drainTimer) {
				drainTimer = setTimeout(() => {
					drainTimer = undefined;
					if (this.alive) this.handleClose(code);
					this.disposePipes(proc);
				}, 250);
				drainTimer.unref?.();
			}
		});
		proc.on("close", (code) => {
			this.processExited = true;
			if (drainTimer) {
				clearTimeout(drainTimer);
				drainTimer = undefined;
			}
			this.handleClose(code);
			this.disposePipes(proc);
		});

		// Wait until the RPC loop answers before unreffing child streams so
		// awaiting startup never looks idle to Node's event loop.
		const deadline = Date.now() + 60_000;
		try {
			for (;;) {
				try {
					await this.sendWithTimeout({ type: "get_state" }, 5_000);
					return;
				} catch (error) {
					if (!this.alive) {
						throw new Error(`Worker RPC process exited during startup. ${this.stderrText()}`.trim());
					}
					if (Date.now() > deadline) {
						this.kill();
						throw error;
					}
					await new Promise((resolve) => setTimeout(resolve, 250));
				}
			}
		} finally {
			// Unref child streams once started (or failed) so an idle resident
			// worker never holds the parent's event loop open on exit.
			proc.unref();
			for (const stream of [proc.stdin, proc.stdout, proc.stderr]) {
				(stream as unknown as { unref?: () => void } | null)?.unref?.();
			}
		}
	}

	private syncStdoutRef(): void {
		const stdout = this.proc?.stdout as { ref?: () => void; unref?: () => void } | null | undefined;
		if (!stdout) return;
		if (this.pending.size > 0) stdout.ref?.();
		else stdout.unref?.();
	}

	private disposePipes(proc: ChildProcess | null): void {
		if (!proc) return;
		this.buffer = "";
		for (const stream of [proc.stdout, proc.stderr]) {
			if (!stream) continue;
			try {
				stream.removeAllListeners("data");
				stream.destroy();
			} catch {
				// Best effort stream cleanup.
			}
		}
	}

	private handleClose(code: number | null): void {
		if (!this.alive) return;
		this.alive = false;
		this.uiRequestHandler = undefined;
		this.seenUIRequests.clear();
		const error = new Error(`Worker RPC process exited (code ${code}). ${this.stderrText()}`.trim());
		for (const { reject } of this.pending.values()) reject(error);
		this.pending.clear();
		this.syncStdoutRef();
		const listeners = [...this.exitListeners];
		this.exitListeners.clear();
		for (const listener of listeners) listener(code);
	}

	private handleData(data: string): void {
		if (!this.alive) return;
		this.buffer += data;
		for (;;) {
			if (!this.alive) return;
			const newline = this.buffer.indexOf("\n");
			if (newline < 0) return;
			const line = this.buffer.slice(0, newline).trim();
			this.buffer = this.buffer.slice(newline + 1);
			if (line) this.handleLine(line);
		}
	}

	private handleLine(line: string): void {
		if (!this.alive) return;
		let message: Record<string, unknown>;
		try {
			message = JSON.parse(line) as Record<string, unknown>;
		} catch {
			return;
		}

		if (message.type === "response") {
			const id = typeof message.id === "string" ? message.id : "";
			const entry = this.pending.get(id);
			if (!entry) return;
			this.pending.delete(id);
			if (message.success) {
				entry.resolve(message.data);
			} else {
				entry.reject(new Error(typeof message.error === "string" ? message.error : "RPC command failed"));
			}
			return;
		}

		if (message.type === "extension_ui_request" && typeof message.id === "string") {
			if (this.seenUIRequests.has(message.id)) return;
			this.seenUIRequests.add(message.id);
			if (this.seenUIRequests.size > 500) {
				const oldest = this.seenUIRequests.values().next().value;
				if (oldest !== undefined) this.seenUIRequests.delete(oldest);
			}
			const proc = this.proc;
			let answered = false;
			const respond: RpcUIResponder = (response) => {
				if (
					answered ||
					!this.alive ||
					!proc?.stdin ||
					this.proc !== proc ||
					proc.stdin.destroyed ||
					proc.stdin.writableEnded
				) {
					return false;
				}
				answered = true;
				try {
					proc.stdin.write(`${JSON.stringify({ type: "extension_ui_response", id: message.id, ...response })}\n`);
					return true;
				} catch {
					return false;
				}
			};
			try {
				if (this.uiRequestHandler?.(message, respond)) return;
			} catch {
				// Never leave an unclaimed dialog hanging.
			}
			respond({ cancelled: true });
			return;
		}

		if (typeof message.type === "string") {
			const event = message as unknown as RpcEvent;
			for (const listener of this.listeners) listener(event);
		}
	}

	private isProcessRunning(proc: ChildProcess | null): proc is ChildProcess {
		return Boolean(
			proc &&
			!this.processExited &&
			proc.exitCode === null &&
			proc.signalCode === null &&
			!proc.killed,
		);
	}

	send(command: Record<string, unknown>, timeoutMs?: number, signal?: AbortSignal): Promise<unknown> {
		const proc = this.proc;
		if (!proc?.stdin || !this.alive || this.processExited) return Promise.reject(new Error("Worker RPC process is not running"));
		if (signal?.aborted) return Promise.reject(new Error("Operation aborted."));
		const id = `req-${++this.nextId}`;
		return new Promise((resolve, reject) => {
			let settled = false;
			let timer: ReturnType<typeof setTimeout> | undefined;
			const onAbort = () => {
				finish(() => reject(new Error("Operation aborted.")));
			};
			const finish = (fn: () => void) => {
				if (settled) return;
				settled = true;
				if (timer) clearTimeout(timer);
				signal?.removeEventListener("abort", onAbort);
				this.pending.delete(id);
				this.syncStdoutRef();
				fn();
			};
			if (signal) {
				signal.addEventListener("abort", onAbort, { once: true });
			}
			if (timeoutMs && timeoutMs > 0) {
				timer = setTimeout(() => {
					finish(() => reject(new Error(`RPC command "${String(command.type ?? "unknown")}" timed out after ${timeoutMs}ms`)));
				}, timeoutMs);
			}
			this.pending.set(id, {
				resolve: (data) => finish(() => resolve(data)),
				reject: (err) => finish(() => reject(err)),
			});
			this.syncStdoutRef();
			try {
				proc.stdin!.write(`${JSON.stringify({ id, ...command })}\n`, (error) => {
					if (error) {
						finish(() => reject(error));
					}
				});
			} catch (error) {
				finish(() => reject(error instanceof Error ? error : new Error(String(error))));
			}
		});
	}

	sendWithTimeout(command: Record<string, unknown>, ms: number, signal?: AbortSignal): Promise<unknown> {
		return this.send(command, ms, signal);
	}

	prompt(message: string, streamingBehavior?: "steer" | "followUp", signal?: AbortSignal): Promise<unknown> {
		const cmd: Record<string, unknown> = { type: "prompt", message };
		if (streamingBehavior) cmd.streamingBehavior = streamingBehavior;
		return this.send(cmd, undefined, signal);
	}

	steer(message: string, signal?: AbortSignal): Promise<unknown> {
		return this.send({ type: "steer", message }, undefined, signal);
	}

	followUp(message: string, signal?: AbortSignal): Promise<unknown> {
		return this.send({ type: "follow_up", message }, undefined, signal);
	}

	abort(): Promise<unknown> {
		return this.send({ type: "abort" }, 5_000);
	}

	abortRetry(): Promise<unknown> {
		return this.send({ type: "abort_retry" }, 5_000);
	}

	compact(customInstructions?: string, signal?: AbortSignal): Promise<unknown> {
		return this.send(
			customInstructions ? { type: "compact", customInstructions } : { type: "compact" },
			undefined,
			signal,
		);
	}

	getState(): Promise<Record<string, unknown>> {
		return this.sendWithTimeout({ type: "get_state" }, 5_000) as Promise<Record<string, unknown>>;
	}

	getTree(): Promise<{ tree: unknown[]; leafId: string | null }> {
		return this.sendWithTimeout({ type: "get_tree" }, 10_000) as Promise<{ tree: unknown[]; leafId: string | null }>;
	}

	getEntries(since?: string): Promise<{ entries: unknown[]; leafId: string | null }> {
		return this.sendWithTimeout(
			since ? { type: "get_entries", since } : { type: "get_entries" },
			10_000,
		) as Promise<{ entries: unknown[]; leafId: string | null }>;
	}

	getMessages(): Promise<{ messages: unknown[] }> {
		return this.sendWithTimeout({ type: "get_messages" }, 10_000) as Promise<{ messages: unknown[] }>;
	}

	getSessionStats(): Promise<Record<string, unknown>> {
		return this.sendWithTimeout({ type: "get_session_stats" }, 10_000) as Promise<Record<string, unknown>>;
	}

	getCommands(): Promise<{ commands?: Array<{ name?: unknown; source?: unknown }> }> {
		return this.sendWithTimeout({ type: "get_commands" }, 5_000) as Promise<{
			commands?: Array<{ name?: unknown; source?: unknown }>;
		}>;
	}

	/**
	 * Ask Pi's RPC server to flush and exit cleanly by closing stdin.
	 * Shares one single stop promise/deadline per process lifecycle. Measures RPC
	 * event-loop responsiveness via `get_state` (not `abort`, which can legitimately
	 * take >1s to unwind a tool) so responsive workers always get `responsiveTimeoutMs`
	 * (default 15s) to finish pending credential/MCP writes.
	 */
	gracefulStop(responsiveTimeoutMs = 15_000, unresponsiveTimeoutMs = 2_000): Promise<void> {
		if (this.stopPromise) return this.stopPromise;
		const promise = this.performGracefulStop(responsiveTimeoutMs, unresponsiveTimeoutMs).finally(() => {
			// Cache only while in-flight so a retry can re-attempt stop if the child
			// timed out without actually exiting.
			if (this.stopPromise === promise) {
				this.stopPromise = undefined;
			}
		});
		this.stopPromise = promise;
		return promise;
	}

	private async performGracefulStop(responsiveTimeoutMs: number, unresponsiveTimeoutMs: number): Promise<void> {
		const proc = this.proc;
		this.exitListeners.clear();
		if (!this.isProcessRunning(proc)) {
			if (process.platform !== "win32" && this.lastUnixSnapshot) {
				this.reapUnixSnapshot(this.lastUnixSnapshot);
			}
			this.handleClose(null);
			return;
		}
		const preAbortSnapshot =
			process.platform !== "win32" && proc.pid !== undefined
				? this.collectUnixDescendants(proc.pid)
				: undefined;
		if (preAbortSnapshot) {
			if (!this.rootStartId && preAbortSnapshot.rootStartId) {
				this.rootStartId = preAbortSnapshot.rootStartId;
			}
			this.lastUnixSnapshot = this.mergeUnixSnapshots(this.lastUnixSnapshot, preAbortSnapshot);
		}

		let responsive = false;
		if (this.alive) {
			responsive = await this.send({ type: "get_state" }, 1_000).then(
				() => true,
				() => false,
			);
		}
		const totalBudgetMs = responsive ? responsiveTimeoutMs : unresponsiveTimeoutMs;
		const deadline = Date.now() + totalBudgetMs;

		// On Pi 0.85.1, stdin EOF calls dispose() without awaiting session.abort(),
		// so always attempt abort within the shared deadline (even if get_state
		// timed out) before closing stdin.
		if (this.alive) {
			const abortBudgetMs = Math.max(500, deadline - Date.now());
			await this.send({ type: "abort" }, abortBudgetMs).catch(() => undefined);
		}

		// Take a fresh post-abort snapshot right before closing stdin so tools
		// spawned during abort are also captured, with stable start-time identity.
		const postAbortSnapshot =
			process.platform !== "win32" && proc.pid !== undefined && this.isProcessRunning(proc)
				? this.collectUnixDescendants(proc.pid)
				: undefined;
		const mergedSnapshot = this.mergeUnixSnapshots(
			this.mergeUnixSnapshots(this.lastUnixSnapshot, preAbortSnapshot),
			postAbortSnapshot,
		);
		if (mergedSnapshot) {
			this.lastUnixSnapshot = mergedSnapshot;
		}

		this.handleClose(null);
		if (!this.isProcessRunning(proc)) {
			if (mergedSnapshot) this.reapUnixSnapshot(mergedSnapshot);
			return;
		}
		const remainingWaitMs = Math.max(250, deadline - Date.now());
		await new Promise<void>((resolve) => {
			let finished = false;
			const done = () => {
				if (finished) return;
				finished = true;
				clearTimeout(timer);
				proc.removeListener("close", done);
				proc.removeListener("exit", done);
				if (mergedSnapshot) this.reapUnixSnapshot(mergedSnapshot);
				resolve();
			};
			const timer = setTimeout(() => {
				this.killSync();
				done();
			}, remainingWaitMs);
			proc.once("close", done);
			proc.once("exit", done);
			try {
				proc.stdin?.end();
			} catch {
				this.killSync();
				done();
			}
		});
	}

	kill(): void {
		const proc = this.proc;
		if (this.isProcessRunning(proc)) {
			void this.send({ type: "abort" }, 1_000).catch(() => undefined);
			const pid = proc.pid;
			try {
				if (process.platform === "win32") {
					if (pid !== undefined) taskkillTree(pid, false);
				} else if (pid !== undefined) {
					process.kill(-pid, "SIGTERM");
				}
			} catch {
				// Already gone.
			}
			const cancelTimer = () => clearTimeout(timer);
			const timer = setTimeout(() => {
				proc.removeListener("close", cancelTimer);
				proc.removeListener("exit", cancelTimer);
				if (!this.isProcessRunning(proc)) return;
				try {
					if (process.platform === "win32") {
						if (pid !== undefined) taskkillTree(pid, true);
					} else if (pid !== undefined) {
						process.kill(-pid, "SIGKILL");
					}
				} catch {
					// Already gone.
				}
			}, 1_500);
			timer.unref?.();
			proc.once("close", cancelTimer);
			proc.once("exit", cancelTimer);
		}
		this.handleClose(null);
	}

	/**
	 * Non-blocking Unix process-tree snapshot refresh so detached tool subtrees
	 * (e.g. Bash commands) can still be verified and reaped if the worker exits
	 * unexpectedly before `gracefulStop()` runs.
	 */
	refreshUnixSnapshotAsync(): void {
		if (process.platform === "win32" || this.snapshotRefreshInFlight) return;
		const proc = this.proc;
		if (!this.isProcessRunning(proc) || proc.pid === undefined) return;
		const rootPid = proc.pid;
		const expectedRootStartId = this.rootStartId;
		const psBin = ["/bin/ps", "/usr/bin/ps"].find((p) => fs.existsSync(p));
		if (!psBin) return;
		this.snapshotRefreshInFlight = true;
		execFile(
			psBin,
			["-eo", "pid=,ppid=,pgid=,lstart="],
			{ encoding: "utf-8", timeout: 500, env: { ...process.env, PATH: "/bin:/usr/bin" } },
			(err, stdout) => {
				this.snapshotRefreshInFlight = false;
				if (err || typeof stdout !== "string" || this.proc !== proc) return;
				const rows = this.parseUnixProcessTable(stdout);
				if (rows.length === 0) return;
				const snap = this.buildUnixDescendantsSnapshot(rootPid, rows);
				const stillLive = this.isProcessRunning(proc);
				// Consult the latest verified root identity learned for this exact child
				// handle (including synchronous pre-abort scans completed while this
				// async `ps` call was in flight) before rejecting a late scan.
				const verifiedRootStartId =
					this.rootStartId ?? expectedRootStartId ?? this.lastUnixSnapshot?.rootStartId;
				if (verifiedRootStartId) {
					if (snap.rootStartId && snap.rootStartId !== verifiedRootStartId) return;
				} else if (snap.rootStartId) {
					if (!stillLive) return;
					this.rootStartId = snap.rootStartId;
				}
				const merged = this.mergeUnixSnapshots(this.lastUnixSnapshot, snap, rows);
				if (merged && (merged.rootStartId || merged.pids.size > 0 || merged.pgids.size > 0)) {
					this.lastUnixSnapshot = merged;
				}
				// If the worker exited while this verified scan was in flight, reap
				// any surviving verified descendants that `proc.on("exit")` missed.
				if (!stillLive && merged && (merged.pids.size > 0 || merged.pgids.size > 0)) {
					this.reapUnixSnapshot(merged);
				}
			},
		);
	}

	private parseUnixProcessTable(out: string): Array<{ pid: number; ppid: number; pgid: number; startId: string }> {
		const rows: Array<{ pid: number; ppid: number; pgid: number; startId: string }> = [];
		for (const line of out.split("\n")) {
			const m = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/);
			if (!m) continue;
			const pid = Number(m[1]);
			const ppid = Number(m[2]);
			const pgid = Number(m[3]);
			const startId = m[4]!.trim();
			if (!Number.isInteger(pid) || pid <= 0 || !Number.isInteger(ppid) || !startId) continue;
			rows.push({ pid, ppid, pgid: Number.isInteger(pgid) && pgid > 0 ? pgid : 0, startId });
		}
		return rows;
	}

	private readUnixProcessTable(): Array<{ pid: number; ppid: number; pgid: number; startId: string }> {
		const psBin = ["/bin/ps", "/usr/bin/ps"].find((p) => fs.existsSync(p));
		if (!psBin) return [];
		try {
			const out = execFileSync(psBin, ["-eo", "pid=,ppid=,pgid=,lstart="], {
				encoding: "utf-8",
				timeout: 500,
				env: { ...process.env, PATH: "/bin:/usr/bin" },
			});
			return this.parseUnixProcessTable(out);
		} catch {
			return [];
		}
	}

	private collectUnixDescendants(
		rootPid: number,
	): { rootPid: number; rootStartId?: string; pids: Map<number, string>; pgids: Map<number, Set<number>> } {
		return this.buildUnixDescendantsSnapshot(rootPid, this.readUnixProcessTable());
	}

	private buildUnixDescendantsSnapshot(
		rootPid: number,
		rows: Array<{ pid: number; ppid: number; pgid: number; startId: string }>,
	): { rootPid: number; rootStartId?: string; pids: Map<number, string>; pgids: Map<number, Set<number>> } {
		const pids = new Map<number, string>();
		const pgids = new Map<number, Set<number>>();
		const rootRow = rows.find((r) => r.pid === rootPid);
		const rootStartId = rootRow?.startId;
		const ownPgid = rows.find((r) => r.pid === process.pid)?.pgid;
		const byParent = new Map<number, Array<{ pid: number; pgid: number; startId: string }>>();
		for (const row of rows) {
			let list = byParent.get(row.ppid);
			if (!list) {
				list = [];
				byParent.set(row.ppid, list);
			}
			list.push({ pid: row.pid, pgid: row.pgid, startId: row.startId });
		}
		const queue: number[] = [];
		if (rootRow) {
			queue.push(rootPid);
			if (rootPid !== process.pid && (ownPgid === undefined || rootPid !== ownPgid)) {
				let rootGroup = pgids.get(rootPid);
				if (!rootGroup) {
					rootGroup = new Set<number>();
					pgids.set(rootPid, rootGroup);
				}
				rootGroup.add(rootPid);
				// Capture already-reparented helpers still belonging to the
				// detached worker's process group before rootPid exits.
				for (const row of rows) {
					if (row.pgid === rootPid && row.pid !== process.pid && row.pid !== rootPid && !pids.has(row.pid)) {
						pids.set(row.pid, row.startId);
						rootGroup.add(row.pid);
						queue.push(row.pid);
					}
				}
			}
		}
		while (queue.length > 0) {
			const cur = queue.shift()!;
			for (const child of byParent.get(cur) ?? []) {
				if (child.pid === process.pid || pids.has(child.pid)) continue;
				pids.set(child.pid, child.startId);
				if (child.pgid > 0 && child.pgid !== process.pid && (ownPgid === undefined || child.pgid !== ownPgid)) {
					let members = pgids.get(child.pgid);
					if (!members) {
						members = new Set<number>();
						pgids.set(child.pgid, members);
					}
					members.add(child.pid);
				}
				queue.push(child.pid);
			}
		}
		return { rootPid, rootStartId, pids, pgids };
	}

	private mergeUnixSnapshots(
		a?: { rootPid: number; rootStartId?: string; pids: Map<number, string>; pgids: Map<number, Set<number>> },
		b?: { rootPid: number; rootStartId?: string; pids: Map<number, string>; pgids: Map<number, Set<number>> },
		liveRows?: Array<{ pid: number; ppid: number; pgid: number; startId: string }>,
	): { rootPid: number; rootStartId?: string; pids: Map<number, string>; pgids: Map<number, Set<number>> } | undefined {
		if (!a) return b;
		if (!b) return a;
		// When a fresh process table is available, prune already-exited entries from
		// prior scans so long-lived workers do not accumulate dead PIDs unboundedly,
		// while preserving still-living reparented descendants with verified startIds.
		const liveByPid = liveRows ? new Map(liveRows.map((r) => [r.pid, r])) : undefined;
		const pids = new Map<number, string>();
		for (const [k, v] of a.pids) {
			if (!liveByPid || liveByPid.get(k)?.startId === v) {
				pids.set(k, v);
			}
		}
		for (const [k, v] of b.pids) pids.set(k, v);
		const pgids = new Map<number, Set<number>>();
		for (const [pgid, set] of a.pgids) {
			for (const p of set) {
				if (p === a.rootPid || pids.has(p)) {
					let target = pgids.get(pgid);
					if (!target) {
						target = new Set<number>();
						pgids.set(pgid, target);
					}
					target.add(p);
				}
			}
		}
		for (const [pgid, set] of b.pgids) {
			const target = pgids.get(pgid) ?? new Set<number>();
			for (const p of set) target.add(p);
			pgids.set(pgid, target);
		}
		return { rootPid: a.rootPid, rootStartId: a.rootStartId ?? b.rootStartId, pids, pgids };
	}

	private reapUnixSnapshot(snapshot: {
		rootPid: number;
		rootStartId?: string;
		pids: Map<number, string>;
		pgids: Map<number, Set<number>>;
	}): void {
		if (!snapshot.rootStartId && snapshot.pids.size === 0 && snapshot.pgids.size === 0) return;
		// Re-verify process start times before signaling so recycled PIDs/PGIDs
		// are never killed by mistake, and expand verified survivors (including
		// the verified root worker itself!) to any new children spawned after the scan.
		const liveRows = this.readUnixProcessTable();
		if (liveRows.length === 0) return;
		const liveByPid = new Map<number, { ppid: number; pgid: number; startId: string }>();
		const liveByParent = new Map<number, Array<{ pid: number; pgid: number; startId: string }>>();
		const liveByPgid = new Map<number, number[]>();
		for (const row of liveRows) {
			liveByPid.set(row.pid, { ppid: row.ppid, pgid: row.pgid, startId: row.startId });
			let children = liveByParent.get(row.ppid);
			if (!children) {
				children = [];
				liveByParent.set(row.ppid, children);
			}
			children.push({ pid: row.pid, pgid: row.pgid, startId: row.startId });
			if (row.pgid > 0) {
				let list = liveByPgid.get(row.pgid);
				if (!list) {
					list = [];
					liveByPgid.set(row.pgid, list);
				}
				list.push(row.pid);
			}
		}

		// Seed verified survivor set with snapshotted PIDs AND the verified root PID.
		const verifiedSurvivors = new Map<number, string>();
		const verifiedPgids = new Set<number>();
		const queue: number[] = [];
		if (snapshot.rootStartId) {
			const liveRoot = liveByPid.get(snapshot.rootPid);
			if (liveRoot && liveRoot.startId === snapshot.rootStartId) {
				queue.push(snapshot.rootPid);
			}
		}
		for (const [pid, expectedStart] of snapshot.pids) {
			const live = liveByPid.get(pid);
			if (live && live.startId === expectedStart) {
				verifiedSurvivors.set(pid, live.startId);
				queue.push(pid);
			}
		}
		while (queue.length > 0) {
			const cur = queue.shift()!;
			for (const child of liveByParent.get(cur) ?? []) {
				if (child.pid === process.pid || verifiedSurvivors.has(child.pid)) continue;
				verifiedSurvivors.set(child.pid, child.startId);
				if (child.pgid > 0 && child.pgid !== process.pid) {
					verifiedPgids.add(child.pgid);
				}
				queue.push(child.pid);
			}
		}
		for (const [pgid] of snapshot.pgids) {
			verifiedPgids.add(pgid);
		}

		const ownPgid = liveByPid.get(process.pid)?.pgid;
		for (const pgid of verifiedPgids) {
			if (pgid === process.pid || (ownPgid !== undefined && pgid === ownPgid)) continue;
			const currentMembers = liveByPgid.get(pgid) ?? [];
			if (currentMembers.length === 0) continue;
			const allVerified = currentMembers.every((memberPid) => {
				const expectedStart = verifiedSurvivors.get(memberPid);
				const live = liveByPid.get(memberPid);
				return Boolean(expectedStart && live && live.startId === expectedStart);
			});
			// Also allow killing the group when at least one identity-verified
			// original snapshot member (or verified rootPid) currently belongs to
			// `pgid`, catching late reparented descendants in that process group.
			const hasVerifiedGroupMember = currentMembers.some((memberPid) => {
				const live = liveByPid.get(memberPid);
				if (!live || live.pgid !== pgid) return false;
				const expectedStart =
					snapshot.pids.get(memberPid) ??
					(memberPid === snapshot.rootPid ? snapshot.rootStartId : undefined);
				return Boolean(expectedStart && live.startId === expectedStart);
			});
			if (allVerified || hasVerifiedGroupMember) {
				try {
					process.kill(-pgid, "SIGKILL");
				} catch {
					// Already gone.
				}
			}
		}
		for (const [pid, expectedStart] of verifiedSurvivors) {
			const live = liveByPid.get(pid);
			if (!live || live.startId !== expectedStart) continue;
			try {
				process.kill(pid, "SIGKILL");
			} catch {
				// Already gone.
			}
		}
	}

	private reapUnixProcessTree(rootPid: number): void {
		const snapshot = this.mergeUnixSnapshots(this.lastUnixSnapshot, this.collectUnixDescendants(rootPid));
		if (snapshot) {
			this.lastUnixSnapshot = snapshot;
			this.reapUnixSnapshot(snapshot);
		}
		try {
			process.kill(-rootPid, "SIGKILL");
		} catch {
			try {
				process.kill(rootPid, "SIGKILL");
			} catch {
				// Already gone.
			}
		}
	}

	killSync(): void {
		const proc = this.proc;
		if (this.isProcessRunning(proc)) {
			const pid = proc.pid;
			try {
				if (process.platform === "win32") {
					if (pid !== undefined) {
						const root = process.env.SystemRoot || "C:\\Windows";
						spawnSync(path.join(root, "System32", "taskkill.exe"), ["/pid", String(pid), "/T", "/F"], {
							stdio: "ignore",
							timeout: 3_000,
						});
					}
				} else if (pid !== undefined) {
					this.reapUnixProcessTree(pid);
				}
			} catch {
				// Already gone.
			}
		} else if (process.platform !== "win32" && this.lastUnixSnapshot) {
			this.reapUnixSnapshot(this.lastUnixSnapshot);
		}
		this.handleClose(null);
	}
}
