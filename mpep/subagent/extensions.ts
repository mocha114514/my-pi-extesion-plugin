import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

const BUNDLED_PREFIX = "bundled:";
const MPEP_ROOT = fileURLToPath(new URL("../", import.meta.url));
const NATIVE_EXTENSION_SOURCE = /^(?:npm|git|https?|ssh):/;

/** Explicit ./ and ../ paths belong to the dispatching project, not global extensions. */
function isProjectRelative(source: string): boolean {
	return /^\.{1,2}[\\/]/.test(source);
}

/**
 * Resolve an agent-declared extension source.
 *
 * - bundled:<path> resolves from the MPEP package root.
 * - Bare relative paths resolve from Pi's global agent/extensions directory.
 * - Explicit ./ and ../ paths resolve from the dispatching project's cwd.
 * - Absolute paths stay unchanged.
 * - Native npm/git/URL sources pass through for Pi's own package loader.
 */
export function resolveAgentExtension(source: string, cwd: string): string {
	if (NATIVE_EXTENSION_SOURCE.test(source)) return source;

	if (source.startsWith(BUNDLED_PREFIX)) {
		const relativePath = source.slice(BUNDLED_PREFIX.length);
		if (!relativePath || path.isAbsolute(relativePath)) {
			throw new Error(`Invalid bundled extension "${source}": expected a package-relative path.`);
		}
		return path.resolve(MPEP_ROOT, relativePath);
	}

	if (path.isAbsolute(source)) return source;
	if (isProjectRelative(source)) return path.resolve(cwd, source);
	return path.join(getAgentDir(), "extensions", source);
}
