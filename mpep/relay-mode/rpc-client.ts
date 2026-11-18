/**
 * Minimal JSONL-RPC subprocess client for the symbiotic relay worker.
 *
 * Spawns `pi --mode rpc` with full extension/MCP discovery enabled (unlike the
 * subagent plugin's restricted sandbox), passing an env marker so relay-mode
 * itself stays inactive inside the worker. Handles UTF-8 chunk boundaries,
 * EPIPE safety, UI request retention, and Windows/Unix process-tree cleanup.
 */

import { type ChildProcess, execFileSync, spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { StringDecoder } from "node:string_decoder";

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

	async start(onSpawn?: (pid: number) => void): Promise<void> {
		const invocation = getPiInvocation(this.args);
		const proc = spawn(invocation.command, invocation.args, {
			cwd: this.cwd,
			shell: false,
			stdio: ["pipe", "pipe", "pipe"],
			env: this.env ? { ...process.env, ...this.env } : process.env,
			detached: process.platform !== "win32",
		});
		this.proc = proc;
		if (typeof proc.pid === "number") {
			onSpawn?.(proc.pid);
		}
		this.alive = true;
		this.processExited = false;
		this.stopPromise = undefined;

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
			this.handleClose(null);
		});
		proc.on("exit", () => {
			this.processExited = true;
			for (const listener of [...this.processExitListeners]) {
				try {
					listener();
				} catch {
					// Ignore listener errors.
				}
			}
			this.processExitListeners.clear();
		});
		proc.on("close", (code) => {
			this.processExited = true;
			this.handleClose(code);
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
		this.buffer += data;
		for (;;) {
			const newline = this.buffer.indexOf("\n");
			if (newline < 0) return;
			const line = this.buffer.slice(0, newline).trim();
			this.buffer = this.buffer.slice(newline + 1);
			if (line) this.handleLine(line);
		}
	}

	private handleLine(line: string): void {
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
		if (!proc?.stdin || !this.alive) return Promise.reject(new Error("Worker RPC process is not running"));
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
		this.stopPromise = this.performGracefulStop(responsiveTimeoutMs, unresponsiveTimeoutMs);
		return this.stopPromise;
	}

	private async performGracefulStop(responsiveTimeoutMs: number, unresponsiveTimeoutMs: number): Promise<void> {
		const proc = this.proc;
		this.exitListeners.clear();
		if (!this.isProcessRunning(proc)) {
			this.handleClose(null);
			return;
		}
		const preAbortSnapshot =
			process.platform !== "win32" && proc.pid !== undefined
				? this.collectUnixDescendants(proc.pid)
				: undefined;

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
		const mergedSnapshot = this.mergeUnixSnapshots(preAbortSnapshot, postAbortSnapshot);

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

	private readUnixProcessTable(): Array<{ pid: number; ppid: number; pgid: number; startId: string }> {
		const psBin = ["/bin/ps", "/usr/bin/ps"].find((p) => fs.existsSync(p));
		if (!psBin) return [];
		try {
			const out = execFileSync(psBin, ["-eo", "pid=,ppid=,pgid=,lstart="], {
				encoding: "utf-8",
				timeout: 500,
				env: { ...process.env, PATH: "/bin:/usr/bin" },
			});
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
		} catch {
			return [];
		}
	}

	private collectUnixDescendants(
		rootPid: number,
	): { pids: Map<number, string>; pgids: Map<number, Set<number>> } {
		const pids = new Map<number, string>();
		const pgids = new Map<number, Set<number>>();
		const rows = this.readUnixProcessTable();
		const byParent = new Map<number, Array<{ pid: number; pgid: number; startId: string }>>();
		for (const row of rows) {
			let list = byParent.get(row.ppid);
			if (!list) {
				list = [];
				byParent.set(row.ppid, list);
			}
			list.push({ pid: row.pid, pgid: row.pgid, startId: row.startId });
		}
		const queue: number[] = [rootPid];
		while (queue.length > 0) {
			const cur = queue.shift()!;
			for (const child of byParent.get(cur) ?? []) {
				if (child.pid === process.pid || pids.has(child.pid)) continue;
				pids.set(child.pid, child.startId);
				if (child.pgid > 0 && child.pgid !== process.pid && child.pgid !== rootPid) {
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
		return { pids, pgids };
	}

	private mergeUnixSnapshots(
		a?: { pids: Map<number, string>; pgids: Map<number, Set<number>> },
		b?: { pids: Map<number, string>; pgids: Map<number, Set<number>> },
	): { pids: Map<number, string>; pgids: Map<number, Set<number>> } | undefined {
		if (!a) return b;
		if (!b) return a;
		const pids = new Map(a.pids);
		for (const [k, v] of b.pids) pids.set(k, v);
		const pgids = new Map<number, Set<number>>();
		for (const [pgid, set] of a.pgids) pgids.set(pgid, new Set(set));
		for (const [pgid, set] of b.pgids) {
			const target = pgids.get(pgid) ?? new Set<number>();
			for (const p of set) target.add(p);
			pgids.set(pgid, target);
		}
		return { pids, pgids };
	}

	private reapUnixSnapshot(snapshot: { pids: Map<number, string>; pgids: Map<number, Set<number>> }): void {
		if (snapshot.pids.size === 0 && snapshot.pgids.size === 0) return;
		// Re-verify process start times before signaling so recycled PIDs/PGIDs
		// are never killed by mistake, and expand verified survivors to any new
		// children they spawned after the snapshot was taken.
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

		// Seed verified survivor set with snapshotted PIDs whose startId matches,
		// then walk live children spawned by those verified survivors.
		const verifiedSurvivors = new Map<number, string>();
		const verifiedPgids = new Set<number>();
		const queue: number[] = [];
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

		for (const pgid of verifiedPgids) {
			const currentMembers = liveByPgid.get(pgid) ?? [];
			if (currentMembers.length === 0) continue;
			const allVerified = currentMembers.every((memberPid) => {
				const expectedStart = verifiedSurvivors.get(memberPid);
				const live = liveByPid.get(memberPid);
				return Boolean(expectedStart && live && live.startId === expectedStart);
			});
			if (allVerified) {
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
		const snapshot = this.collectUnixDescendants(rootPid);
		this.reapUnixSnapshot(snapshot);
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
		}
		this.handleClose(null);
	}
}
