/** Lazy local history data; no Git operation here changes HEAD or the index. */
import { type GitChangeCategory, type GitChangeFile, parseGitNumstat } from "./git-changes.ts";
import { resolveGitPath, runGit } from "./git-command.ts";
import { compareGitFiles } from "./git-path-order.ts";

export interface GitCommit {
	hash: string;
	parents: string[];
	subject: string;
	date: string;
}

export interface GitHistoryPage {
	/** Newest first, matching Git's traversal and the pagination offset. */
	commits: GitCommit[];
	hasMore: boolean;
	anchor?: string;
}

const objectId = /^(?:[a-f\d]{40}|[a-f\d]{64})$/i;

/** Anchor all pages to the opening HEAD so concurrent commits cannot shift skip. */
export async function readGitHistory(root: string, options: {
	anchor?: string;
	skip?: number;
	limit?: number;
} = {}): Promise<GitHistoryPage> {
	const limit = Math.min(100, Math.max(1, Math.floor(options.limit ?? 10)));
	const skip = Math.max(0, Math.floor(options.skip ?? 0));
	if (!Number.isFinite(limit) || !Number.isSafeInteger(skip)) throw new Error("Invalid history page");
	let anchor = options.anchor;
	if (anchor === undefined) {
		try {
			anchor = (await runGit(root, ["rev-parse", "--verify", "--quiet", "HEAD"])).toString("utf8").trim();
		} catch (error) {
			if ((error as { code?: number | string }).code === 1) return { commits: [], hasMore: false };
			throw error;
		}
	}
	if (!objectId.test(anchor)) throw new Error("History anchor must be a full object ID");
	const output = await runGit(root, [
		"log", "-z", "--format=%H%x00%P%x00%cs%x00%s",
		`--max-count=${limit + 1}`, `--skip=${skip}`, anchor, "--",
	]);
	const fields = output.toString("utf8").split("\0");
	if (fields.at(-1) === "") fields.pop();
	if (fields.length % 4 !== 0) throw new Error("Malformed Git history output");
	const commits: GitCommit[] = [];
	for (let index = 0; index < fields.length; index += 4) {
		const [hash, parentField, date, subject] = fields.slice(index, index + 4);
		const parents = parentField.split(" ").filter(Boolean);
		if (!objectId.test(hash) || parents.some(parent => !objectId.test(parent))) {
			throw new Error("Malformed Git commit metadata");
		}
		commits.push({ hash, parents, date, subject });
	}
	return { commits: commits.slice(0, limit), hasMore: commits.length > limit, anchor };
}

const categories: Record<string, GitChangeCategory> = {
	M: "modified",
	A: "added",
	D: "deleted",
	R: "renamed",
	C: "copied",
	T: "typeChanged",
	U: "conflicted",
};

/** Merge commits are compared with their first parent, like a linear mainline. */
export async function readCommitChanges(root: string, commit: GitCommit): Promise<GitChangeFile[]> {
	if (!objectId.test(commit.hash) || commit.parents.some(parent => !objectId.test(parent))) {
		throw new Error("Invalid commit object ID");
	}
	const base = commit.parents[0] ?? (await runGit(root, ["hash-object", "-t", "tree", "--stdin"], Buffer.alloc(0)))
		.toString("utf8").trim();
	const args = [
		// Historical classification must use that tree, not today's .gitattributes.
		`--attr-source=${commit.hash}`,
		"-c", "diff.relative=false", "diff", "--no-ext-diff", "--no-textconv", "--no-color",
		"--find-renames", "--find-copies",
	];
	const revisions = [base, commit.hash, "--"];
	const [names, numbers] = await Promise.all([
		runGit(root, [...args, "--name-status", "-z", ...revisions]),
		runGit(root, [...args, "--numstat", "-z", ...revisions]),
	]);
	const counts = parseGitNumstat(numbers.toString("utf8"));
	const records = names.toString("utf8").split("\0");
	const files: GitChangeFile[] = [];
	for (let index = 0; index < records.length && records[index]; index++) {
		const code = records[index][0];
		const category = categories[code];
		const originalPath = code === "R" || code === "C" ? records[++index] : undefined;
		const path = records[++index];
		if (!category || !path || !resolveGitPath(root, path)) throw new Error("Malformed Git change entry");
		if (originalPath && !resolveGitPath(root, originalPath)) throw new Error("Invalid original Git path");
		const lines = counts.get(path);
		files.push({
			path,
			originalPath,
			categories: [category],
			additions: lines?.additions ?? null,
			deletions: lines?.deletions ?? null,
			kind: !lines ? "unavailable" : lines.additions === null ? "binary" : "text",
			deleted: code === "D",
		});
	}
	return files.sort(compareGitFiles);
}
