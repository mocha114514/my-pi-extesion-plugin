/**
 * Shared SIGINT cleanup coordinator for MPEP extensions.
 *
 * Node terminates immediately on SIGINT without running `exit` listeners, and
 * multiple extensions registering independent SIGINT handlers that re-raise
 * SIGINT would race before sibling cleanups finish. Also accounts for
 * `signal-exit` (used by `proper-lockfile`), which only forwards SIGINT when no
 * other listeners remain.
 */

const REGISTRY_SLOT = Symbol.for("mpep.shared.sigintRegistry.v1");

interface SigintRegistry {
	callbacks: Set<() => void>;
	listener?: () => void;
}

function getRegistry(): SigintRegistry {
	const g = globalThis as unknown as Record<symbol, SigintRegistry | undefined>;
	let reg = g[REGISTRY_SLOT];
	if (!reg) {
		reg = { callbacks: new Set() };
		g[REGISTRY_SLOT] = reg;
	}
	return reg;
}

function isSignalExitListener(fn: (...args: never[]) => void): boolean {
	try {
		return fn.toString().includes("emitter.count");
	} catch {
		return false;
	}
}

export function registerSigintCleanup(callback: () => void): () => void {
	const reg = getRegistry();
	reg.callbacks.add(callback);

	if (!reg.listener) {
		const handler = () => {
			reg.listener = undefined;
			process.off("SIGINT", handler);
			const snapshot = [...reg.callbacks];
			reg.callbacks.clear();
			for (const cb of snapshot) {
				try {
					cb();
				} catch {
					// Cleanup must not prevent sibling handlers or signal re-raise.
				}
			}
			const hasExternalHandler = process.listeners("SIGINT").some((fn) => !isSignalExitListener(fn));
			if (!hasExternalHandler) {
				process.kill(process.pid, "SIGINT");
			}
		};
		reg.listener = handler;
		process.on("SIGINT", handler);
	}

	return () => {
		reg.callbacks.delete(callback);
		if (reg.callbacks.size === 0 && reg.listener) {
			process.off("SIGINT", reg.listener);
			reg.listener = undefined;
		}
	};
}
