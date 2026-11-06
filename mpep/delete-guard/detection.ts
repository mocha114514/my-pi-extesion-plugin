import { detectShellDeletion, type ShellDialect } from "./shell.ts";

export interface DeletionIntent {
	toolName: string;
	cwd: string;
	command: string;
	reasons: string[];
}

const filesystemTool = /(?:^|__|[.:/\\])(delete_file|remove_file|delete_directory|remove_directory|unlink|rmdir)$/i;
const shellTool = /(?:^|[^a-z0-9])(?:shell|bash|sh|zsh|pwsh|powershell|cmd|terminal)(?:$|[^a-z0-9])/i;

type Input = Record<string, unknown>;

function dialectFrom(toolName: string): ShellDialect | undefined {
	const parts = toolName.toLowerCase().split(/[^a-z0-9]+/);
	if (parts.some((part) => part === "powershell" || part === "pwsh")) return "powershell";
	if (parts.includes("cmd")) return "cmd";
	if (parts.some((part) => ["bash", "sh", "zsh", "dash", "ksh"].includes(part))) return "posix";
	return undefined;
}

function record(value: unknown): Input | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? value as Input : undefined;
}

/** Only explicit command fields are executable input; content/code/action are not. */
function commandsFrom(toolName: string, input: Input | undefined): string[] {
	if (!input) return [];
	const commands: string[] = [];
	for (const key of ["command", "cmd"]) {
		if (typeof input[key] === "string") commands.push(input[key]);
	}
	if (Array.isArray(input.commands)) {
		for (const item of input.commands) {
			if (typeof item === "string") commands.push(item);
			else {
				const command = record(item)?.command;
				if (typeof command === "string") commands.push(command);
			}
		}
	}
	if (shellTool.test(toolName) && typeof input.script === "string") commands.push(input.script);
	return commands;
}

function requestText(input: unknown): string {
	if (typeof input === "string") return input;
	// Tool inputs are normally JSON. Avoid throwing if a caller supplies a non-JSON value.
	try { return JSON.stringify(input) ?? String(input); }
	catch { return String(input); }
}

/**
 * Inspect literal shell requests or exact filesystem-tool names. In particular, arbitrary
 * JavaScript/codemode source is not traversed: nested runtime tool calls are gated elsewhere.
 * Preserve every command, including harmless ones, so approval describes the whole request.
 */
export function detectDeletion(toolName: string, input: unknown, cwd: string): DeletionIntent | undefined {
	const fields = record(input);
	for (const key of ["cwd", "workdir", "working_directory"]) {
		if (typeof fields?.[key] === "string") {
			cwd = fields[key];
			break;
		}
	}
	const direct = filesystemTool.exec(toolName);
	if (direct) {
		return {
			toolName,
			cwd,
			command: requestText(input),
			reasons: [`Filesystem deletion tool: ${direct[1].toLowerCase()}`],
		};
	}
	const commands = commandsFrom(toolName, fields);
	const dialect = dialectFrom(toolName);
	const reasons = [...new Set(commands.flatMap((command) => detectShellDeletion(command, dialect)))];
	if (!reasons.length) return undefined;
	return { toolName, cwd, command: commands.join("\n"), reasons };
}
