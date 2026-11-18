/**
 * Minimal JSONL-RPC subprocess client for the symbiotic relay worker.
 *
 * Spawns `pi --mode rpc` with full extension/MCP discovery enabled (unlike the
 * subagent plugin's restricted sandbox), passing an env marker so relay-mode
 * itself stays inactive inside the worker. Handles UTF-8 chunk boundaries,
 * EPIPE safety, UI request retention, and Windows/Unix process-tree cleanup.
 */

import { type ChildProcess, spawn, spawnSync } from "node:child_process";
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
	private uiRequestHandler: RpcUIRequestHandler | undefined;
	private seenUIRequests = new Set<string>();
	private stderrTail: string[] = [];

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
			detached: process.platform !== "win32",
		});
		this.proc = proc;
		this.alive = true;

		proc.stdout?.on("data", (chunk: Buffer) => this.handleData(this.stdoutDecoder.write(chunk)));
		proc.stderr?.on("data", (chunk: Buffer) => {
			this.stderrTail.push(this.stderrDecoder.write(chunk));
			if (this.stderrTail.length > 20) this.stderrTail.shift();
		});
		proc.stdin?.on("error", () => {
			if (this.alive) this.handleClose(null);
		});
		proc.on("error", () => this.handleClose(null));
		proc.on("close", (code) => this.handleClose(code));

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

	private handleClose(code: number | null): void {
		if (!this.alive) return;
		this.alive = false;
		this.uiRequestHandler = undefined;
		this.seenUIRequests.clear();
		const error = new Error(`Worker RPC process exited (code ${code}). ${this.stderrText()}`.trim());
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

	send(command: Record<string, unknown>): Promise<unknown> {
		const proc = this.proc;
		if (!proc?.stdin || !this.alive) return Promise.reject(new Error("Worker RPC process is not running"));
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

	sendWithTimeout(command: Record<string, unknown>, ms: number): Promise<unknown> {
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error(`RPC command timed out after ${ms}ms`)), ms);
			this.send(command).then(
				(value) => {
					clearTimeout(timer);
					resolve(value);
				},
				(error: unknown) => {
					clearTimeout(timer);
					reject(error instanceof Error ? error : new Error(String(error)));
				},
			);
		});
	}

	prompt(message: string, streamingBehavior: "steer" | "followUp" = "followUp"): Promise<unknown> {
		return this.send({ type: "prompt", message, streamingBehavior });
	}

	steer(message: string): Promise<unknown> {
		return this.send({ type: "steer", message });
	}

	followUp(message: string): Promise<unknown> {
		return this.send({ type: "follow_up", message });
	}

	abort(): Promise<unknown> {
		return this.send({ type: "abort" }).catch(() => undefined);
	}

	abortRetry(): Promise<unknown> {
		return this.send({ type: "abort_retry" }).catch(() => undefined);
	}

	compact(customInstructions?: string): Promise<unknown> {
		return this.send(customInstructions ? { type: "compact", customInstructions } : { type: "compact" });
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

	kill(): void {
		const proc = this.proc;
		if (proc && proc.exitCode === null && !proc.killed) {
			void this.abort();
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
			const timer = setTimeout(() => {
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
		}
		this.handleClose(null);
	}

	killSync(): void {
		const proc = this.proc;
		if (proc && proc.exitCode === null && !proc.killed) {
			const pid = proc.pid;
			try {
				if (process.platform === "win32") {
					if (pid !== undefined) {
						const root = process.env.SystemRoot || "C:\\Windows";
						spawnSync(path.join(root, "System32", "taskkill.exe"), ["/pid", String(pid), "/T", "/F"], {
							stdio: "ignore",
						});
					}
				} else if (pid !== undefined) {
					process.kill(-pid, "SIGKILL");
				}
			} catch {
				// Already gone.
			}
		}
		this.handleClose(null);
	}
}
