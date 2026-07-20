# pi-rp Architecture Notes

## Session Tree ↔ Agent State Sync

`SessionManager.branch()` 只移动 `leafId` 指针，**不会自动同步 `agent.state.messages`**。
任何改变路径的操作后必须显式重建：

```
sessionManager.branch(targetId)
const ctx = sessionManager.buildSessionContext()
agent.state.messages = ctx.messages
```

构建了 `_syncAgentStateFromSession()` 辅助方法来统一，避免后续bug。

## Trace vs. Turn

一次 agent loop = 一个 trace，由多个 turn（toolCall -> toolResult 对）组成。

| API | 用途 | 会产生 user message entry？ |
|---|---|---|
| `runAgentLoop()` (via `agent.prompt()`) | 新输入 | 会 -- emit message_start/end |
| `runAgentLoopContinue()` (via `agent.continue()`) | 从已有 user msg 继续 | 不会 |

`/reroll` 用 `continue()` 而非 `prompt()`，避免多余的 session 条目。

## 消息存储

每条 `user` / `assistant` / `toolResult` 在 JSONL 中是独立的 `SessionMessageEntry`，通过 `parentId` 形成链表。
一次 trace 在存储层面 = 从 user msg 到最终 assistant 的连续 entry 链。turn 级别的 toolResult 没有显式的 "trace 分组" 节点。

## 边界情况检查清单

- 空 session（无 entries）
- 最后一条是 assistant（正常 trace）
- 最后一条是 user（无回复 / abort / error）
- agent 正在 streaming 中（reroll/rewind 必须等 idle）
- 连续 reroll -- 每次 branch 到同一 user msg，不断 append 新 sibling