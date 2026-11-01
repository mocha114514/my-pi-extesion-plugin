/** Shared child-MCP policy; this module never reads configuration or starts servers. */
export const MCP_SERVERS_ENV = "MPEP_SUBAGENT_MCP_SERVERS";

/** Match Pi's server-name syntax, not tool patterns or normalized tool namespaces. */
export function normalizeMcpNames(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	const names = value
		.filter((name): name is string => typeof name === "string")
		.map((name) => name.trim())
		.filter((name) => /^[A-Za-z0-9_-]+$/.test(name));
	return [...new Set(names)];
}

/** Names alone cross the process boundary; commands and credentials stay in Pi's config. */
export function readMcpNames(value: string | undefined): string[] {
	try {
		return normalizeMcpNames(JSON.parse(value ?? "[]"));
	} catch {
		return [];
	}
}

/** Minimal structural type: native loading retains every transport/exposure option. */
export interface ConfiguredMcpServer {
	name: string;
	config: { enabled?: boolean };
}

/** Filter before connecting, so unselected or disabled servers are never started. */
export function selectMcpServers<T extends ConfiguredMcpServer>(servers: T[], names: readonly string[]): T[] {
	const wanted = new Set(names);
	return servers.filter((entry) => wanted.has(entry.name) && entry.config.enabled !== false);
}

/** Keep discovery, resources and direct MCP tools usable with a role's built-in tool allowlist. */
export function mcpToolNames(names: readonly string[]): string[] {
	if (names.length === 0) return [];
	return [
		"tool_search",
		"codemode",
		"list_mcp_resources",
		"list_mcp_resource_templates",
		"read_mcp_resource",
		...names.map((name) => `mcp__${name.replace(/-/g, "_")}__*`),
	];
}
