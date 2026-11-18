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
	detach?: () => void;
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
		const onceWrappedSet = new Set<(...args: never[]) => void>();
		const addedThisTick = new Set<(...args: never[]) => void>();
		let removedOnceThisTick = false;

		const markOnceCandidates = () => {
			for (const raw of process.rawListeners("SIGINT")) {
				const inner = (raw as { listener?: unknown }).listener;
				if (typeof inner === "function" && !isSignalExitListener(inner as (...args: never[]) => void)) {
					onceWrappedSet.add(inner as (...args: never[]) => void);
				}
			}
		};
		markOnceCandidates();

		let handlerRef: (() => void) | undefined;

		const onNewListener = (event: string | symbol, fn: (...args: never[]) => void) => {
			if (event !== "SIGINT" || fn === handlerRef || isSignalExitListener(fn)) return;
			addedThisTick.add(fn);
			queueMicrotask(() => {
				addedThisTick.delete(fn);
				markOnceCandidates();
			});
		};

		const onRemoveListener = (event: string | symbol, fn: (...args: never[]) => void) => {
			if (event !== "SIGINT") return;
			const wrappedInner = (fn as { listener?: unknown }).listener;
			const actual = typeof wrappedInner === "function"
				? (wrappedInner as (...args: never[]) => void)
				: fn;
			if (actual === handlerRef || isSignalExitListener(actual)) return;
			if (wrappedInner !== undefined || onceWrappedSet.delete(actual) || addedThisTick.delete(actual)) {
				onceWrappedSet.delete(actual);
				addedThisTick.delete(actual);
				removedOnceThisTick = true;
				queueMicrotask(() => {
					removedOnceThisTick = false;
				});
			}
		};

		const detachHooks = () => {
			process.off("newListener", onNewListener);
			process.off("removeListener", onRemoveListener);
		};

		const handler = () => {
			// If an external listener (e.g. host TUI or another extension's once() /
			// prependOnceListener()) owns this SIGINT, keep MPEP state and SIGINT
			// registration intact so we never tear down active workers while the
			// host remains alive.
			const hasExternalHandler =
				removedOnceThisTick ||
				process.listeners("SIGINT").some((fn) => fn !== handler && !isSignalExitListener(fn));
			if (hasExternalHandler) {
				return;
			}
			reg.listener = undefined;
			reg.detach = undefined;
			detachHooks();
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
			process.kill(process.pid, "SIGINT");
		};
		handlerRef = handler;
		reg.listener = handler;
		reg.detach = detachHooks;
		process.on("newListener", onNewListener);
		process.on("removeListener", onRemoveListener);
		// Prepend so MPEP runs before any earlier `process.once("SIGINT", ...)`
		// listener is popped and invoked by Node's EventEmitter.
		process.prependListener("SIGINT", handler);
	}

	return () => {
		reg.callbacks.delete(callback);
		if (reg.callbacks.size === 0 && reg.listener) {
			reg.detach?.();
			reg.detach = undefined;
			process.off("SIGINT", reg.listener);
			reg.listener = undefined;
		}
	};
}
