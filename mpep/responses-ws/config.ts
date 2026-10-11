import {
	createModelFlagReader,
	type ModelFlagRules,
} from "../shared/model-flags.ts";

/** Backward-compatible exports; all WS rule semantics and diagnostics stay intact. */
export type WsRules = ModelFlagRules;

const reader = createModelFlagReader("ws", "model transport rules");

export const loadWsRules = reader.load;
export const parseWsRules = reader.parse;
