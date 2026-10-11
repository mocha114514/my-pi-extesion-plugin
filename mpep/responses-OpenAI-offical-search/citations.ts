import type {
	AssistantMessage,
	TextContent,
} from "@earendil-works/pi-ai";

/**
 * Placement category for a normalized citation.
 */
export type CitationPlacement = "inline" | "appended" | "already_linked";

/**
 * Normalized citation record capturing the original source span and safe URL destination.
 * Offsets are measured against the combined sourceText (in JS UTF-16 code units).
 */
export interface NormalizedCitationRecord {
	/** Verified zero-based start index in combined sourceText, or undefined if unsure. */
	readonly startIndex?: number;
	/** Verified zero-based end index in combined sourceText, or undefined if unsure. */
	readonly endIndex?: number;
	/** Exact span text at verified offset, or original annotation text, or fallback label. */
	readonly text: string;
	/** Validated safe HTTP(S) destination URL. */
	readonly url: string;
	/** Sanitized human-readable citation title, if provided by provider. */
	readonly title?: string;
	/** Placement outcome chosen during citation repair. */
	readonly renderedLocation: CitationPlacement;
	/** Zero-based index of the message.content part containing this annotation. */
	readonly partIndex: number;
	/** Raw uncoerced start_index from provider annotation, if supplied. */
	readonly rawStartIndex?: number;
	/** Raw uncoerced end_index from provider annotation, if supplied. */
	readonly rawEndIndex?: number;
	/** Text of the containing content part. */
	readonly localText?: string;
	/** Original raw URL from provider before normalization or canonicalization. */
	readonly rawUrl?: string;
	/** Original raw title from provider before sanitization or truncation. */
	readonly rawTitle?: string;
}

/**
 * Namespaced metadata attached to modified TextContent blocks.
 * Preserves unformatted original text alongside read-only citation records.
 */
export interface MpepWebSearchMetadata {
	readonly version: 1;
	/** Unformatted combined source text before Markdown repair. */
	readonly sourceText: string;
	/** Immutable array of normalized citation records. */
	readonly citations: readonly NormalizedCitationRecord[];
}

/**
 * TextContent block enriched with mpepWebSearch metadata.
 */
export interface MpepWebSearchTextContent extends TextContent {
	mpepWebSearch?: MpepWebSearchMetadata;
}

interface RawAnnotationCandidate {
	readonly url: string;
	readonly title?: string;
	readonly text?: string;
	readonly rawStartIndex?: number;
	readonly rawEndIndex?: number;
	readonly partIndex: number;
	readonly partStartOffset: number;
	readonly partText: string;
	readonly rawUrl?: string;
	readonly rawTitle?: string;
}

interface ObservedItemData {
	readonly itemId: string;
	responseId?: string;
	readonly sourceText: string;
	readonly annotations: readonly RawAnnotationCandidate[];
}

interface InlineReplacement {
	readonly startIndex: number;
	readonly endIndex: number;
	readonly text: string;
	readonly url: string;
	readonly title?: string;
	readonly replacement: string;
}

interface ExistingMarkdownLink {
	readonly start: number;
	readonly end: number;
	readonly url?: string;
	readonly isDefinition?: boolean;
}

interface FallbackCitation {
	readonly url: string;
	readonly title?: string;
}

interface CodeRegion {
	readonly start: number;
	readonly end: number;
}

interface CodeContextInfo {
	readonly regions: CodeRegion[];
	readonly unclosedFenceDelimiter?: string;
}

const MAX_URL_LENGTH = 4096;
const MAX_TITLE_LENGTH = 500;
const MAX_GLOBAL_RECORDS = 200;
const MAX_RECORDS_PER_BUCKET = 50;

/** C0 (0x00-0x1F), DEL (0x7F), and C1 (0x80-0x9F) control characters regex. */
const CONTROL_CHARS_TEST_REGEX = /[\x00-\x1F\x7F-\x9F]/;
const CONTROL_CHARS_GLOBAL_REGEX = /[\x00-\x1F\x7F-\x9F]/g;

/**
 * Extract an output message item ID from a TextContent textSignature.
 * Strictly requires parsed.v === 1 for versioned JSON; falls back to the exact untrimmed
 * signature string (matching Pi native decoder behavior) so whitespace identity is preserved.
 */
function extractItemIdFromSignature(signature: string | undefined): string | undefined {
	if (!signature || typeof signature !== "string" || signature.length === 0) {
		return undefined;
	}
	const trimmed = signature.trim();
	if (trimmed.startsWith("{")) {
		try {
			const parsed = JSON.parse(trimmed) as { v?: unknown; id?: unknown };
			if (
				parsed &&
				typeof parsed === "object" &&
				parsed.v === 1 &&
				typeof parsed.id === "string" &&
				parsed.id.length > 0
			) {
				return parsed.id;
			}
		} catch {
			// Fall through to original raw signature
		}
	}
	return signature;
}

/**
 * Validate and sanitize a URL string. Rejects C0 and C1 controls before trimming,
 * allows only http: and https:, and percent-encodes parentheses for Markdown safety.
 */
function sanitizeUrl(candidate: unknown): string | undefined {
	if (typeof candidate !== "string") return undefined;
	if (CONTROL_CHARS_TEST_REGEX.test(candidate)) return undefined;

	const trimmed = candidate.trim();
	if (!trimmed || trimmed.length > MAX_URL_LENGTH) return undefined;

	let parsed: URL;
	try {
		parsed = new URL(trimmed);
	} catch {
		return undefined;
	}

	const protocol = parsed.protocol.toLowerCase();
	if (protocol !== "http:" && protocol !== "https:") return undefined;

	return parsed.href
		.replace(/\(/g, "%28")
		.replace(/\)/g, "%29");
}

/**
 * Sanitize a citation title for display. Globally strips all C0 and C1 control characters,
 * normalizes whitespace, and truncates to 500 characters.
 */
function sanitizeTitle(candidate: unknown): string | undefined {
	if (typeof candidate !== "string") return undefined;
	const cleaned = candidate
		.replace(CONTROL_CHARS_GLOBAL_REGEX, " ")
		.replace(/\s+/g, " ")
		.trim();
	if (!cleaned) return undefined;
	return cleaned.length > MAX_TITLE_LENGTH ? cleaned.slice(0, MAX_TITLE_LENGTH) : cleaned;
}

/**
 * Analyze code contexts in text, detecting fenced blocks (with 0-3 leading spaces and
 * variable delimiter lengths), indented code blocks (4 spaces/tab), and inline code spans.
 * Validates info string according to CommonMark (backtick fence info string cannot contain backticks).
 * Also detects unclosed fenced code blocks to ensure footers can be placed outside code.
 */
function analyzeCodeContext(text: string): CodeContextInfo {
	const regions: CodeRegion[] = [];
	const length = text.length;
	let unclosedFenceDelimiter: string | undefined;
	let i = 0;

	while (i < length) {
		const lineStart = i;
		let lineEnd = text.indexOf("\n", lineStart);
		if (lineEnd === -1) lineEnd = length;

		const line = text.slice(lineStart, lineEnd);

		// CommonMark 4.5: info strings for backtick code blocks cannot contain backticks.
		// Tildes can contain anything except newlines.
		const backtickMatch = /^[ ]{0,3}(`{3,})([^`\n]*)$/.exec(line);
		const tildeMatch = !backtickMatch ? /^[ ]{0,3}(~{3,})([^\n]*)$/.exec(line) : null;
		const fenceMatch = backtickMatch || tildeMatch;

		if (fenceMatch) {
			const fenceStr = fenceMatch[1];
			const fenceChar = fenceStr[0];
			const fenceLen = fenceStr.length;
			let blockEnd = length;
			let searchPos = lineEnd + 1;
			let foundClose = false;

			while (searchPos < length) {
				let nextLineEnd = text.indexOf("\n", searchPos);
				if (nextLineEnd === -1) nextLineEnd = length;
				const nextLine = text.slice(searchPos, nextLineEnd);
				const closeMatch = /^[ ]{0,3}(`{3,}|~{3,})[ ]*$/.exec(nextLine);

				if (closeMatch && closeMatch[1][0] === fenceChar && closeMatch[1].length >= fenceLen) {
					blockEnd = nextLineEnd;
					i = nextLineEnd + 1;
					foundClose = true;
					break;
				}
				searchPos = nextLineEnd + 1;
			}

			if (!foundClose) {
				blockEnd = length;
				i = length;
				unclosedFenceDelimiter = fenceStr;
			}

			regions.push({ start: lineStart, end: blockEnd });
			continue;
		}

		if (/^(?: {4}|\t)/.test(line)) {
			let blockEnd = lineEnd;
			let nextPos = lineEnd + 1;

			while (nextPos < length) {
				let nextLineEnd = text.indexOf("\n", nextPos);
				if (nextLineEnd === -1) nextLineEnd = length;
				const nextLine = text.slice(nextPos, nextLineEnd);

				if (/^(?: {4}|\t)/.test(nextLine) || nextLine.trim() === "") {
					blockEnd = nextLineEnd;
					nextPos = nextLineEnd + 1;
				} else {
					break;
				}
			}

			regions.push({ start: lineStart, end: blockEnd });
			i = nextPos;
			continue;
		}

		i = lineEnd + 1;
	}

	let k = 0;
	while (k < length) {
		const inBlock = regions.find((r) => k >= r.start && k < r.end);
		if (inBlock) {
			k = inBlock.end;
			continue;
		}

		if (text[k] === "`") {
			let tickCount = 1;
			while (k + tickCount < length && text[k + tickCount] === "`") {
				tickCount++;
			}
			const spanStart = k;
			k += tickCount;

			const closePattern = "`".repeat(tickCount);
			let closePos = -1;
			let p = k;

			while (p < length) {
				const nextTick = text.indexOf(closePattern, p);
				if (nextTick === -1) break;
				let afterTicks = nextTick + tickCount;
				while (afterTicks < length && text[afterTicks] === "`") {
					afterTicks++;
				}
				if (afterTicks === nextTick + tickCount) {
					closePos = nextTick;
					break;
				}
				p = afterTicks;
			}

			if (closePos !== -1) {
				const spanEnd = closePos + tickCount;
				regions.push({ start: spanStart, end: spanEnd });
				k = spanEnd;
				continue;
			}
		}
		k++;
	}

	return { regions, unclosedFenceDelimiter };
}

/**
 * Locate existing Markdown links within text, recognizing inline links [label](dest),
 * link reference definitions [ref]: dest, full reference links [label][ref],
 * collapsed reference links [label][], and shortcut reference links [ref].
 * Ignores link reference definitions that appear inside code regions.
 * Reference definitions are flagged with isDefinition: true so they are protected
 * without masquerading as rendered clickable links.
 */
function findExistingMarkdownLinks(text: string, codeRegions: CodeRegion[]): ExistingMarkdownLink[] {
	const links: ExistingMarkdownLink[] = [];
	const length = text.length;

	// 1. Scan link reference definitions: [ref]: url "title"
	const refDefinitions = new Map<string, { start: number; end: number; url?: string }>();
	const refDefRegex = /^[ ]{0,3}\[([^\]]+)\]:[ \t]*<?([^\s>]+)>?(?:[ \t]+["'(](.*?)["')])?[ ]*$/gm;
	let defMatch: RegExpExecArray | null;

	while ((defMatch = refDefRegex.exec(text)) !== null) {
		const matchIndex = defMatch.index;
		const matchEnd = matchIndex + defMatch[0].length;

		// Ignore definitions located inside code blocks
		const insideCode = codeRegions.some(
			(code) => Math.max(matchIndex, code.start) < Math.min(matchEnd, code.end),
		);
		if (insideCode) continue;

		const label = defMatch[1].trim().toLowerCase();
		const destUrl = sanitizeUrl(defMatch[2]);
		refDefinitions.set(label, {
			start: matchIndex,
			end: matchEnd,
			url: destUrl,
		});
		links.push({
			start: matchIndex,
			end: matchEnd,
			url: destUrl,
			isDefinition: true,
		});
	}

	// 2. Scan inline and reference link usages
	let i = 0;
	while (i < length) {
		if (text[i] === "[" && (i === 0 || text[i - 1] !== "\\")) {
			const labelStart = i;
			let labelEnd = -1;
			let depth = 1;
			let j = i + 1;

			while (j < length) {
				if (text[j] === "\\" && j + 1 < length) {
					j += 2;
					continue;
				}
				if (text[j] === "[") {
					depth++;
				} else if (text[j] === "]") {
					depth--;
					if (depth === 0) {
						labelEnd = j;
						break;
					}
				}
				j++;
			}

			if (labelEnd !== -1) {
				const labelText = text.slice(labelStart + 1, labelEnd);
				const afterLabel = labelEnd + 1;

				// Inline link: [label](dest)
				if (afterLabel < length && text[afterLabel] === "(") {
					let destEnd = -1;
					let k = afterLabel + 1;

					while (k < length) {
						if (text[k] === "\\" && k + 1 < length) {
							k += 2;
							continue;
						}
						if (text[k] === ")") {
							destEnd = k;
							break;
						}
						k++;
					}

					if (destEnd !== -1) {
						const rawDest = text.slice(afterLabel + 1, destEnd).trim();
						const spaceIdx = rawDest.indexOf(" ");
						const cleanDest = spaceIdx !== -1 ? rawDest.slice(0, spaceIdx) : rawDest;
						links.push({
							start: labelStart,
							end: destEnd + 1,
							url: sanitizeUrl(cleanDest),
						});
						i = destEnd + 1;
						continue;
					}
				}

				// Full reference link [label][ref] or collapsed [label][]
				if (afterLabel < length && text[afterLabel] === "[") {
					const refEnd = text.indexOf("]", afterLabel + 1);
					if (refEnd !== -1) {
						const refText = text.slice(afterLabel + 1, refEnd).trim();
						const lookupKey = (refText.length > 0 ? refText : labelText).toLowerCase();
						const targetDef = refDefinitions.get(lookupKey);

						links.push({
							start: labelStart,
							end: refEnd + 1,
							url: targetDef?.url,
						});
						i = refEnd + 1;
						continue;
					}
				}

				// Shortcut reference link [ref]
				const shortcutKey = labelText.trim().toLowerCase();
				const shortcutDef = refDefinitions.get(shortcutKey);
				if (shortcutDef) {
					links.push({
						start: labelStart,
						end: labelEnd + 1,
						url: shortcutDef.url,
					});
					i = labelEnd + 1;
					continue;
				}
			}
		}
		i++;
	}

	return links;
}

/**
 * Escape Markdown label syntax so formatting symbols do not change display or disable clickability.
 */
function escapeMarkdownLabel(label: string): string {
	return label
		.replace(/\\/g, "\\\\")
		.replace(/\[/g, "\\[")
		.replace(/\]/g, "\\]")
		.replace(/\*/g, "\\*")
		.replace(/_/g, "\\_")
		.replace(/`/g, "\\`")
		.replace(/</g, "\\<")
		.replace(/>/g, "\\>")
		.replace(/~/g, "\\~");
}

/**
 * Escape double quotes and backslashes within Markdown title attributes.
 */
function escapeMarkdownTitle(title: string): string {
	return title
		.replace(/\\/g, "\\\\")
		.replace(/"/g, '\\"');
}

/**
 * Verify whether a text span demonstrably resembles a citation marker.
 */
function isDemonstrableCitationMarker(span: string): boolean {
	const trimmed = span.trim();
	if (!trimmed) return false;
	if (/^\[\d+\]$/.test(trimmed)) return true;
	if (/^\d{1,3}$/.test(trimmed)) return true;
	if (/^\[[a-zA-Z0-9_\-\s]{1,30}\]$/.test(trimmed)) return true;
	if (/^【[^】]{1,50}】$/.test(trimmed)) return true;
	if (/^\uE200cite\uE202[^\uE201]{1,60}\uE201$/.test(trimmed)) return true;
	return false;
}

/**
 * Safe unwrap helper to inspect wrapped event envelopes without mutation.
 */
function unwrapEventObject(data: unknown): Record<string, unknown> | undefined {
	if (!data || typeof data !== "object") return undefined;
	let current: unknown = data;
	const seen = new Set<unknown>();

	for (let depth = 0; depth < 5; depth++) {
		if (!current || typeof current !== "object" || seen.has(current)) {
			return undefined;
		}
		seen.add(current);
		const obj = current as Record<string, unknown>;
		if (typeof obj.type === "string") return obj;

		if (obj.event && typeof obj.event === "object") {
			current = obj.event;
		} else if (obj.data && typeof obj.data === "object") {
			current = obj.data;
		} else if (obj.raw && typeof obj.raw === "object") {
			current = obj.raw;
		} else {
			return undefined;
		}
	}
	return undefined;
}

/**
 * Validate that an annotation range is integral, non-negative, and strictly within part bounds.
 */
function isValidPartRange(
	start: number,
	end: number,
	partLength: number,
): boolean {
	if (!Number.isInteger(start) || !Number.isInteger(end)) return false;
	if (start < 0 || end <= start) return false;
	if (end > partLength) return false;
	return true;
}

/**
 * Detect whether the part text prefix up to endIndex contains non-BMP characters
 * (surrogate pairs), creating ambiguity between Unicode code points and UTF-16 code units.
 */
function hasSurrogatePrefix(text: string, upToIndex: number): boolean {
	const prefix = text.slice(0, Math.min(upToIndex, text.length));
	return /[\uD800-\uDFFF]/.test(prefix);
}

/**
 * Collector responsible for capturing provider stream citation annotations
 * and applying Markdown repair to matching AssistantMessage TextContent blocks.
 */
export class CitationCollector {
	private readonly sourcesLabel: string;
	private readonly recordsByItemId = new Map<string, ObservedItemData[]>();
	private totalRecordCount = 0;

	public constructor(options?: { sourcesLabel?: string } | string) {
		if (typeof options === "string") {
			this.sourcesLabel = options.trim() || "Sources";
		} else if (options && typeof options.sourcesLabel === "string") {
			this.sourcesLabel = options.sourcesLabel.trim() || "Sources";
		} else {
			this.sourcesLabel = "Sources";
		}
	}

	/**
	 * Observe an incoming provider stream event.
	 */
	public observe(data: unknown): void {
		const event = unwrapEventObject(data);
		if (!event) return;

		const eventType = event.type;

		if (eventType === "response.output_item.done") {
			const item = event.item;
			if (item && typeof item === "object") {
				const responseId = typeof event.response_id === "string" ? event.response_id : undefined;
				this.recordMessageItem(item as Record<string, unknown>, responseId);
			}
			return;
		}

		if (eventType === "response.completed" || eventType === "response.incomplete") {
			const responseObj = (event.response && typeof event.response === "object"
				? event.response
				: event) as Record<string, unknown>;

			const responseId = typeof responseObj.id === "string"
				? responseObj.id
				: (typeof event.response_id === "string" ? event.response_id : undefined);

			const output = responseObj.output;
			if (Array.isArray(output)) {
				for (const item of output) {
					if (item && typeof item === "object") {
						this.recordMessageItem(item as Record<string, unknown>, responseId);
					}
				}
			}
		}
	}

	/**
	 * Apply collected citations to an AssistantMessage.
	 */
	public apply(message: AssistantMessage): AssistantMessage | undefined {
		if (!message || typeof message !== "object" || !Array.isArray(message.content)) {
			return undefined;
		}

		let hasChanges = false;
		const messageResponseId = typeof message.responseId === "string" ? message.responseId : undefined;

		const updatedContent = message.content.map((block) => {
			if (block.type !== "text") return block;

			const textBlock = block as MpepWebSearchTextContent;
			if (textBlock.mpepWebSearch !== undefined) return block;

			const itemId = extractItemIdFromSignature(textBlock.textSignature);
			if (!itemId) return block;

			const records = this.recordsByItemId.get(itemId);
			if (!records || records.length === 0) return block;

			// Locate exact responseId match or unambiguous unknown-response record
			let matchIndex = -1;
			if (messageResponseId) {
				matchIndex = records.findIndex((r) => r.responseId === messageResponseId);
				if (matchIndex === -1) {
					// Fallback to unknown record ONLY when completely unambiguous
					const unknownIndices = records
						.map((r, idx) => (r.responseId === undefined && r.sourceText === textBlock.text ? idx : -1))
						.filter((idx) => idx !== -1);
					if (unknownIndices.length === 1 && records.length === 1) {
						matchIndex = unknownIndices[0];
					}
				}
			} else {
				if (records.length === 1 && records[0].sourceText === textBlock.text) {
					matchIndex = 0;
				}
			}

			if (matchIndex === -1) return block;

			const itemData = records[matchIndex];
			records.splice(matchIndex, 1);
			this.totalRecordCount--;
			if (records.length === 0) {
				this.recordsByItemId.delete(itemId);
			}

			if (textBlock.text !== itemData.sourceText) return block;
			if (itemData.annotations.length === 0) return block;

			const repairedBlock = this.repairTextBlock(textBlock, itemData);
			if (repairedBlock) {
				hasChanges = true;
				return repairedBlock;
			}

			return block;
		});

		if (!hasChanges) return undefined;

		return {
			...message,
			content: updatedContent,
		};
	}

	/**
	 * Clear all buffered citation records and reset collector state.
	 */
	public clear(): void {
		this.recordsByItemId.clear();
		this.totalRecordCount = 0;
	}

	private evictOldestRecord(): void {
		for (const [key, list] of this.recordsByItemId) {
			if (list.length > 0) {
				list.shift();
				this.totalRecordCount--;
				if (list.length === 0) {
					this.recordsByItemId.delete(key);
				}
				return;
			} else {
				this.recordsByItemId.delete(key);
			}
		}
	}

	/**
	 * Parse and store an assistant message item with its content parts and annotations.
	 */
	private recordMessageItem(item: Record<string, unknown>, responseId?: string): void {
		if (item.type !== "message" || typeof item.id !== "string") return;

		const itemId = item.id;
		const content = Array.isArray(item.content) ? item.content : [];

		let combinedText = "";
		const annotations: RawAnnotationCandidate[] = [];

		for (let partIdx = 0; partIdx < content.length; partIdx++) {
			const part = content[partIdx];
			if (!part || typeof part !== "object") continue;
			const partObj = part as Record<string, unknown>;

			if (partObj.type === "output_text") {
				const partText = typeof partObj.text === "string" ? partObj.text : "";
				const partStartOffset = combinedText.length;
				combinedText += partText;

				const partAnnotations = Array.isArray(partObj.annotations) ? partObj.annotations : [];

				for (const ann of partAnnotations) {
					if (!ann || typeof ann !== "object") continue;
					const annObj = ann as Record<string, unknown>;

					const isUrlType = annObj.type === "url_citation" ||
						(annObj.url_citation && typeof annObj.url_citation === "object" &&
							(annObj.url_citation as Record<string, unknown>).type === "url_citation");
					if (!isUrlType) continue;

					const rawUrlCandidate = (
						annObj.url_citation && typeof annObj.url_citation === "object"
							? (annObj.url_citation as Record<string, unknown>).url
							: undefined
					) ?? annObj.url;

					const safeUrl = sanitizeUrl(rawUrlCandidate);
					if (!safeUrl) continue;

					const rawTitleCandidate = (
						annObj.url_citation && typeof annObj.url_citation === "object"
							? (annObj.url_citation as Record<string, unknown>).title
							: undefined
					) ?? annObj.title;

					const safeTitle = sanitizeTitle(rawTitleCandidate);
					const textCandidate = typeof annObj.text === "string" ? annObj.text : undefined;
					const rawStart = typeof annObj.start_index === "number" ? annObj.start_index : undefined;
					const rawEnd = typeof annObj.end_index === "number" ? annObj.end_index : undefined;

					annotations.push({
						url: safeUrl,
						title: safeTitle,
						text: textCandidate,
						rawStartIndex: rawStart,
						rawEndIndex: rawEnd,
						partIndex: partIdx,
						partStartOffset,
						partText,
						rawUrl: typeof rawUrlCandidate === "string" ? rawUrlCandidate : undefined,
						rawTitle: typeof rawTitleCandidate === "string" ? rawTitleCandidate : undefined,
					});
				}
			} else if (partObj.type === "refusal") {
				const refusalText = typeof partObj.refusal === "string" ? partObj.refusal : "";
				combinedText += refusalText;
			}
		}

		// Empty annotations snapshot handling: check exact owned record first
		if (annotations.length === 0) {
			const existingRecords = this.recordsByItemId.get(itemId);
			if (existingRecords) {
				if (responseId) {
					const exactOwned = existingRecords.find(
						(r) => r.responseId === responseId && r.sourceText === combinedText,
					);
					if (exactOwned) {
						return;
					}
					const unknownMatches = existingRecords.filter(
						(r) => r.responseId === undefined && r.sourceText === combinedText,
					);
					if (unknownMatches.length === 1) {
						unknownMatches[0].responseId = responseId;
					}
				}
			}
			return;
		}

		// Check if exact responseId update or unambiguous upgrade of unknown record exists
		let records = this.recordsByItemId.get(itemId);
		if (records && responseId) {
			const exactIdx = records.findIndex((r) => r.responseId === responseId);
			if (exactIdx !== -1) {
				records[exactIdx] = {
					itemId,
					responseId,
					sourceText: combinedText,
					annotations,
				};
				return;
			}

			const unknownMatches = records.filter(
				(r) => r.responseId === undefined && r.sourceText === combinedText,
			);
			if (unknownMatches.length === 1) {
				const unknownIdx = records.indexOf(unknownMatches[0]);
				records[unknownIdx] = {
					itemId,
					responseId,
					sourceText: combinedText,
					annotations,
				};
				return;
			}
		}

		// Enforce global capacity limit before acquiring or adding to bucket
		while (this.totalRecordCount >= MAX_GLOBAL_RECORDS) {
			this.evictOldestRecord();
		}

		// Re-acquire or register destination bucket after global eviction
		records = this.recordsByItemId.get(itemId);
		if (!records) {
			records = [];
			this.recordsByItemId.set(itemId, records);
		}

		// Enforce per-bucket capacity
		while (records.length >= MAX_RECORDS_PER_BUCKET) {
			records.shift();
			this.totalRecordCount--;
		}

		records.push({
			itemId,
			responseId,
			sourceText: combinedText,
			annotations,
		});
		this.totalRecordCount++;
	}

	/**
	 * Perform citation repair on a single TextContent block.
	 */
	private repairTextBlock(
		textBlock: TextContent,
		itemData: ObservedItemData,
	): MpepWebSearchTextContent | undefined {
		const sourceText = itemData.sourceText;
		const codeContext = analyzeCodeContext(sourceText);
		const existingLinks = findExistingMarkdownLinks(sourceText, codeContext.regions);

		const normalizedRecords: NormalizedCitationRecord[] = [];
		const inlineCandidates: Array<{
			startIndex: number;
			endIndex: number;
			text: string;
			url: string;
			title?: string;
			partIndex: number;
			rawStartIndex?: number;
			rawEndIndex?: number;
			localText?: string;
			rawUrl?: string;
			rawTitle?: string;
		}> = [];
		const fallbackList: FallbackCitation[] = [];

		for (const ann of itemData.annotations) {
			const {
				url,
				title,
				text,
				rawStartIndex,
				rawEndIndex,
				partIndex,
				partStartOffset,
				partText,
				rawUrl,
				rawTitle,
			} = ann;

			let verifiedCombinedStart: number | undefined;
			let verifiedCombinedEnd: number | undefined;

			if (
				rawStartIndex !== undefined &&
				rawEndIndex !== undefined &&
				isValidPartRange(rawStartIndex, rawEndIndex, partText.length) &&
				!hasSurrogatePrefix(partText, rawEndIndex)
			) {
				const candidateStart = partStartOffset + rawStartIndex;
				const candidateEnd = partStartOffset + rawEndIndex;
				const localSlice = partText.slice(rawStartIndex, rawEndIndex);

				if (text !== undefined) {
					if (localSlice === text) {
						verifiedCombinedStart = candidateStart;
						verifiedCombinedEnd = candidateEnd;
					}
				} else if (isDemonstrableCitationMarker(localSlice)) {
					if (!localSlice.startsWith("\uE200")) {
						verifiedCombinedStart = candidateStart;
						verifiedCombinedEnd = candidateEnd;
					}
				}
			}

			if (verifiedCombinedStart === undefined || verifiedCombinedEnd === undefined) {
				normalizedRecords.push(Object.freeze({
					text: text ?? "",
					url,
					title,
					renderedLocation: "appended",
					partIndex,
					rawStartIndex,
					rawEndIndex,
					localText: partText,
					rawUrl,
					rawTitle,
				}));
				fallbackList.push({ url, title });
				continue;
			}

			const spanText = sourceText.slice(verifiedCombinedStart, verifiedCombinedEnd);

			const insideCode = codeContext.regions.some(
				(code) => Math.max(verifiedCombinedStart!, code.start) < Math.min(verifiedCombinedEnd!, code.end),
			);
			if (insideCode) {
				normalizedRecords.push(Object.freeze({
					startIndex: verifiedCombinedStart,
					endIndex: verifiedCombinedEnd,
					text: spanText,
					url,
					title,
					renderedLocation: "appended",
					partIndex,
					rawStartIndex,
					rawEndIndex,
					localText: partText,
					rawUrl,
					rawTitle,
				}));
				fallbackList.push({ url, title });
				continue;
			}

			const overlappingLink = existingLinks.find(
				(link) => Math.max(verifiedCombinedStart!, link.start) < Math.min(verifiedCombinedEnd!, link.end),
			);

			if (overlappingLink) {
				// Only rendered links (not reference definitions) with matching URL are already_linked
				if (!overlappingLink.isDefinition && overlappingLink.url && overlappingLink.url === url) {
					normalizedRecords.push(Object.freeze({
						startIndex: verifiedCombinedStart,
						endIndex: verifiedCombinedEnd,
						text: spanText,
						url,
						title,
						renderedLocation: "already_linked",
						partIndex,
						rawStartIndex,
						rawEndIndex,
						localText: partText,
						rawUrl,
						rawTitle,
					}));
					continue;
				}
				// Different destination or reference definition: route to safe footer fallback
				normalizedRecords.push(Object.freeze({
					startIndex: verifiedCombinedStart,
					endIndex: verifiedCombinedEnd,
					text: spanText,
					url,
					title,
					renderedLocation: "appended",
					partIndex,
					rawStartIndex,
					rawEndIndex,
					localText: partText,
					rawUrl,
					rawTitle,
				}));
				fallbackList.push({ url, title });
				continue;
			}

			inlineCandidates.push({
				startIndex: verifiedCombinedStart,
				endIndex: verifiedCombinedEnd,
				text: spanText,
				url,
				title,
				partIndex,
				rawStartIndex,
				rawEndIndex,
				localText: partText,
				rawUrl,
				rawTitle,
			});
		}

		inlineCandidates.sort(
			(a, b) => a.startIndex - b.startIndex || a.endIndex - b.endIndex,
		);

		const acceptedInline: InlineReplacement[] = [];
		let lastCoveredEnd = -1;

		for (const cand of inlineCandidates) {
			if (cand.startIndex < lastCoveredEnd) {
				normalizedRecords.push(Object.freeze({
					startIndex: cand.startIndex,
					endIndex: cand.endIndex,
					text: cand.text,
					url: cand.url,
					title: cand.title,
					renderedLocation: "appended",
					partIndex: cand.partIndex,
					rawStartIndex: cand.rawStartIndex,
					rawEndIndex: cand.rawEndIndex,
					localText: cand.localText,
					rawUrl: cand.rawUrl,
					rawTitle: cand.rawTitle,
				}));
				fallbackList.push({ url: cand.url, title: cand.title });
				continue;
			}

			const escapedLabel = escapeMarkdownLabel(cand.text);
			const titleAttribute = cand.title ? ` "${escapeMarkdownTitle(cand.title)}"` : "";
			const replacement = `[${escapedLabel}](${cand.url}${titleAttribute})`;

			acceptedInline.push({
				startIndex: cand.startIndex,
				endIndex: cand.endIndex,
				text: cand.text,
				url: cand.url,
				title: cand.title,
				replacement,
			});

			lastCoveredEnd = cand.endIndex;

			normalizedRecords.push(Object.freeze({
				startIndex: cand.startIndex,
				endIndex: cand.endIndex,
				text: cand.text,
				url: cand.url,
				title: cand.title,
				renderedLocation: "inline",
				partIndex: cand.partIndex,
				rawStartIndex: cand.rawStartIndex,
				rawEndIndex: cand.rawEndIndex,
				localText: cand.localText,
				rawUrl: cand.rawUrl,
				rawTitle: cand.rawTitle,
			}));
		}

		let renderedText = "";
		let cursor = 0;

		for (const inline of acceptedInline) {
			renderedText += sourceText.slice(cursor, inline.startIndex);
			renderedText += inline.replacement;
			cursor = inline.endIndex;
		}
		renderedText += sourceText.slice(cursor);

		if (fallbackList.length > 0) {
			const seenUrls = new Set<string>();
			const uniqueFallbacks: FallbackCitation[] = [];

			for (const fallback of fallbackList) {
				if (!seenUrls.has(fallback.url)) {
					seenUrls.add(fallback.url);
					uniqueFallbacks.push(fallback);
				}
			}

			if (uniqueFallbacks.length > 0) {
				const listItems = uniqueFallbacks.map((fb) => {
					const label = fb.title ?? fb.url;
					const escapedLabel = escapeMarkdownLabel(label);
					return `- [${escapedLabel}](${fb.url})`;
				});

				// Close unclosed fence if output was truncated mid-code block
				if (codeContext.unclosedFenceDelimiter) {
					if (!renderedText.endsWith("\n")) {
						renderedText += "\n";
					}
					renderedText += `${codeContext.unclosedFenceDelimiter}\n`;
				}

				const separator = renderedText.endsWith("\n\n")
					? ""
					: renderedText.endsWith("\n")
						? "\n"
						: "\n\n";

				renderedText += `${separator}${this.sourcesLabel}:\n${listItems.join("\n")}`;
			}
		}

		const metadata: MpepWebSearchMetadata = Object.freeze({
			version: 1,
			sourceText,
			citations: Object.freeze(normalizedRecords),
		});

		return {
			...textBlock,
			text: renderedText,
			mpepWebSearch: metadata,
		};
	}
}
