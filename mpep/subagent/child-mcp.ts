/**
 * Child-only MCP bridge. Reuses Pi's transports, exposure modes and lifecycle, but
 * supplies only configured, enabled servers named by the agent's `mcp` frontmatter.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import * as Pi from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { MCP_SERVERS_ENV, readMcpNames, selectMcpServers, type ConfiguredMcpServer } from "./mcp.ts";

interface LoadedMcpConfig {
	servers: ConfiguredMcpServer[];
	errors: string[];
	autoEnableCodemode?: boolean;
	projectConfig?: string;
}

type LoadMcpConfig = (options: {
	agentDir: string;
	cwd: string;
	projectTrusted: boolean;
}) => LoadedMcpConfig;

/** The repository's older type-check dependency predates these host runtime APIs. */
interface McpHost {
	createMcpExtension?: (options: {
		loadConfig: (ctx: ExtensionContext) => LoadedMcpConfig;
		updateConfig: () => void;
	}) => ExtensionFactory;
}

/**
 * Pi exports the MCP factory but not its config loader. Keep this one internal
 * dependency isolated rather than duplicating validation, project overrides and
 * trust handling. Resolve against the host, never the project's older dependency.
 * If an install does not ship the loader, fail closed instead of loading all MCPs.
 */
async function nativeConfigLoader(): Promise<LoadMcpConfig> {
	const root = Pi.getPackageDir();
	const source = [
		join(root, "dist", "extensions", "mcp", "config.js"),
		join(root, "src", "extensions", "mcp", "config.ts"),
	].find((candidate) => existsSync(candidate));
	if (!source) {
		throw new Error("Subagent MCP requires a Pi installation that ships its native MCP config loader.");
	}
	const module = await import(pathToFileURL(source).href) as { loadMcpConfig?: LoadMcpConfig };
	if (typeof module.loadMcpConfig !== "function") {
		throw new Error("This Pi installation does not expose the expected MCP config loader.");
	}
	return module.loadMcpConfig;
}

export default async function (pi: ExtensionAPI): Promise<void> {
	const names = readMcpNames(process.env[MCP_SERVERS_ENV]);
	if (names.length === 0) return;

	const { createMcpExtension } = Pi as unknown as McpHost;
	if (typeof createMcpExtension !== "function") {
		throw new Error("Subagent MCP requires a Pi version with createMcpExtension support.");
	}
	const loadMcpConfig = await nativeConfigLoader();
	const extension = createMcpExtension({
		loadConfig(ctx) {
			const trustedContext = ctx as ExtensionContext & { isProjectTrusted?: () => boolean };
			const loaded = loadMcpConfig({
				agentDir: Pi.getAgentDir(),
				cwd: ctx.cwd,
				projectTrusted: trustedContext.isProjectTrusted?.() === true,
			});
			return { ...loaded, servers: selectMcpServers(loaded.servers, names) };
		},
		// Child-side /mcp actions must not mutate the parent's shared configuration.
		updateConfig() {
			throw new Error("Subagent MCP configuration is read-only; edit Pi's mcp.json outside the subagent.");
		},
	});

	// Only mcp.json entries are eligible. Other child extensions cannot implicitly
	// add servers through registerMcpServer to this restricted MCP bridge.
	await extension({ ...pi, getMcpServers: () => [] } as ExtensionAPI);
}
