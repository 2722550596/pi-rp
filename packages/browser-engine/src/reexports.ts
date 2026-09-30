/**
 * coding-agent 纯核类型转出口（15-F §3.3/§5.1/§9）。
 *
 * 12-C 已落地（2026-09-30）：类型定义权威落点仍为 core/extensions/types.ts（类型层，
 * 全量 type-only import）；纯装配核 api.ts 承载运行时（createExtensionRuntime/
 * loadExtensionFromFactory/loadExtensionsFromFactories，纯 TS 零 node:/jiti/pi-tui），
 * 故原「切至 api.ts」注记作废——类型源不切换。本文件维持 type-only 转出，bundle 零
 * 运行时负担；Wave 3 装配的运行时 import 点 = api.ts + event-bus-memory.ts +
 * exec-impl.ts（exec 组装点分派：caps.shell ? shellBridgeExec(env) : execCommand :
 * refusalExec，见 12-C 回执）。
 */
export type {
	ExtensionFactory,
	LoadExtensionsResult,
	ToolDefinition,
} from "../../coding-agent/src/core/extensions/types.ts";
export type { Skill } from "../../coding-agent/src/core/skills.ts";
export type { ToolName } from "../../coding-agent/src/core/tools/index.ts";
