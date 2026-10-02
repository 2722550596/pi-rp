/**
 * @earendil-works/pi-browser —— pi harness 浏览器/hosted 剖面分发入口（契约 §9 / 15-F §3.3）。
 *
 * 下游入口：一个包；createPiHarness 装配浏览器/hosted harness，startBrowserExecutor 将
 * 该 harness 的 AgentSession 接入 PiServer 执行者通道。
 * 不可见面：coding-agent 主 barrel、磁盘布局（getAgentDir）、auth-storage、jiti 磁盘通道、
 * modes/interactive、rpc stdio。
 *
 * Harness 装配主体位于 assemble.ts，执行者驱动位于 executor.ts。
 */

/// <reference path="./deps.d.ts" />

// —— 上游重出口（15-F §3.3；InMemorySessionRepo/streamProxy 已在上游 browser-smoke 守护内，浏览器可打包）——
export type { ExecutionEnv, FileSystem, Shell } from "@earendil-works/pi-agent-core";
export { InMemorySessionRepo, streamProxy } from "@earendil-works/pi-agent-core";
// —— 组装入口工厂（Impl-A：HarnessEnv 的两个合法构造点；negotiate 不转出——构造只发生在工厂内）——
export {
	BROWSER_AGENT_DIR,
	createBrowserHarnessEnv,
	createHostedHarnessEnv,
	OpfsStateLocks,
	OpfsStorageBackend,
	opfsStatePaths,
} from "@earendil-works/pi-agent-core/web";
export type { AssistantMessage, Model, StreamFunction, ThinkingLevel } from "@earendil-works/pi-ai";
export type { ByteTransportFactory } from "@earendil-works/pi-client";
export {
	EXECUTOR_PROTOCOL_VERSION,
	MAX_EXECUTOR_INBOUND_CHUNK_BYTES,
	MIN_ABORT_CONTROL_BYTES,
} from "@earendil-works/pi-protocol";
export type { SessionRepo } from "../../agent/src/harness/session/types.ts";
// —— per-save 会话缝的宿主构造面（amio 阶段 1 回填：storage.sessionManager 缝已修入
// assemble.ts:110，但宿主侧无法构造 SessionManager/OPFS StorageBackend——两者已在
// bundle 内（assemble 缺省路径自身消费），此处仅补 runtime 转出，零新增打包内容）——
export { SessionManager } from "../../coding-agent/src/core/session-manager.ts";
export type { RpcExtensionUIRequest, RpcExtensionUIResponse } from "../../coding-agent/src/modes/rpc/rpc-types.ts";
export type { BrowserSqliteDatabaseFactoryOptions } from "../../memory/src/driver-browser.ts";
// —— 记忆 sqlite 工厂的宿主构造面（amio 阶段 4b 回填：宿主需以 {vfs:"opfs"} 真路径
// VFS 形状注入 storage.sqliteFactory（04-D §4.3 C7 定稿）——缺省工厂（sahpool）仍是
// assemble 缺省路径的兜底，此处仅补 runtime 转出，零新增打包内容）——
export { createBrowserSqliteDatabaseFactory } from "../../memory/src/driver-browser.ts";
export {
	type CreatePiHarnessOptions,
	createPiHarness,
	type PiHarness,
	type PiHarnessLlmOptions,
	type PiHarnessStorageOptions,
	type PiHarnessToolsOptions,
} from "./assemble.ts";
// —— 能力契约转出（Impl-A 定稿形状，negotiate 为唯一构造点）——
export type { BrowserHarnessEnv, Capabilities, HarnessEnv, NodeHarnessEnv } from "./capabilities.ts";
// —— 入口工厂与选项面 ——
export {
	type BrowserExecutor,
	type BrowserExecutorOptions,
	type BrowserSessionCommands,
	ExecutorBootstrapError,
	type ExecutorSessionTimeouts,
	startBrowserExecutor,
} from "./executor.ts";
// —— 扩展 UI 接缝（19 号 §2.2/§2.3：宿主回调工厂 + wire 类型 type-only 转出，U2 裁决——
// type-only 打包期擦除，无 rpc 运行时进包风险）——
export { createHostExtensionUIContext, type HostExtensionUiHandlers } from "./extension-ui.ts";
// —— coding-agent 纯核类型转出（12-C 已落地：类型权威 = extensions/types.ts；api.ts 为运行时核）——
export type {
	ExtensionFactory,
	ExtensionMode,
	ExtensionUIContext,
	LoadExtensionsResult,
	Skill,
	ToolDefinition,
	ToolName,
} from "./reexports.ts";
// —— 状态装配面（Impl-B 定稿类型，经 pi-agent-core storage-backend 转出）——

// —— browser-safe generic state merge helper ——
export { mergeStateDefaults } from "../../coding-agent/src/state/merge.ts";
export type { HarnessStores, StateLocks, StatePaths, StateStores, StorageBackend } from "./state-stores.ts";
