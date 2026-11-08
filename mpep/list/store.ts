import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isComplete, parseListState, type ListState } from "./model.ts";

// Keep the session entry tag stable so historical and modern payloads share
// one authoritative stream. ListState.schemaVersion distinguishes their shape.
export const LIST_STATE_ENTRY = "mpep.list.state.v1";
type SessionReader = Pick<ExtensionContext["sessionManager"], "getEntries">;

/** The session log is authoritative; the UI is only a projection of this state. */
export class ListStore {
	private lists: ListState[] = [];
	private numbers = new Map<string, number>();
	private problem: Error | undefined;
	private readonly persist: (state: ListState) => void;
	private readonly changed: () => void;

	constructor(persist: (state: ListState) => void, changed: () => void) {
		this.persist = persist;
		this.changed = changed;
	}

	/** Numbers are one-based creation positions, including the current list. */
	get count(): number {
		if (this.problem) throw this.problem;
		return this.lists.length;
	}

	restore(session: SessionReader): void {
		this.lists = [];
		this.numbers.clear();
		this.problem = undefined;
		try {
			// The whole session owns the lists, not the current /tree branch.
			// Map preserves first-seen order while replacing each ID's payload with
			// its final snapshot. Updates therefore never consume a list number.
			// Only final snapshots need parsing; old sessions require no migration
			// or extra writes, and replay produces the same numbers after restart.
			const records = new Map<string, unknown>();
			for (const entry of session.getEntries()) {
				if (entry.type !== "custom" || entry.customType !== LIST_STATE_ENTRY) continue;
				const data: unknown = entry.data;
				if (
					typeof data !== "object" || data === null ||
					!("id" in data) || typeof data.id !== "string" || data.id.length === 0
				) {
					throw new Error("A saved checklist is missing its identity.");
				}
				records.set(data.id, data);
			}
			this.lists = [...records.values()].map(parseListState);
			this.numbers = new Map(this.lists.map((state, index) => [state.id, index + 1]));
		} catch (error) {
			this.problem = new Error(`The saved checklist is invalid: ${error instanceof Error ? error.message : String(error)}`);
		}
		this.changed();
	}

	read(listNumber?: number): ListState | undefined {
		if (this.problem) throw this.problem;
		if (listNumber === undefined) return this.lists.at(-1);
		if (!Number.isSafeInteger(listNumber) || listNumber < 1) {
			throw new Error("listNumber must be a positive safe integer.");
		}
		const state = this.lists[listNumber - 1];
		if (!state) {
			throw new Error(`Unknown checklist number: ${listNumber}. Use list_history to inspect available numbers.`);
		}
		return state;
	}

	/** Return only archived identities, without copying full goals or tasks. */
	history(): { listNumber: number; title: string }[] {
		if (this.problem) throw this.problem;
		return this.lists.slice(0, -1).map((state, index) => ({
			listNumber: index + 1,
			title: state.title,
		}));
	}

	commit(next: ListState): void {
		const previous = this.read();
		if (next === previous) return;
		if (previous && next.id !== previous.id) {
			if (this.numbers.has(next.id)) {
				throw new Error("Historical checklists are read-only and cannot become the current checklist again.");
			}
			if (!isComplete(previous)) {
				throw new Error("Cannot replace the checklist while it still contains unfinished items.");
			}
		}
		if (previous && next.id === previous.id && next.goal !== previous.goal) {
			throw new Error("The checklist goal is fixed at creation and cannot be changed.");
		}
		// Persist before publishing state or assigning a new number. A failed
		// append must neither replace a list nor leave gaps in the sequence.
		this.persist(next);
		if (previous?.id === next.id) {
			this.lists[this.lists.length - 1] = next;
		} else {
			this.lists.push(next);
			this.numbers.set(next.id, this.lists.length);
		}
		this.changed();
	}
}
