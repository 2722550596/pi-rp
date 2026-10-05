/**
 * @earendil-works/pi-browser —— pi harness 浏览器/hosted 剖面分发入口（契约 §9 / 15-F §3.3）。
 *
 * 下游入口：一个包；createPiHarness 装配浏览器/hosted harness，startBrowserExecutor 将
 * 该 harness 的 AgentSession 接入 PiServer 执行者通道。
 * 不可见面：coding-agent 主 barrel、磁盘布局（getAgentDir）、auth-storage、jiti 磁盘通道、
 * modes/interactive、rpc stdio。
 */

/// <reference path="./deps.d.ts" />

export type { ExecutionEnv, FileSystem, ObjectStore, Shell } from "@earendil-works/pi-agent-core";
export { InMemorySessionRepo, streamProxy } from "@earendil-works/pi-agent-core";
export {
	BROWSER_AGENT_DIR,
	createBrowserHarnessEnv,
	createHostedHarnessEnv,
	createOpfsObjectStore,
	OpfsFileSystem,
	OpfsStateLocks,
	OpfsStorageBackend,
	opfsStatePaths,
} from "@earendil-works/pi-agent-core/web";
export type { AssistantMessage, Model, StreamFunction, ThinkingLevel } from "@earendil-works/pi-ai";
export type { ByteTransportFactory } from "@earendil-works/pi-client";
export { JsonTree } from "@earendil-works/pi-coding-agent/objects";
export {
	EXECUTOR_PROTOCOL_VERSION,
	MAX_EXECUTOR_INBOUND_CHUNK_BYTES,
	MIN_ABORT_CONTROL_BYTES,
} from "@earendil-works/pi-protocol";
export type { SessionRepo } from "../../agent/src/harness/session/types.ts";
export { SessionManager } from "../../coding-agent/src/core/session-manager.ts";
export type {
	AgentSessionEvent,
	CustomTypePolicy,
	SessionCompactResult,
	SlotDefinition,
} from "../../coding-agent/src/index.ts";
export type { RpcExtensionUIRequest, RpcExtensionUIResponse } from "../../coding-agent/src/modes/rpc/rpc-types.ts";
export { mergeStateDefaults } from "../../coding-agent/src/state/merge.ts";
export type { BrowserSqliteDatabaseFactoryOptions } from "../../memory/src/driver-browser.ts";
export { createBrowserSqliteDatabaseFactory } from "../../memory/src/driver-browser.ts";
export type { AskBroker, HostQuestionRequested } from "./ask-broker.ts";
export { createAskBroker } from "./ask-broker.ts";
export type { PiHarnessLlmOptions, PiHarnessStorageOptions } from "./assemble.ts";
export type { BrowserHarnessEnv, Capabilities, HarnessEnv, NodeHarnessEnv } from "./capabilities.ts";
export type {
	BrowserAppendMessage,
	BrowserCustomTool,
	BrowserCustomTypePolicy,
	BrowserToolHandlerContext,
	MaybePromise,
} from "./custom-tools.ts";
export {
	type BrowserExecutor,
	type BrowserExecutorOptions,
	type BrowserSessionCommands,
	ExecutorBootstrapError,
	type ExecutorSessionTimeouts,
	startBrowserExecutor,
} from "./executor.ts";
export {
	type BrowserHarnessToolsOptions,
	type BrowserPiHarness,
	type CreateBrowserHarnessOptions,
	type CreatePiHarnessOptions,
	createPiHarness,
	createPiHarnessWithTools,
	type PiHarness,
	type PiHarnessToolsOptions,
} from "./extended-harness.ts";
export { createHostExtensionUIContext, type HostExtensionUiHandlers } from "./extension-ui.ts";
export type { HarnessEventEnvelope, HarnessEventError, HarnessEventListener } from "./harness-events.ts";
export { subscribeHarnessEvents } from "./harness-events.ts";
export {
	type CreatePiHarnessHostOptions,
	createPiHarnessHost,
	type PiHarnessHost,
	type PiHarnessHostEvent,
	type PiHarnessHostListener,
} from "./host.ts";
export type {
	ExtensionFactory,
	ExtensionMode,
	ExtensionUIContext,
	LoadExtensionsResult,
	Skill,
	ToolDefinition,
	ToolName,
} from "./reexports.ts";
export type { HarnessStores, StateLocks, StatePaths, StateStores, StorageBackend } from "./state-stores.ts";
