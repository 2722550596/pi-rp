/**
 * HarnessEnv / Capabilities 转出口（15-F §5.1）。
 *
 * 形状唯一权威 = packages/agent/src/harness/capabilities.ts（Impl-A 定稿；negotiate() 为唯一合法构造点）。
 * 本文件零形状定义，仅转出 —— A 侧演进时此处零改动。
 * negotiate() 不转出：能力构造只允许发生在组装入口（契约 §4 原则 1），下游只读注入值。
 */
export type {
	BrowserHarnessEnv,
	Capabilities,
	HarnessEnv,
	NodeHarnessEnv,
} from "../../agent/src/harness/capabilities.ts";
