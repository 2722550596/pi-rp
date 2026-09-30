/**
 * CI 守护 entry（15-F §11.1 A5 符号完整性 + A3 默认单 anthropic 断言面）。
 * 不发 npm，仅 scripts/check-browser-harness.mjs 构建断言用。
 *
 * 全工具工厂 + allToolNames 全集 import（消费引用防 tree-shake）：任何工具路径的
 * node 渗透 / pi-tui stub 缺口在构建期暴露。
 */
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import {
	allToolNames,
	createAllToolDefinitions,
	createAllTools,
	createCodingToolDefinitions,
	createCodingTools,
	createReadOnlyToolDefinitions,
	createReadOnlyTools,
	createTool,
	createToolDefinition,
	type ToolName,
} from "../../coding-agent/src/core/tools/index.ts";

/** 保留引用：确保 7 个工具模块全部进入 bundle 图（A5 断言对象，15-F §11.1）。 */
export const ciToolSurface: Record<string, unknown> = {
	allToolNames,
	createToolDefinition,
	createTool,
	createAllToolDefinitions,
	createAllTools,
	createCodingToolDefinitions,
	createCodingTools,
	createReadOnlyToolDefinitions,
	createReadOnlyTools,
};

/** A3 基线：直连集首选 anthropic provider 可独立入包（单 SDK + 单 catalog，上游 treeshake 手法）。 */
export const ciAnthropicProvider = anthropicProvider();
export type ciToolName = ToolName;
