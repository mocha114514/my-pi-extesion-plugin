/** Bounded, read-only Git plumbing shared by the on-demand preview readers. */
import { execFile } from "node:child_process";
import { isAbsolute, relative, resolve, sep } from "node:path";

export const GIT_PREVIEW_MAX_BYTES = 16 * 1024 * 1024;

/** Close stdin even when empty so Git never waits for interactive input. */
export function runGit(root: string, args: string[], input?: Buffer, differencesAllowed = false): Promise<Buffer> {
	return new Promise((resolveOutput, reject) => {
		const child = execFile("git", ["--no-optional-locks", ...args], {
			cwd: root,
			encoding: "buffer",
			maxBuffer: GIT_PREVIEW_MAX_BYTES,
			timeout: 15_000,
			windowsHide: true,
			// Partial clones must report missing local objects, not fetch and write them.
			env: { ...process.env, GIT_NO_LAZY_FETCH: "1", GIT_TERMINAL_PROMPT: "0" },
		}, (error, stdout) => {
			if (error && !(differencesAllowed && error.code === 1)) reject(error);
			else resolveOutput(stdout);
		});
		child.stdin?.on("error", () => {});
		child.stdin?.end(input);
	});
}

/** Validate Git paths before any filesystem access; never resolve above root. */
export function resolveGitPath(root: string, path: string): string | undefined {
	if (!path || path.includes("\0") || isAbsolute(path)) return undefined;
	const target = resolve(root, path);
	const suffix = relative(root, target);
	if (!suffix || suffix === ".." || suffix.startsWith(".." + sep) || isAbsolute(suffix)) {
		return undefined;
	}
	return target;
}
