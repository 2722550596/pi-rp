/**
 * Canonical UTF-8-aware truncation shared by the agent core and tool layer.
 * The shared implementation is portable to browsers without a Node Buffer global.
 */

export type { TruncationOptions, TruncationResult } from "@earendil-works/pi-agent-core/truncate";
export {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	GREP_MAX_LINE_LENGTH,
	truncateHead,
	truncateLine,
	truncateTail,
} from "@earendil-works/pi-agent-core/truncate";
