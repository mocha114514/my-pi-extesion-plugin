/**
 * Public exports for the relay-mode worker subsystem.
 */

export {
	isSamePath,
	RELAY_COMPACT_PREFIX,
	RELAY_TRUSTED_CWD_ENV,
	RELAY_WORKER_ENV,
	type ModelDescriptor,
	type PendingWorkerApproval,
	type RelayWorkerHooks,
	type WorkerActivityItem,
	type WorkerMeta,
	type WorkerSnapshot,
	type WorkerStatus,
} from "./types.ts";
export {
	buildInheritedCliArgs,
	detectPiRuntimeCapabilities,
	type PiRuntimeCapabilities,
} from "./cli.ts";
export { recoverStaleRebaseBackups } from "./session-files.ts";
export { cleanupPreservedEphemeralWorkerDir } from "./disposal.ts";
export { RelayWorkerManager } from "./manager.ts";
