export interface TurnAnchor {
	readonly key: number;
	readonly row: number;
	readonly text: string;
}

/** Columns occupied by the right-side turn rail. Matches the single-cell ─ / ═ markers. */
export const NAVIGATOR_COLUMNS = 1;
const TURN_GROUP_SIZE = 5;

// Numbers are zero-based turn indices; strings are non-interactive separator digits.
export type NavigationMarker = number | string;

export function navigationMarkers(count: number): NavigationMarker[] {
	const markers: NavigationMarker[] = [];
	for (let index = 0; index < count; index++) {
		markers.push(index);
		const turn = index + 1;
		if (turn < count && turn % TURN_GROUP_SIZE === 0) {
			markers.push(...String(turn));
		}
	}
	return markers;
}

/**
 * Rows a complete marker list needs: one per turn and separator digit, plus both arrows.
 * Zero markers means "no lower bound" so an empty index keeps the default band.
 */
function bandRows(count: number): number {
	if (count <= 0) return 0;
	let rows = count + 2;
	for (let turn = TURN_GROUP_SIZE; turn < count; turn += TURN_GROUP_SIZE) {
		rows += String(turn).length;
	}
	return rows;
}

/**
 * Vertical slice of the transcript viewport occupied by the rail.
 *
 * Few turns: the middle-lower half of the viewport, unchanged. From the point where
 * every marker already has its own line, the band grows with turns and label digits so the
 * markers stay individually clickable, up to the whole viewport height; only past that
 * limit does markerRows() window the list and the wheel take over.
 */
export function navigationBand(viewportHeight: number, markerCount = 0): { top: number; height: number } {
	const available = Math.max(0, Math.floor(viewportHeight));
	const base = Math.min(available, Math.max(3, Math.round(available * 0.5)));
	const height = Math.max(base, Math.min(available, bandRows(markerCount)));
	// Grow around the default band's centre so the rail stretches symmetrically towards
	// both edges and covers the whole viewport once the growth is complete.
	const center = base / 2 + Math.min(Math.floor(available * 0.3), available - base);
	return { top: Math.round(Math.max(0, Math.min(center - height / 2, available - height))), height };
}

/**
 * Index of the turn owning the viewport's focus line.
 *
 * The focus line sits at the vertical middle of the viewport, so a turn becomes
 * active as soon as its header enters the upper half of the screen (matches the
 * intuitive "the turn I am looking at" feeling, and lights up the streaming turn
 * much earlier than a top-edge rule). With viewportHeight = 0 the focus line
 * degenerates to the viewport top edge (legacy behavior).
 */
export function activeTurn(anchors: readonly TurnAnchor[], scrollTop: number, viewportHeight = 0): number {
	if (anchors.length === 0) return -1;
	const focus = scrollTop + Math.floor(Math.max(0, viewportHeight) / 2);
	let low = 0;
	let high = anchors.length;
	while (low < high) {
		const middle = (low + high) >>> 1;
		if (anchors[middle].row <= focus) low = middle + 1;
		else high = middle;
	}
	return Math.max(0, low - 1);
}

export function markerRows(
	markers: readonly NavigationMarker[],
	height: number,
	start = 0,
): Map<number, NavigationMarker> {
	const slots = Math.max(0, height - 2);
	const visible = Math.min(markers.length, slots);
	const first = Math.max(0, Math.min(start, markers.length - visible));
	const window = markers.slice(first, first + visible);
	const result = new Map<number, NavigationMarker>();
	const groups = window.filter((marker, index) => index === 0 || typeof marker === "number").length;
	const spare = slots - visible;
	let group = 0;
	for (let index = 0; index < window.length; index++) {
		const marker = window[index];
		if (index > 0 && typeof marker === "number") group++;
		// Add spacing only before turns, keeping each separator's digits on adjacent rows.
		const padding = groups === 1 ? Math.floor(spare / 2) : Math.round((group * spare) / (groups - 1));
		result.set(1 + index + padding, marker);
	}
	return result;
}

export function sameAnchors(left: readonly TurnAnchor[], right: readonly TurnAnchor[]): boolean {
	return (
		left.length === right.length &&
		left.every((item, index) => {
			const other = right[index];
			return item.key === other.key && item.row === other.row && item.text === other.text;
		})
	);
}
