export type ShellDialect = "posix" | "powershell" | "cmd";
type Token = { value: string; operator?: boolean };
type HereDoc = { delimiter: string; expand: boolean; tabs: boolean };

const deletionCommands = new Set([
	"rm", "rmdir", "unlink", "remove-item", "ri", "del", "erase", "rd",
]);
const shellCommands = new Set(["bash", "sh", "zsh", "dash", "ksh"]);
const sudoValues = new Set([
	"-u", "-g", "-h", "-p", "-C", "-T", "-R", "-D", "-U",
	"--user", "--group", "--host", "--prompt", "--chdir", "--chroot",
]);
const envValues = new Set(["-u", "-C", "--unset", "--chdir", "-S", "--split-string"]);
const xargsValues = new Set([
	"-I", "-i", "-n", "-P", "-d", "-s", "-L", "-l", "-E", "-e", "-a",
	"--replace", "--max-args", "--max-procs", "--delimiter", "--max-chars",
	"--max-lines", "--eof", "--arg-file", "--process-slot-var",
]);
const gitValues = new Set([
	"-C", "-c", "--git-dir", "--work-tree", "--namespace", "--super-prefix", "--config-env",
]);
const powershellValues = new Set([
	"-path", "-literalpath", "-lp", "-filter", "-include", "-exclude", "-credential",
	"-erroraction", "-warningaction", "-informationaction", "-progressaction",
	"-errorvariable", "-warningvariable", "-informationvariable",
	"-outvariable", "-outbuffer", "-pipelinevariable",
]);
const findValues = new Set([
	"-name", "-iname", "-path", "-ipath", "-wholename", "-iwholename", "-regex", "-iregex",
	"-type", "-xtype", "-size", "-user", "-group", "-uid", "-gid", "-perm", "-links", "-inum",
	"-mtime", "-mmin", "-atime", "-amin", "-ctime", "-cmin", "-newer", "-anewer", "-cnewer",
	"-samefile", "-fstype", "-maxdepth", "-mindepth", "-printf", "-fprint", "-fprint0", "-ls-file",
	"-D", "-O", "-regextype",
]);

function executable(value: string): string {
	return value.replace(/^@/, "").replaceAll("\\", "/").split("/").pop()!
		.replace(/\.(?:exe|cmd|bat|com)$/i, "").toLowerCase();
}

function options(args: string[]): string[] {
	const end = args.indexOf("--");
	return end < 0 ? args : args.slice(0, end);
}

function helpOnly(args: string[]): boolean {
	return options(args).some((arg) => /^(?:--help|--version|-help|-h|-\?|\/\?)$/i.test(arg));
}

/** Keep PowerShell parameter values out of flag checks; aliases may also be CMD/POSIX commands. */
function deletionReadOnly(name: string, args: string[]): boolean {
	if (name === "remove-item" || name === "ri") {
		for (let i = 0; i < args.length; i++) {
			const arg = args[i].toLowerCase();
			if (arg === "--") break;
			const colon = arg.indexOf(":");
			if (powershellValues.has(colon < 0 ? arg : arg.slice(0, colon))) {
				if (colon < 0) i++;
				continue;
			}
			if (arg === "-?" || /^-whatif(?::(?:\$?true|1))?$/.test(arg)) return true;
		}
		return false;
	}
	// Do not interpret PowerShell WhatIf (or GNU help) as a CMD filename bypass.
	if (name === "del" || name === "erase" || name === "rd") return args.includes("/?");
	return options(args).some((arg) => arg === "--help" || arg === "--version");
}

/** Each nested shell selects its own quoting rules; Windows backslashes are not PS escapes. */
function escapes(text: string, i: number, dialect: ShellDialect, quote: string): boolean {
	if (i + 1 >= text.length) return false;
	if (dialect === "powershell") return text[i] === "`";
	if (dialect === "cmd") return text[i] === "^" && !quote;
	return text[i] === "\\" && (quote !== '"' || /[$`"\\\n]/.test(text[i + 1]));
}

function backtickEnd(text: string, start: number): number {
	for (let i = start; i < text.length; i++) {
		if (text[i] === "\\") i++;
		else if (text[i] === "`") return i;
	}
	return -1;
}

/** Locate a literal command-substitution boundary without evaluating anything. */
function substitutionEnd(text: string, start: number, dialect: ShellDialect): number {
	let depth = 1;
	let quote = "";
	for (let i = start; i < text.length; i++) {
		const ch = text[i];
		if (quote === "'") {
			if (ch === "'") {
				if (dialect === "powershell" && text[i + 1] === "'") i++;
				else quote = "";
			}
			continue;
		}
		if (escapes(text, i, dialect, quote)) { i++; continue; }
		if (dialect === "posix" && ch === "`") {
			const end = backtickEnd(text, i + 1);
			if (end < 0) return -1;
			i = end;
			continue;
		}
		if (ch === '"') { quote = quote ? "" : '"'; continue; }
		if (!quote && ch === "'") { quote = "'"; continue; }
		if (ch === "$" && text[i + 1] === "(") {
			const end = substitutionEnd(text, i + 2, dialect);
			if (end < 0) return -1;
			i = end;
			continue;
		}
		if (quote) continue;
		if (ch === "#" && (i === start || /\s/.test(text[i - 1]))) {
			while (i < text.length && text[i] !== "\n") i++;
		}
		if (ch === "(") depth++;
		if (ch === ")" && --depth === 0) return i;
	}
	return -1;
}

function expansionEnd(text: string, i: number, dialect: ShellDialect, nested: (body: string) => void): number {
	if (dialect === "cmd") return -1;
	if (text[i] === "$" && text[i + 1] === "(") {
		const end = substitutionEnd(text, i + 2, dialect);
		if (end >= 0) {
			const body = text.slice(i + 2, end);
			// Arithmetic contains expressions, not command words, but may contain substitutions.
			if (dialect === "posix" && text[i + 2] === "(") scanExpansions(body, nested);
			else nested(body);
		}
		return end;
	}
	if (dialect === "posix" && text[i] === "`") {
		const end = backtickEnd(text, i + 1);
		if (end >= 0) nested(text.slice(i + 1, end));
		return end;
	}
	return -1;
}

/** Unquoted here-docs expand substitutions even inside literal quote characters. */
function scanExpansions(text: string, nested: (body: string) => void): void {
	for (let i = 0; i < text.length; i++) {
		if (text[i] === "\\" && /[$`\\\n]/.test(text[i + 1] ?? "")) { i++; continue; }
		const end = expansionEnd(text, i, "posix", nested);
		if (end >= 0) i = end;
	}
}

/** Consume queued bodies in redirection order; their prose must never enter the word lexer. */
function hereDocEnd(text: string, start: number, documents: HereDoc[], nested: (body: string) => void): number {
	let cursor = start;
	for (const document of documents) {
		const bodyStart = cursor;
		let bodyEnd = text.length;
		while (cursor < text.length) {
			const newline = text.indexOf("\n", cursor);
			const end = newline < 0 ? text.length : newline;
			let line = text.slice(cursor, end).replace(/\r$/, "");
			if (document.tabs) line = line.replace(/^\t+/, "");
			const next = newline < 0 ? text.length : newline + 1;
			if (line === document.delimiter) {
				bodyEnd = cursor;
				cursor = next;
				break;
			}
			cursor = next;
		}
		if (document.expand) scanExpansions(text.slice(bodyStart, bodyEnd), nested);
	}
	return cursor;
}

/** Quotes protect arguments; here-doc bodies are consumed before ordinary tokenization resumes. */
function lex(text: string, dialect: ShellDialect, nested: (body: string) => void): Token[] {
	const tokens: Token[] = [];
	const documents: HereDoc[] = [];
	let delimiter: { tabs: boolean } | undefined;
	let word = "";
	let active = false;
	let quoted = false;
	let quote = "";
	const flush = () => {
		if (active) {
			tokens.push({ value: word });
			if (delimiter) {
				documents.push({ delimiter: word, expand: !quoted, tabs: delimiter.tabs });
				delimiter = undefined;
			}
		}
		word = "";
		active = false;
		quoted = false;
	};
	for (let i = 0; i < text.length; i++) {
		const ch = text[i];
		if (quote === "'") {
			if (ch === "'") {
				if (dialect === "powershell" && text[i + 1] === "'") { word += "'"; i++; }
				else quote = "";
			} else word += ch;
			continue;
		}
		if (escapes(text, i, dialect, quote)) {
			quoted = true;
			if (text[i + 1] !== "\n") { word += text[i + 1]; active = true; }
			i++;
			continue;
		}
		if (!delimiter) {
			const end = expansionEnd(text, i, dialect, nested);
			if (end >= 0) {
				word += text.slice(i, end + 1);
				active = true;
				i = end;
				continue;
			}
		}
		if (dialect === "powershell" && ch === "$" && text[i + 1] === "{") {
			// Braced variable names are not scriptblocks.
			const end = text.indexOf("}", i + 2);
			if (end >= 0) {
				word += text.slice(i, end + 1);
				active = true;
				i = end;
				continue;
			}
		}
		if (quote === '"') {
			if (ch === '"') quote = "";
			else word += ch;
			continue;
		}
		if (ch === '"' || (ch === "'" && dialect !== "cmd")) {
			quote = ch;
			active = true;
			quoted = true;
			continue;
		}
		if (dialect !== "cmd" && ch === "#" && !active) {
			const newline = text.indexOf("\n", i);
			i = newline < 0 ? text.length : newline - 1;
			continue;
		}
		if (dialect === "powershell" && ch === "<" && text[i + 1] === "#") {
			const end = text.indexOf("#>", i + 2);
			i = end < 0 ? text.length : end + 1;
			continue;
		}
		const brace = "{}".includes(ch) && (dialect === "powershell"
			|| (dialect === "posix" && !active && /[\s;)]|^$/.test(text[i + 1] ?? "")));
		if (ch === "\n" || (dialect === "cmd" ? "&|()<>" : ";&|()<>").includes(ch) || brace) {
			flush();
			let value = ch;
			if (";&|<>".includes(ch) && text[i + 1] === ch) value += text[++i];
			else if (("<>".includes(ch) && text[i + 1] === "&") || (ch === "&" && text[i + 1] === ">")) {
				value += text[++i];
			}
			if (dialect === "posix" && value === "<<") {
				if (text[i + 1] === "<") value += text[++i]; // Here-string, not a here-doc.
				else {
					const tabs = text[i + 1] === "-";
					if (tabs) value += text[++i];
					delimiter = { tabs };
				}
			}
			tokens.push({ value, operator: true });
			if (ch === "\n" && documents.length) {
				i = hereDocEnd(text, i + 1, documents, nested) - 1;
				documents.length = 0;
			}
		} else if (/\s/.test(ch)) flush();
		else { word += ch; active = true; }
	}
	flush();
	return tokens;
}

/** Only literal CMD IF [NOT] EXIST conditions are peeled; other conditions stay opaque. */
function cmdBody(initial: string[]): string[] | undefined {
	let words = initial;
	while (/^@?if$/i.test(words[0] ?? "")) {
		let index = 1;
		if (/^\/i$/i.test(words[index] ?? "")) index++;
		if (/^not$/i.test(words[index] ?? "")) index++;
		if (!/^exist$/i.test(words[index] ?? "") || words[index + 1] === undefined) return undefined;
		words = words.slice(index + 2);
	}
	return words;
}

/** Skip only known wrapper options; never search arbitrary arguments for command names. */
function afterOptions(args: string[], valued: Set<string>): {
	rest: string[];
	flags: { name: string; value?: string }[];
} {
	let i = 0;
	const flags: { name: string; value?: string }[] = [];
	while (i < args.length && args[i].startsWith("-")) {
		const name = args[i++];
		if (name === "--") break;
		flags.push({ name, value: valued.has(name) ? args[i++] : undefined });
	}
	return { rest: args.slice(i), flags };
}

/**
 * Deterministic recognition of common literal shell deletion forms, not a shell interpreter
 * or sandbox. Dynamic command construction, aliases/functions, external scripts and full
 * shell/PowerShell/CMD grammars are intentionally outside this scanner's scope.
 */
export function detectShellDeletion(command: string, dialect?: ShellDialect): string[] {
	const reasons = new Set<string>();
	const add = (name: string) => { reasons.add(`Shell filesystem deletion: ${name}`); };
	const scan = (text: string, mode: ShellDialect): void => {
		let words: string[] = [];
		let redirect = false;
		let echoParens = 0;
		for (const token of lex(text, mode, (body) => scan(body, mode))) {
			if (token.operator) {
				// CMD echo arguments may contain literal parentheses, including after IF EXIST.
				if (mode === "cmd" && token.value === "(" && executable(cmdBody(words)?.[0] ?? "") === "echo") {
					echoParens++;
					words.push(token.value);
					continue;
				}
				if (mode === "cmd" && token.value === ")" && echoParens > 0) {
					echoParens--;
					words.push(token.value);
					continue;
				}
				if (/^(?:[<>]|&>)/.test(token.value)) {
					if (/^\d+$/.test(words.at(-1) ?? "")) words.pop();
					redirect = true;
				} else {
					inspect(words, mode);
					words = [];
					redirect = false;
					echoParens = 0;
				}
			} else if (redirect) redirect = false;
			else words.push(token.value);
		}
		inspect(words, mode);
	};
	const inspect = (initial: string[], mode: ShellDialect): void => {
		let words = mode === "cmd" ? cmdBody(initial) ?? [] : initial;
		while (words.length) {
			if (/^[A-Za-z_]\w*\+?=/.test(words[0]) || /^(?:!|if|then|elif|else|do|while|until)$/.test(words[0])) {
				words = words.slice(1);
				continue;
			}
			const name = executable(words[0]);
			const args = words.slice(1);
			if (name === "sudo" || name === "nohup" || name === "env" || name === "command" || name === "exec" || name === "xargs") {
				const valued = name === "sudo" ? sudoValues : name === "env" ? envValues
					: name === "xargs" ? xargsValues : new Set(name === "exec" ? ["-a"] : []);
				const parsed = afterOptions(args, valued);
				if (parsed.flags.some((flag) => flag.name === "--help" || flag.name === "--version")) return;
				if (name === "command" && parsed.flags.some((flag) => /^-[p]*[vV]/.test(flag.name))) return;
				if (name === "env") {
					const split = parsed.flags.find((flag) => flag.name === "-S" || flag.name === "--split-string");
					if (split?.value !== undefined) {
						scan([split.value, ...parsed.rest].join(" "), mode);
						return;
					}
				}
				words = parsed.rest;
				continue;
			}
			if (shellCommands.has(name)) {
				for (let i = 0; i < args.length; i++) {
					if (args[i] === "--" || !args[i].startsWith("-")) break;
					if (args[i] === "--help" || args[i] === "--version") return;
					if (/^-[^-]*c/.test(args[i]) && args[i + 1] !== undefined) {
						scan(args[i + 1], "posix");
						break;
					}
				}
				return;
			}
			if (name === "pwsh" || name === "powershell" || name === "cmd") {
				const index = args.findIndex((arg) => name === "cmd" ? /^\/[ck]$/i.test(arg) : /^-(?:command|c)$/i.test(arg));
				if (index >= 0 && !helpOnly(args.slice(0, index))) {
					scan(args.slice(index + 1).join(" "), name === "cmd" ? "cmd" : "powershell");
				}
				return;
			}
			if (name === "find") {
				let deletes = false;
				const executions: string[][] = [];
				for (let i = 0; i < args.length; i++) {
					const arg = args[i];
					if (findValues.has(arg) || /^-newer[acmBt][acmBt]$/.test(arg)) { i++; continue; }
					if (arg === "-fprintf") { i += 2; continue; }
					if (arg === "--help" || arg === "-help" || arg === "--version" || arg === "-version") return;
					if (arg === "-delete") deletes = true;
					if (/^-(?:exec|execdir|ok|okdir)$/.test(arg)) {
						let end = i + 1;
						while (end < args.length && args[end] !== ";" && args[end] !== "+") end++;
						executions.push(args.slice(i + 1, end));
						i = end;
					}
				}
				if (deletes) add("find -delete");
				for (const execution of executions) inspect(execution, mode);
				return;
			}
			if (name === "git") {
				const { rest, flags: globalFlags } = afterOptions(args, gitValues);
				if (globalFlags.some((flag) => flag.name === "--help" || flag.name === "-h" || flag.name === "--version")) return;
				const flags = options(rest.slice(1));
				if ((rest[0] === "rm" || rest[0] === "clean") && !helpOnly(rest.slice(1))
					&& !flags.some((arg) => arg === "--dry-run" || /^-[^-]*n/.test(arg))
					&& !(rest[0] === "rm" && flags.includes("--cached"))) add(`git ${rest[0]}`);
				return;
			}
			if (deletionCommands.has(name) && !deletionReadOnly(name, args)) add(name);
			return;
		}
	};
	// Unknown command tools may target any of these shells; take the conservative union.
	const modes: ShellDialect[] = dialect ? [dialect] : ["posix", "powershell", "cmd"];
	for (const mode of modes) scan(command, mode);
	return [...reasons];
}
