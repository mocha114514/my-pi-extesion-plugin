/** Terminal-safe path rendering shared by the Git browser and code preview. */
import { visibleWidth } from "@earendil-works/pi-tui";

/** Keep unusual Git names readable without allowing embedded terminal commands. */
export function displayPath(path: string): string {
	return path.replace(/[\u0000-\u001f\u007f-\u009f]/g, char => {
		if (char === "\n") return "\\n";
		if (char === "\r") return "\\r";
		if (char === "\t") return "\\t";
		return `\\x${char.charCodeAt(0).toString(16).padStart(2, "0")}`;
	});
}

const pathSegments = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** Wrap without truncating paths or splitting a visible Unicode grapheme. */
export function wrapPath(path: string, width: number): string[] {
	width = Math.max(1, Math.floor(width));
	const rows: string[] = [];
	let line = "";
	let columns = 0;
	const append = (part: string) => {
		const size = visibleWidth(part);
		if (columns + size > width && line) {
			rows.push(line);
			line = "";
			columns = 0;
		}
		line += part;
		columns += size;
	};
	for (const { segment } of pathSegments.segment(displayPath(path))) {
		if (visibleWidth(segment) <= width) append(segment);
		else {
			// Keep a wide grapheme readable even in a one-column viewport.
			const escaped = Array.from(segment, char => `\\u{${char.codePointAt(0)!.toString(16)}}`).join("");
			for (const char of escaped) append(char);
		}
	}
	if (line || rows.length === 0) rows.push(line);
	return rows;
}
