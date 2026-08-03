# Upstream changes: packages/evals

- Commits: 27 / Files: 19 (+2055/-0 最终形态；中途删了 pi-ai-compat.ts + 3 个旧 dep)
- 首次引入于: `eafe11fb9 feat(coding-agent): add vitest eval harness (#7085)`（v0.82.1 开发期）

## 核心变化

### 1. 全新的 eval 包（此前不存在）
整个 `packages/evals/` 是上游在 v0.82.1 期间从头新建的包，名为 `@earendil-works/pi-evals`（private），npm 上不发布。包含 Pi Coding Agent 的评估基础设施：harness、smoke 测试、extension 评估、comparative eval 框架。

### 2. 抛弃 harness-pi-ai 及 legacy registry 别名（关键 commit: 6173017a7）
最初的 eval harness 依赖 `@vitest-evals/harness-pi-ai@0.15.0`，并且声明了 `@mariozechner/pi-ai` 和 `@mariozechner/pi-agent-core` 等 legacy npm alias 作为 peer dep。这导致 `sync-versions.js` 把它们和当前 monorepo 包做 lockstep 版本绑定，每次发版时 npm 找不到未发布的新版本而失败。

修复：彻底删除 `@vitest-evals/harness-pi-ai`、所有 `@mariozechner/*` npm alias，以及 shim 文件 `src/pi-ai-compat.ts`。改用 `createHarness` 从 `vitest-evals` core 直接构建，Pi 的 agent 生命周期代码自维护。

### 3. Comparative eval 框架（v0.83.0 密集迭代）
引入 `evalHarnessTable()` 生成 baseline/candidate 的 harness 组合表，与 Vitest 的 `describe.for()` 原生集成。每个 test case 自动按输入 hash 分组，支持多次 repetition。Reporter（`reporter.ts`）在 test run 结束后自动汇总 pass-rate lift、token delta、latency delta、estimated cost delta 并生成彩色终端报告。

### 4. Extension authoring eval
`src/extensions.eval.ts` 实现了完整的 extension 创建 + reload + 使用流程的评估。Judge 检查：(a) 是否 import 了 canonical `@earendil-works/pi-coding-agent`，(b) 是否误用了 legacy `@mariozechner` 包名，(c) 是否误用了 `@sinclair/typebox` 而非 `typebox`，(d) hello tool 是否注册成功并被成功调用。

### 5. Session 快照与 source artifact 管理
每次 eval run 后自动 snapshots Pi session JSONL 并注册为 Vitest artifact（`@earendil-works/pi-evals:session`）。Extension 等 eval 还支持 recording source artifact（`@earendil-works/pi-evals:source`）。所有 artifact 持久化到 `PI_EVAL_ARTIFACT_DIR` 目录。

## 关键文件与符号改动

| 文件 | 说明 |
|------|------|
| `src/pi-harness.ts` | 核心。导出 `createPiCodingAgentHarness()`、`resolveModelSelection()`、`PiCodingAgentInput`、`PiCodingAgentHarnessOptions`、`PiCodingAgentHarnessWithOutput<TOutput>`。内部用 `createAgentSessionFromServices()` 创建隔离 session，支持 string 或 `Array<{type:"prompt"|"reload"}>` 作为输入，自动 clean up tmpdir。 |
| `src/extensions.eval.ts` | Extension 评估用例。导出 `createExtensionAuthoringHarness()`、`ExtensionAuthoringOutput`（含 `extensionSource`、`loadedExtensions`、`extensionErrors`、`response` 等）。`ExtensionAuthoringJudge` 用确定性评分。 |
| `src/vitest-evals/artifacts.ts` | `recordEvalSessionArtifact()`、`recordEvalSourceArtifact()`、`persistEvalArtifactReferences()`。定义 `PiSessionAttachment`、`SourceAttachment`、`PiSessionArtifact`、`SourceArtifact` 类型。通过 `declare module "vitest"` 扩展 `TestArtifactRegistry`。 |
| `src/vitest-evals/harness-table.ts` | `evalHarnessTable()` — 核心 comparative eval 原语。支持 `{baseline, candidate, repetitions}` 和 `{baseline, candidates, repetitions}` 两种签名。内部 `deriveInputKey()` 用 SHA-256 hash 或显式 `input.id` 做分组。 |
| `src/vitest-evals/summary.ts` | `summarizeHarnessComparisons()`、`formatHarnessComparisonReport()` — 统计 lift、token/latency/cost delta，输出彩色终端报告。 |
| `src/vitest-evals/reporter.ts` | `EvalHarnessReporter` 实现 Vitest `Reporter` 接口。在 `onTestCaseResult` 中 append runs.jsonl，在 `onTestRunEnd` 中调用 `summarizeHarnessComparisons` + `formatHarnessComparisonReport`。 |
| `src/vitest-evals/setup.ts` | `afterEach` hook，自动调用 `recordEvalSessionArtifact()`。 |
| `src/smoke.eval.ts` | Smoke test：`createPiCodingAgentHarness({ noTools: "all" })`，验证 basic prompt 端到端可用。 |
| `scripts/run-evals.mjs` | CLI runner。接受 `--provider`/`--model`，传递给 vitest，自动建 artifact dir。 |
| `package.json` | `@earendil-works/pi-evals`（private）。当前 devDeps: `pi-ai`, `pi-coding-agent`, `vitest-evals@0.15.0`, `vitest@4.1.9`。 |

### 已删除的文件/符号（在 6173017a7）
- `src/pi-ai-compat.ts` — 仅 re-export `@earendil-works/pi-ai` + `completeSimple`
- devDeps 中删除: `@vitest-evals/harness-pi-ai`, `@mariozechner/pi-ai` (npm alias), `@mariozechner/pi-agent-core` (npm alias)

## 新功能 / 删除的功能

**新增：**
- `createPiCodingAgentHarness()` — Pi agent 的 vitest-evals harness 工厂
- `evalHarnessTable()` — comparative eval 的 harness 组合器
- `EvalHarnessReporter` — vitest reporter，自动生成对比报告
- `recordEvalSessionArtifact()` / `recordEvalSourceArtifact()` — artifact 管理
- `summarizeHarnessComparisons()` / `formatHarnessComparisonReport()` — 统计与报告格式化
- `resolveModelSelection()` — 显式/env 模型选择
- `run-evals.mjs` — eval 专用 CLI runner
- Extension authoring eval + `ExtensionAuthoringJudge`
- Smoke eval

**删除：**
- `@vitest-evals/harness-pi-ai` 依赖（外部的 Pi agent harness 包装器）
- `pi-ai-compat.ts` shim
- 所有 `@mariozechner/*` legacy registry alias

## Breaking / API 变化

此包是 private 的，不对外暴露 API。但内部 API 变化：
- `createPiCodingAgentHarness()` 从基于 `@vitest-evals/harness-pi-ai` 改为基于 `vitest-evals` 的 `createHarness`
- 旧的 `harness-pi-ai` 提供的 agent lifecycle plumbing 和 tool replay（未使用）被移除，Pi harness 现在自己管理 `AgentSession` 生命周期

## 与本 fork 的重叠

**无。** 本 fork 的 `packages/evals/` 目录不存在，且 `git diff --stat 9e7fce70a..main -- packages/evals` 返回空。上游的整个 evals 包对我们来说是纯增量。

## 合入注意点

1. **纯新增，无冲突**：`packages/evals/` 在本 fork 中不存在任何文件，git merge 不会触发冲突。
2. **依赖检查**：需要确认本 fork 的 `packages/ai` 和 `packages/coding-agent` 是否有上游 evals 依赖的 API：
   - `@earendil-works/pi-ai` — `contentText` 导出
   - `@earendil-works/pi-coding-agent` — `createAgentSessionFromServices`、`createAgentSessionServices`、`AgentSession`、`ModelRuntime`、`SessionManager`、`SettingsManager`、`CreateAgentSessionOptions`、`ExtensionRunner.getExtensionPaths()`
   - 如果本 fork 修改了这些 API 的签名或行为，eval 运行时会失败。
3. **sync-versions.js**：上游在此 commit 区间也修改了 `scripts/sync-versions.js` 和测试（去掉了对 legacy alias 的处理）。如果本 fork 也改了 `sync-versions.js`，需要手动合并。
4. **`package-lock.json`**：drop commit 删除了 106 行 lock 条目（legacy alias 相关）。合入后需要重新 `npm install`。
5. **仅 assessment 用途**：此包不参与 build/产物，仅开发者运行 eval 时使用。对 Pi 最终用户零影响。
