import {
    createModelFlagReader,
    type ModelFlagRules,
} from "../shared/model-flags.ts";

export type SearchRules = ModelFlagRules;

// Keep the user's existing spelling: this is a models.json configuration key.
const reader = createModelFlagReader("offical-search", "model search rules");

export const loadSearchRules = reader.load;
export const parseSearchRules = reader.parse;
export const emptySearchRules = reader.empty;
