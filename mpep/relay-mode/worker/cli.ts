/**
 * Pi runtime capability detection, catalog model resolution, and CLI flag
 * inheritance for spawning the symbiotic relay worker process.
 */

import * as fs from "node:fs";
import { homedir } from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { isPluginEnabled } from "../../manager/preferences.ts";
import { getPiInvocation } from "../rpc-client.ts";
import {
	isSamePath,
	normalizeWindowsShellPath,
	THINKING_SUFFIXES,
	type ModelDescriptor,
} from "./types.ts";

export interface PiRuntimeCapabilities {
	hasSettleCredentialWrites: boolean;
	runsBeforeAgentStartOnCustomWakeup: boolean;
	supportsBuiltinResourcePrefix: boolean;
}

function findPiCoreFile(entryPath: string, fileName: string): string | undefined {
	let dir = path.dirname(entryPath);
	for (let depth = 0; depth < 5; depth++) {
		const candidates = [
			path.join(dir, "dist", "core", fileName),
			path.join(dir, "core", fileName),
		];
		for (const candidate of candidates) {
			if (fs.existsSync(candidate)) return candidate;
		}
		const parent = path.dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return undefined;
}

/**
 * Inspect the resolved Pi distribution (supporting both `dist/bundle/cli.js`
 * and `dist/cli.js` layouts) so relay-mode adapts cleanly to Pi 0.85.1 vs 1.5.2.
 */
export function detectPiRuntimeCapabilities(): PiRuntimeCapabilities {
	try {
		const invocation = getPiInvocation([]);
		const entry = invocation.args[0];
		if (!entry || !fs.existsSync(entry)) {
			return {
				hasSettleCredentialWrites: true,
				runsBeforeAgentStartOnCustomWakeup: true,
				supportsBuiltinResourcePrefix: true,
			};
		}
		const realEntry = fs.realpathSync.native?.(entry) ?? fs.realpathSync(entry);
		const runtimePath = findPiCoreFile(realEntry, "agent-session-runtime.js");
		const sessionPath = findPiCoreFile(realEntry, "agent-session.js");
		const hasSettleCredentialWrites = runtimePath
			? fs.readFileSync(runtimePath, "utf-8").includes("settleCredentialWrites")
			: true;
		const runsBeforeAgentStartOnCustomWakeup = sessionPath
			? fs.readFileSync(sessionPath, "utf-8").includes('messageType: "custom"')
			: true;
		// Pi 1.5.2 introduced `builtin:` in `isLocalPath`; Pi 0.85.1 does not treat it as non-local.
		return {
			hasSettleCredentialWrites,
			runsBeforeAgentStartOnCustomWakeup,
			supportsBuiltinResourcePrefix: hasSettleCredentialWrites,
		};
	} catch {
		return {
			hasSettleCredentialWrites: true,
			runsBeforeAgentStartOnCustomWakeup: true,
			supportsBuiltinResourcePrefix: true,
		};
	}
}

export function splitThinkingSuffix(spec: string): { base: string; suffix?: string } {
	const idx = spec.lastIndexOf(":");
	if (idx === -1) return { base: spec.trim() };
	const suffix = spec.slice(idx + 1).trim();
	if (THINKING_SUFFIXES.has(suffix)) {
		return { base: spec.slice(0, idx).trim(), suffix };
	}
	return { base: spec.trim() };
}

/**
 * Resolve `spec` strictly to an exact catalog entry (`provider/id` or unique `id`)
 * and format `modelArg` as `<provider>/<id>[:thinking]` so BOTH Pi 0.85.1
 * (which strips `<provider>/` once when `--provider` is also passed) and Pi 1.5.2
 * resolve the exact model even when `id` itself contains `/` (e.g. `openrouter/free`).
 */
function resolveExactCatalogTarget(
	spec: string,
	explicitProvider: string | undefined,
	availableModels: readonly ModelDescriptor[],
): { provider: string; modelArg: string } | undefined {
	const trimmed = spec.trim();
	if (!trimmed || availableModels.length === 0) return undefined;
	const { base, suffix } = splitThinkingSuffix(trimmed);
	if (!base) return undefined;
	const baseLower = base.toLowerCase();
	const formatPinned = (m: ModelDescriptor) => `${m.provider}/${m.id}${suffix ? `:${suffix}` : ""}`;

	if (explicitProvider) {
		const provLower = explicitProvider.trim().toLowerCase();
		const scoped = availableModels.filter((m) => m.provider.toLowerCase() === provLower);
		const exact = scoped.find(
			(m) => m.id.toLowerCase() === baseLower || `${m.provider}/${m.id}`.toLowerCase() === baseLower,
		);
		return exact ? { provider: exact.provider, modelArg: formatPinned(exact) } : undefined;
	}

	const fullMatches = availableModels.filter((m) => `${m.provider}/${m.id}`.toLowerCase() === baseLower);
	const exactIdMatches = availableModels.filter((m) => m.id.toLowerCase() === baseLower);
	if (fullMatches.length === 1 && fullMatches[0]) {
		// Mirror Pi 0.85.1 auth-aware slash-ID resolution: if `provider/id` matches an
		// unauthenticated provider while `exactIdMatches` has a single authenticated
		// match (e.g. OpenRouter's `xiaomi/mimo-v2.5-pro`), Pi selects the latter.
		if (fullMatches[0].authenticated === false) {
			const authRawMatches = exactIdMatches.filter(
				(m) => m.authenticated === true && `${m.provider}/${m.id}`.toLowerCase() !== baseLower,
			);
			if (authRawMatches.length === 1 && authRawMatches[0]) {
				return { provider: authRawMatches[0].provider, modelArg: formatPinned(authRawMatches[0]) };
			}
		}
		return { provider: fullMatches[0].provider, modelArg: formatPinned(fullMatches[0]) };
	}

	if (exactIdMatches.length === 1 && exactIdMatches[0]) {
		return { provider: exactIdMatches[0].provider, modelArg: formatPinned(exactIdMatches[0]) };
	}
	if (exactIdMatches.length > 1) {
		const authMatches = exactIdMatches.filter((m) => m.authenticated === true);
		if (authMatches.length === 1 && authMatches[0]) {
			return { provider: authMatches[0].provider, modelArg: formatPinned(authMatches[0]) };
		}
	}
	return undefined;
}

function isCliLocalResourcePath(value: string, supportsBuiltinPrefix: boolean): boolean {
	// Mirror Pi's `isLocalPath` (`utils/paths.ts`, case-sensitive scheme prefixes).
	const trimmed = value.trim();
	if (
		trimmed.startsWith("npm:") ||
		trimmed.startsWith("git:") ||
		trimmed.startsWith("github:") ||
		trimmed.startsWith("http:") ||
		trimmed.startsWith("https:") ||
		trimmed.startsWith("ssh:") ||
		(supportsBuiltinPrefix && trimmed.startsWith("builtin:"))
	) {
		return false;
	}
	return true;
}

function resolveCliExtensionSource(
	source: string,
	launchCwd: string,
	supportsBuiltinPrefix = detectPiRuntimeCapabilities().supportsBuiltinResourcePrefix,
): string {
	// Mirror Pi's `resolveCliPaths` -> `resolvePath(value, cwd)` in `main.ts`
	// (no Unicode-space normalization, case-sensitive `file://` and package
	// prefixes, and child-side resource loaders keep their own normalization).
	if (!isCliLocalResourcePath(source, supportsBuiltinPrefix)) return source;
	const normalized = normalizeWindowsShellPath(source);
	const home = homedir();
	if (normalized === "~") return home;
	if (normalized.startsWith("~/") || (process.platform === "win32" && normalized.startsWith("~\\"))) {
		return path.join(home, normalized.slice(2));
	}
	if (/^file:\/\//.test(normalized)) {
		try {
			return fileURLToPath(normalized);
		} catch {
			return source;
		}
	}
	return path.isAbsolute(normalized) ? path.resolve(normalized) : path.resolve(launchCwd, normalized);
}

/**
 * Forward relevant foreground CLI security, tool, extension, MCP, discovery,
 * extension-registered flags, and verified provider-bound inline auth flags
 * while honoring `--` and skipping Pi startup-only flags cleanly.
 */
export function buildInheritedCliArgs(
	launchCwd: string,
	projectTrusted: boolean | undefined,
	configModel: string | undefined,
	inheritProvider: string | undefined,
	inheritModelId: string | undefined,
	availableModels: readonly ModelDescriptor[],
	verifiedApiKeyProvider?: string,
): {
	args: string[];
	trailingFlags: string[];
	modelPinnedByArgs: boolean;
	apiKeyCandidate?: { provider: string; apiKey: string };
} {
	const argv = process.argv.slice(2);
	const args: string[] = [];
	const trailingFlags: string[] = [];
	let cliTrust: "--approve" | "--no-approve" | undefined;
	let noExtensions = false;
	const extensions: string[] = [];
	let apiKey: string | undefined;
	let cliProvider: string | undefined;
	let cliModelArg: string | undefined;
	let cliModelsArg: string[] | undefined;

	const BUILTIN_NO_ARG_FLAGS = new Set([
		"--help",
		"-h",
		"--version",
		"-v",
		"--no-session",
		"--continue",
		"-c",
		"--resume",
		"-r",
	]);

	const BUILTIN_VALUE_SKIP_FLAGS = new Set([
		"--mode",
		"--system-prompt",
		"--append-system-prompt",
		"--name",
		"-n",
		"--session",
		"--session-id",
		"--fork",
		"--session-dir",
		"--thinking",
		"--export",
		"--theme",
		"--use-theme",
		"--tui-mode",
	]);

	// Built-in value-taking long flags that fall through to Pi's `unknownFlags`
	// ONLY when they appear bare at the very end of `argv`. Keep them in
	// `trailingFlags` so appended worker flags (`--model`, `--thinking`, `-e`)
	// never get consumed as their value.
	const BUILTIN_VALUE_LONG_FLAGS = new Set([
		"--tools",
		"--exclude-tools",
		"--extension",
		"--skill",
		"--prompt-template",
		"--api-key",
		"--provider",
		"--model",
		"--models",
		"--mode",
		"--system-prompt",
		"--append-system-prompt",
		"--name",
		"--session",
		"--session-id",
		"--fork",
		"--session-dir",
		"--thinking",
		"--export",
		"--theme",
		"--use-theme",
		"--tui-mode",
	]);

	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i]!;
		if (arg === "--") break;
		if (arg === "--approve" || arg === "-a") {
			cliTrust = "--approve";
		} else if (arg === "--no-approve" || arg === "-na") {
			cliTrust = "--no-approve";
		} else if (arg === "--no-extensions" || arg === "-ne") {
			noExtensions = true;
		} else if (arg === "--no-tools" || arg === "-nt") {
			args.push("--no-tools");
		} else if (arg === "--no-builtin-tools" || arg === "-nbt") {
			args.push("--no-builtin-tools");
		} else if (arg === "--no-mcp") {
			args.push("--no-mcp");
		} else if (arg === "--no-skills" || arg === "-ns") {
			args.push("--no-skills");
		} else if (arg === "--no-prompt-templates" || arg === "-np") {
			args.push("--no-prompt-templates");
		} else if (arg === "--no-themes") {
			args.push("--no-themes");
		} else if (arg === "--no-context-files" || arg === "-nc") {
			args.push("--no-context-files");
		} else if (arg === "--offline" || arg === "--verbose") {
			args.push(arg);
		} else if ((arg === "--tools" || arg === "-t") && i + 1 < argv.length) {
			args.push("--tools", argv[++i]!);
		} else if ((arg === "--exclude-tools" || arg === "-xt") && i + 1 < argv.length) {
			args.push("--exclude-tools", argv[++i]!);
		} else if ((arg === "--extension" || arg === "-e") && i + 1 < argv.length) {
			const value = argv[++i];
			if (value) extensions.push(resolveCliExtensionSource(value, launchCwd));
		} else if (arg === "--skill" && i + 1 < argv.length) {
			const value = argv[++i];
			if (value) args.push("--skill", resolveCliExtensionSource(value, launchCwd));
		} else if (arg === "--prompt-template" && i + 1 < argv.length) {
			const value = argv[++i];
			if (value) args.push("--prompt-template", resolveCliExtensionSource(value, launchCwd));
		} else if (arg === "--api-key") {
			// Pi parses ONLY `--api-key <value>` (never `--api-key=value`) as its built-in
			// credential; `--api-key=...` belongs to extension-registered flags below.
			if (i + 1 < argv.length) {
				apiKey = argv[++i];
			}
		} else if (arg === "--provider" && i + 1 < argv.length) {
			const value = argv[++i];
			if (value) cliProvider = value;
		} else if (arg === "--model" && i + 1 < argv.length) {
			const value = argv[++i];
			if (value) cliModelArg = value;
		} else if (arg === "--models" && i + 1 < argv.length) {
			const value = argv[++i];
			if (value) {
				cliModelsArg = value.split(",").map((s) => s.trim()).filter(Boolean);
			}
		} else if (arg === "--print" || arg === "-p" || arg === "--list-models") {
			const next = argv[i + 1];
			if (next !== undefined && !next.startsWith("@") && (!next.startsWith("-") || next.startsWith("---"))) {
				i++;
			}
		} else if (BUILTIN_NO_ARG_FLAGS.has(arg)) {
			continue;
		} else if (BUILTIN_VALUE_SKIP_FLAGS.has(arg)) {
			if (i + 1 < argv.length) {
				i++;
			} else if (arg.startsWith("--") && BUILTIN_VALUE_LONG_FLAGS.has(arg)) {
				trailingFlags.push(arg);
			}
		} else if (arg.startsWith("--")) {
			// Forward extension-registered flags (including `--extension=...`, `--skill=...`,
			// `--ssh`, `--plan`) identically to Pi's parseArgs.
			if (arg.includes("=")) {
				args.push(arg);
			} else if (BUILTIN_VALUE_LONG_FLAGS.has(arg) && i === argv.length - 1) {
				trailingFlags.push(arg);
			} else {
				args.push(arg);
				const next = argv[i + 1];
				if (next !== undefined && !next.startsWith("-") && !next.startsWith("@")) {
					args.push(next);
					i++;
				}
			}
		}
	}

	// Only forward a process-wide `--approve` when the user explicitly passed
	// `--approve`/`-a` on the foreground CLI (and the worker cwd is trusted).
	// Interactive session-only trust for the foreground cwd is scoped via
	// `MPEP_RELAY_TRUSTED_CWD` + `project_trust` hook so switching sessions into
	// an untrusted project inside the worker still honors its trust decision.
	if (projectTrusted === false) args.push("--no-approve");
	else if (cliTrust) args.push(cliTrust);

	if (noExtensions) args.push("--no-extensions");
	for (const ext of extensions) {
		args.push("-e", ext);
	}

	// Whenever CLI extension flags override default discovery, explicitly ensure
	// delete-guard, turn-notify, and relay-mode's worker helper load cleanly.
	// Also explicitly load relay-mode's worker helper whenever scoped interactive
	// trust (`projectTrusted === true` without `--approve`) is needed, so even
	// project-local MPEP installations participate in Pi's pre-trust bootstrap.
	const mpepRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
	const rmEntry = path.join(mpepRoot, "relay-mode", "index.ts");
	const rmDir = path.join(mpepRoot, "relay-mode");
	const needsExplicitRelayHelper =
		noExtensions ||
		extensions.length > 0 ||
		(projectTrusted === true && !args.includes("--approve"));

	if (noExtensions || extensions.length > 0) {
		if (isPluginEnabled("delete-guard")) {
			const dgEntry = path.join(mpepRoot, "delete-guard", "index.ts");
			const dgDir = path.join(mpepRoot, "delete-guard");
			if (!extensions.some((ext) => path.isAbsolute(ext) && (isSamePath(ext, dgEntry) || isSamePath(ext, dgDir)))) {
				args.push("-e", dgEntry);
			}
		}
		if (isPluginEnabled("turn-notify")) {
			const tnEntry = path.join(mpepRoot, "turn-notify", "index.ts");
			const tnDir = path.join(mpepRoot, "turn-notify");
			if (!extensions.some((ext) => path.isAbsolute(ext) && (isSamePath(ext, tnEntry) || isSamePath(ext, tnDir)))) {
				args.push("-e", tnEntry);
			}
		}
	}
	if (needsExplicitRelayHelper) {
		if (!extensions.some((ext) => path.isAbsolute(ext) && (isSamePath(ext, rmEntry) || isSamePath(ext, rmDir)))) {
			args.push("-e", rmEntry);
		}
	}

	let modelPinnedByArgs = false;
	let apiKeyCandidate: { provider: string; apiKey: string } | undefined;

	// Resolve the worker's exact target provider/model from catalog entries, or
	// preserve the foreground's already-resolved noncatalog provider/id when
	// inheriting `ctx.model` (never guessing fuzzy relay-mode.md strings).
	const workerTarget = configModel
		? resolveExactCatalogTarget(configModel, undefined, availableModels)
		: inheritProvider && inheritModelId
			? (resolveExactCatalogTarget(`${inheritProvider}/${inheritModelId}`, inheritProvider, availableModels) ?? {
				provider: inheritProvider,
				modelArg: `${inheritProvider}/${inheritModelId}`,
			})
			: undefined;

	if (apiKey && workerTarget) {
		// Respect explicit `--provider`, and let runtime credential verification
		// (`getProviderAuthStatus(provider).source === "runtime"`) confirm whether Pi
		// actually bound `--api-key` to this provider (supporting CLI flags,
		// settings.enabledModels, and default model selection alike).
		const cliProviderOk = !cliProvider || cliProvider.toLowerCase() === workerTarget.provider.toLowerCase();

		if (cliProviderOk) {
			apiKeyCandidate = { provider: workerTarget.provider, apiKey };
			if (
				verifiedApiKeyProvider &&
				verifiedApiKeyProvider.toLowerCase() === workerTarget.provider.toLowerCase()
			) {
				args.push("--api-key", apiKey, "--provider", workerTarget.provider, "--model", workerTarget.modelArg);
				modelPinnedByArgs = true;
			}
		}
	}

	return { args, trailingFlags, modelPinnedByArgs, apiKeyCandidate };
}
