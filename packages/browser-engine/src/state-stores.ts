/**
 * 状态装配面（15-F §3.3 `stores: StateStores`；契约 §6 / 11-B 四缝）。
 *
 * Impl-B 已落地（2026-09-30）：类型权威 = packages/agent/src/harness/env/storage-backend.ts
 * （StateStores = HarnessStores 别名，经类型深路径转出；StorageBackend/StateLocks/StatePaths
 * 亦在 pi-agent-core 主 barrel 公开）。占位接口已删除。
 *
 * Wave 3 S3 缺省装配输入（Impl-B 回执）：browser ⇒ `OpfsStorageBackend.create(root)` +
 * `flush()`（镜像 write-through：hydrate /state → 同步镜像 → 串行异步落盘；无 worker——
 * 11-B §5 createSyncAccessHandle 草图不可实现已申报，crash 丢失窗口=flush 前）；
 * StatePaths 缺省 = BROWSER_AGENT_DIR（/state/agent）；cwd 缺省 = BROWSER_DEFAULT_WORKSPACE
 * （/workspace/default，多工作区=平级目录）。
 */
export type {
	HarnessStores,
	StateLocks,
	StatePaths,
	StateStores,
	StorageBackend,
} from "../../agent/src/harness/env/storage-backend.ts";
