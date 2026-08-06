export {
	prepareSubagentConversation,
	isPrepareError,
} from "./prepare.ts";
export type {
	PrepareSubagentOptions,
	PrepareSubagentResult,
	PrepareSubagentError,
	SubagentPreparation,
} from "./prepare.ts";

export { runSubagent } from "./run.ts";
export type { RunSubagentOptions, SubagentResult, SubagentResultStatus } from "./run.ts";

export {
	createSubagentProfilesToolDefinition,
	createSubagentToolDefinition,
	getDelegatablePresets,
	isDelegatable,
} from "./extension.ts";