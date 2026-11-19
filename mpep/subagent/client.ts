/**
 * Minimal JSONL-RPC client for a resident `pi --mode rpc` subprocess.
 *
 * Modeled on pi-coding-agent's own RpcClient, but spawns through the same
 * pi-invocation detection as the CLI (handles node script / bun / compiled
 * binary installs) and supports killing the whole process tree, which matters
 * on Windows where the RPC child is itself a `node` wrapper.
 *
 * Protocol (newline-delimited JSON on stdio):
 *   request:  { id, type: "<command>", ... }
 *   response: { id, type: "response", command, success, data | error }
 *   event:    raw event objects ({ type: "agent_end", ... }) — NOT wrapped.
 *
 * Hardening notes (from review):
 *   - stdout is decoded with a persistent StringDecoder so multibyte UTF-8
 *     characters split across chunks are not corrupted;
 *   - stdin carries an error listener: a child closing stdin mid-write would
 *     otherwise raise an asynchronous EPIPE that crashes the parent;
 *   - extension UI requests default to cancellation; a scoped handler may
 *     retain deletion-approval selects until the supervising agent decides;
 *   - kill() escalates: cooperative abort, SIGTERM/group-TERM, then a hard
 *     kill on a short fuse; on Windows the tree is killed via taskkill
 *     resolved from System32 with spawn errors consumed.
 */

import { type ChildProcess, execFileSync, spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { StringDecoder } from "node:string_decoder";

/** Loosely typed on purpose: we only read a handful of event fields. */
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
/** Return true only when the request has been handled or deliberately retained. */
export type RpcUIRequestHandler = (request: Record<string, unknown>, respond: RpcUIResponder) => boolean;

/**
 * Locate the current pi installation. Same strategy as the official subagent
 * example: prefer the running script (argv[1]), fall back to PATH lookups.
 */
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

/** Windows tree kill; taskkill is resolved from System32 and its asynchronous
 * spawn errors are consumed so a restricted PATH cannot crash the parent. */
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

export class RpcSubprocess {
	private proc: ChildProcess | null = null;
	private buffer = "";
	private stdoutDecoder = new StringDecoder("utf-8");
	private stderrDecoder = new StringDecoder("utf-8");
	private nextId = 0;
	private pending = new Map<string, PendingRequest>();
	private listeners = new Set<(event: RpcEvent) => void>();
	private exitListeners = new Set<(code: number | null) => void>();
	private uiRequestHandler: RpcUIRequestHandler | undefined;
	private seenUIRequests = new Set<string>();
	private stderrTail: string[] = [];
	private exited = false;
	private rootStartId: string | undefined;
	private readonly cwd: string;
	private readonly args: string[];
	private readonly env: Record<string, string> | undefined;

	/** The subprocess is considered dead once close fires. */
	alive = false;

	constructor(cwd: string, args: string[], env?: Record<string, string>) {
		this.cwd = cwd;
		this.args = args;
		this.env = env;
	}

	onEvent(listener: (event: RpcEvent) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	/** Returns an unsubscribe function; completed runs must not accumulate. */
	onExit(listener: (code: number | null) => void): () => void {
		this.exitListeners.add(listener);
		return () => this.exitListeners.delete(listener);
	}

	/** One run owns UI delegation at a time; all unclaimed dialogs still cancel. */
	onUIRequest(handler: RpcUIRequestHandler): () => void {
		this.uiRequestHandler = handler;
		return () => {
			if (this.uiRequestHandler === handler) this.uiRequestHandler = undefined;
		};
	}

	stderrText(): string {
		return this.stderrTail.join("\n");
	}

	async start(): Promise<void> {
		const invocation = getPiInvocation(this.args);
		const proc = spawn(invocation.command, invocation.args, {
			cwd: this.cwd,
			shell: false,
			stdio: ["pipe", "pipe", "pipe"],
			env: this.env ? { ...process.env, ...this.env } : process.env,
			// Own process group on Unix so kill() can signal the whole group.
			detached: process.platform !== "win32",
		});
		this.proc = proc;
		this.alive = true;
		this.exited = false;
		if (process.platform !== "win32" && proc.pid !== undefined) {
			this.rootStartId = this.readUnixStartId(proc.pid);
		}

		proc.stdout?.on("data", (chunk: Buffer) => this.handleData(this.stdoutDecoder.write(chunk)));
		proc.stderr?.on("data", (chunk: Buffer) => {
			this.stderrTail.push(this.stderrDecoder.write(chunk));
			if (this.stderrTail.length > 10) this.stderrTail.shift();
		});
		// A child closing stdin mid-write raises EPIPE asynchronously; without a
		// listener this is an unhandled error that terminates the parent.
		proc.stdin?.on("error", () => {
			if (this.alive) this.handleClose(null);
		});
		proc.on("exit", () => {
			this.exited = true;
		});
		proc.on("error", () => {
			this.exited = true;
			this.handleClose(null);
		});
		proc.on("close", (code) => {
			this.exited = true;
			this.handleClose(code);
		});

		// The child must not hold the parent's event loop open: in print mode the
		// main process exits right after the run even when an instance is kept
		// resident. Unref everything; the exit handler still reaps children.
		proc.unref();
		for (const stream of [proc.stdin, proc.stdout, proc.stderr]) {
			(stream as unknown as { unref?: () => void } | null)?.unref?.();
		}

		// Wait until the RPC loop answers. Startup includes config/auth loading
		// and can take a moment; each attempt is bounded by a real timer so a
		// stalled (but alive) child cannot hang the dispatch forever.
		const deadline = Date.now() + 60_000;
		for (;;) {
			try {
				await this.sendWithTimeout({ type: "get_state" }, 5_000);
				return;
			} catch (error) {
				if (!this.alive) throw new Error(`pi RPC process exited during startup. ${this.stderrText()}`);
				if (Date.now() > deadline) {
					this.kill();
					throw error;
				}
				await new Promise((resolve) => setTimeout(resolve, 250));
			}
		}
	}

	private handleClose(code: number | null): void {
		if (!this.alive) return;
		this.alive = false;
		this.uiRequestHandler = undefined;
		this.seenUIRequests.clear();
		const error = new Error(`pi RPC process exited (code ${code}). ${this.stderrText()}`);
		for (const { reject } of this.pending.values()) reject(error);
		this.pending.clear();
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

		// Only the current run's scoped handler may retain a dialog. Responses
		// are single-use and bound to this exact process, including after teardown.
		if (message.type === "extension_ui_request" && typeof message.id === "string") {
			if (this.seenUIRequests.has(message.id)) return;
			this.seenUIRequests.add(message.id);
			const proc = this.proc;
			let answered = false;
			const respond: RpcUIResponder = (response) => {
				if (answered || !this.alive || !proc?.stdin || this.proc !== proc ||
					proc.stdin.destroyed || proc.stdin.writableEnded) return false;
				answered = true;
				try {
					proc.stdin.write(`${JSON.stringify({ type: "extension_ui_response", id: message.id, ...response })}\n`);
					return true;
				} catch {
					// Child is dying; its close handler reports the failure.
					return false;
				}
			};
			try {
				if (this.uiRequestHandler?.(message, respond)) return;
			} catch {
				// A failed delegate must never turn an unrelated dialog into a hang.
			}
			respond({ cancelled: true });
			return;
		}

		// Everything else is a session event emitted as-is ({ type: "agent_end", ... }).
		if (typeof message.type === "string") {
			const event = message as unknown as RpcEvent;
			for (const listener of this.listeners) listener(event);
		}
	}

	/** Send a command and wait for its response (matched by id). */
	send(command: Record<string, unknown>): Promise<unknown> {
		const proc = this.proc;
		if (!proc?.stdin || !this.alive) return Promise.reject(new Error("pi RPC process is not running"));
		const id = `req-${++this.nextId}`;
		return new Promise((resolve, reject) => {
			this.pending.set(id, { resolve, reject });
			try {
				proc.stdin!.write(`${JSON.stringify({ id, ...command })}\n`, (error) => {
					if (error) {
						this.pending.delete(id);
						reject(error);
					}
				});
			} catch (error) {
				this.pending.delete(id);
				reject(error instanceof Error ? error : new Error(String(error)));
			}
		});
	}

	/** send() bounded by a real timer; the pending entry is dropped on timeout. */
	private sendWithTimeout(command: Record<string, unknown>, ms: number): Promise<unknown> {
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error(`RPC command timed out after ${ms}ms`)), ms);
			timer.unref?.();
			this.send(command).then(
				(value) => { clearTimeout(timer); resolve(value); },
				(error: unknown) => { clearTimeout(timer); reject(error instanceof Error ? error : new Error(String(error))); },
			);
		});
	}

	/** Fire a prompt; the returned promise resolves once the run is accepted.
	 * followUp queueing: a busy child (e.g. mid-compaction from the injected
	 * compact-forewarn) queues the task instead of rejecting it. */
	prompt(message: string): Promise<unknown> {
		return this.send({ type: "prompt", message, streamingBehavior: "followUp" });
	}

	abort(): Promise<unknown> {
		return this.send({ type: "abort" }).catch(() => undefined);
	}

	/** Live session state (isStreaming/isCompacting/pendingMessageCount).
	 * Used after agent_settled to confirm the child is TRULY idle: 0.85.x runs
	 * auto-compaction asynchronously after settle, and a compaction-resumed run
	 * would otherwise look like fresh output arriving after delivery.
	 * Bounded: a child whose event loop is stalled must not hang the probe. */
	async getState(): Promise<{ isStreaming?: boolean; isCompacting?: boolean; pendingMessageCount?: number }> {
		const state = (await this.sendWithTimeout({ type: "get_state" }, 5_000)) as Record<string, unknown>;
		return state;
	}

	/**
	 * Terminate the child with escalation: cooperative RPC abort, a soft
	 * kill (process group on Unix, tree kill on Windows), then a hard kill
	 * on a short fuse. Pending requests reject immediately via handleClose;
	 * the escalation only concerns reaping the OS processes.
	 */
	private isLiveChildProc(proc: ChildProcess | null): proc is ChildProcess {
		return Boolean(proc && !this.exited && proc.exitCode === null && proc.signalCode === null && !proc.killed);
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

	private readUnixStartId(pid: number): string | undefined {
		return this.readUnixProcessTable().find((r) => r.pid === pid)?.startId;
	}

	private collectUnixTreeSnapshot(rootPid: number): { rootPid: number; rootStartId?: string; members: Map<number, string>; pgids: Set<number> } | null {
		const initialRows = this.readUnixProcessTable();
		if (initialRows.length === 0) return null;
		const rootRow = initialRows.find((r) => r.pid === rootPid);
		if (!rootRow) return null;
		// Abort if ps proves the OS recycled rootPid since spawn.
		if (this.rootStartId && rootRow.startId !== this.rootStartId) {
			return { rootPid, rootStartId: undefined, members: new Map(), pgids: new Set() };
		}
		const byParent = new Map<number, Array<{ pid: number; pgid: number; startId: string }>>();
		for (const row of initialRows) {
			let list = byParent.get(row.ppid);
			if (!list) {
				list = [];
				byParent.set(row.ppid, list);
			}
			list.push({ pid: row.pid, pgid: row.pgid, startId: row.startId });
		}
		const members = new Map<number, string>();
		const pgids = new Set<number>();
		const queue = [rootPid];
		members.set(rootPid, rootRow.startId);
		pgids.add(rootPid);
		// Also include any existing members of the child's process group.
		for (const row of initialRows) {
			if (row.pgid === rootPid && row.pid !== process.pid && !members.has(row.pid)) {
				members.set(row.pid, row.startId);
				queue.push(row.pid);
			}
		}
		while (queue.length > 0) {
			const cur = queue.shift()!;
			for (const child of byParent.get(cur) ?? []) {
				if (child.pid === process.pid || members.has(child.pid)) continue;
				members.set(child.pid, child.startId);
				if (child.pgid > 0 && child.pgid !== process.pid) {
					pgids.add(child.pgid);
				}
				queue.push(child.pid);
			}
		}
		return { rootPid, rootStartId: rootRow.startId, members, pgids };
	}

	private reapVerifiedUnixSnapshot(
		snapshot: { rootPid: number; rootStartId?: string; members: Map<number, string>; pgids: Set<number> },
	): boolean {
		if (snapshot.members.size === 0) return true;
		const verifyRows = this.readUnixProcessTable();
		if (verifyRows.length === 0) return false;
		const liveByPid = new Map<number, { pgid: number; startId: string }>();
		const liveByParent = new Map<number, Array<{ pid: number; pgid: number; startId: string }>>();
		const liveByPgid = new Map<number, number[]>();
		for (const row of verifyRows) {
			liveByPid.set(row.pid, { pgid: row.pgid, startId: row.startId });
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

		// Expand from all identity-verified survivors (including rootPid and group
		// members) to catch newly forked children before checking PGIDs.
		const verified = new Map<number, string>();
		const verifiedPgids = new Set<number>(snapshot.pgids);
		const queue: number[] = [];
		for (const [pid, expectedStart] of snapshot.members) {
			const live = liveByPid.get(pid);
			if (live && live.startId === expectedStart) {
				verified.set(pid, live.startId);
				queue.push(pid);
			}
		}
		while (queue.length > 0) {
			const cur = queue.shift()!;
			for (const child of liveByParent.get(cur) ?? []) {
				if (child.pid === process.pid || verified.has(child.pid)) continue;
				verified.set(child.pid, child.startId);
				if (child.pgid > 0 && child.pgid !== process.pid) {
					verifiedPgids.add(child.pgid);
				}
				queue.push(child.pid);
			}
		}

		const ownPgid = liveByPid.get(process.pid)?.pgid;
		for (const pgid of verifiedPgids) {
			if (pgid === process.pid || (ownPgid !== undefined && pgid === ownPgid)) continue;
			const members = liveByPgid.get(pgid) ?? [];
			if (members.length === 0) continue;
			const allVerified = members.every((m) => {
				const expected = verified.get(m);
				const live = liveByPid.get(m);
				return Boolean(expected && live && live.startId === expected);
			});
			// Also allow killing the group when an identity-verified original snapshot
			// member is currently in `pgid`, catching late reparented group members.
			const hasVerifiedGroupMember = members.some((m) => {
				const expected = snapshot.members.get(m);
				const live = liveByPid.get(m);
				return Boolean(expected && live && live.startId === expected && live.pgid === pgid);
			});
			if (allVerified || hasVerifiedGroupMember) {
				try {
					process.kill(-pgid, "SIGKILL");
				} catch {
					// Already gone.
				}
			}
		}
		for (const [pid, expectedStart] of verified) {
			const live = liveByPid.get(pid);
			if (!live || live.startId !== expectedStart) continue;
			try {
				process.kill(pid, "SIGKILL");
			} catch {
				// Already gone.
			}
		}
		return true;
	}

	hasConfirmedExit(): boolean {
		const proc = this.proc;
		if (this.exited || !proc || proc.exitCode !== null || proc.signalCode !== null) return true;
		const pid = proc.pid;
		if (pid === undefined) return true;
		try {
			process.kill(pid, 0);
			return false;
		} catch (err) {
			return (err as NodeJS.ErrnoException).code !== "EPERM";
		}
	}

	kill(): void {
		const proc = this.proc;
		if (this.isLiveChildProc(proc)) {
			void this.abort();
			const pid = proc.pid;
			const capturedRootStartId = this.rootStartId;
			const unixSnapshot =
				process.platform !== "win32" && pid !== undefined
					? this.collectUnixTreeSnapshot(pid)
					: null;
			const leaderPid = pid;
			try {
				if (process.platform === "win32") {
					if (pid !== undefined) taskkillTree(pid, false);
				} else if (pid !== undefined) {
					const liveStartId = capturedRootStartId ? this.readUnixStartId(pid) : undefined;
					if (!capturedRootStartId || liveStartId === undefined || liveStartId === capturedRootStartId) {
						// Always send SIGTERM first (even when `ps` is unavailable) so Pi's
						// own SIGTERM handler can cleanly kill any detached Bash tool subtrees
						// it tracks before the 1.5s SIGKILL escalation runs.
						process.kill(-pid, "SIGTERM");
					}
				}
			} catch {
				// Already gone.
			}
			const timer = setTimeout(() => {
				try {
					if (process.platform === "win32") {
						if (pid !== undefined) taskkillTree(pid, true);
					} else if (leaderPid !== undefined) {
						const reaped = unixSnapshot ? this.reapVerifiedUnixSnapshot(unixSnapshot) : false;
						// Without a verified `ps` snapshot, only escalate to SIGKILL while
						// Node still confirms our own child process handle (`proc`) is alive;
						// never send an unverified delayed group SIGKILL after the leader
						// has exited (its PID could have been reused by an unrelated group).
						if (!reaped && this.isLiveChildProc(proc)) {
							const liveStartId = capturedRootStartId ? this.readUnixStartId(leaderPid) : undefined;
							if (!capturedRootStartId || liveStartId === undefined || liveStartId === capturedRootStartId) {
								process.kill(-leaderPid, "SIGKILL");
							}
						}
					}
				} catch {
					// Already gone.
				}
			}, 1_500);
			timer.unref?.();
		}
		this.handleClose(null);
	}

	/**
	 * Synchronous hard kill for process-exit and reload paths, where kill()'s
	 * escalation timer would never fire (unref'd timers do not run during
	 * exit). Blocks briefly; only ever called at teardown.
	 */
	private reapUnixDescendants(rootPid: number): void {
		const snapshot = this.collectUnixTreeSnapshot(rootPid);
		if (snapshot === null || !this.reapVerifiedUnixSnapshot(snapshot)) {
			// Process-table lookup unavailable or verification read failed: fall
			// back to killing the owned child group/PID directly.
			if (this.isLiveChildProc(this.proc)) {
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
			return;
		}
	}

	killSync(): void {
		const proc = this.proc;
		if (this.isLiveChildProc(proc)) {
			const pid = proc.pid;
			try {
				if (process.platform === "win32") {
					if (pid !== undefined) {
						const root = process.env.SystemRoot || "C:\\Windows";
						spawnSync(path.join(root, "System32", "taskkill.exe"), ["/pid", String(pid), "/T", "/F"], { stdio: "ignore", timeout: 3_000 });
					}
				} else if (pid !== undefined) {
					this.reapUnixDescendants(pid);
				}
			} catch {
				// Already gone.
			}
		}
		this.handleClose(null);
	}
}
