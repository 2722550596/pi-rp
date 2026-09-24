# 评审 A：跨文档一致性与契约遵守

> 评审代理 ReviewerA（scout）产出；因 write 设备限制由主代理代为落盘，内容未改动。总体判定：**不通过**（blocker 已在契约 §8 D 系列裁决）。

## 关键发现

- **A1 blocker**：M1 query schema 与 M3 pattern/keywords schema 冲突。【已裁决 B1，M1/M3 已修】
- **A2 blocker**：`guidanceFor`/`getGuidance`、`restore`/`restoreFromSession`、`recompute` 返回形状在 M1/M4 间命名不一致。【已裁决 D2】
- **A5 blocker**：M1 active 公式（tool_search 始终在 active）与 §7 无 folded 不注入自相矛盾。【已裁决 B2，已修】
- **A6 major**：M4 恢复只读 `deferred.addedToolNames`，遗漏 tool_search 的发现来源。【已裁决 D16】
- **A7 major**：M5 仍保留 `--reserve-tools`「覆盖/追加」未定。【已裁决 D9：覆盖】
- **A8 major**：R10 通知 owner 与注入时序悬空。【已裁决 D4/D5】
- **A10 major**：M3 eager 集合列举遗漏 allow 白名单。【已裁决 D10】
- **A11 major**：M1/M4 残留「建议用 discover 承担恢复」，违反 restore 超集入口。【已裁决 D7】
- **A13 blocker/major**：M3 execute discover 与 M2 消费 ToolResult 可能双刷新。【已裁决 D3】
- **A14 major**：动态 catalog 通知比较基准未定义。【已裁决 D5】
- **A15 major**：resume restore 与 M5 重算的 discovered 输入/顺序不闭合。【已裁决 D4（统一编排）】

## 事实表回查

源码抽查 15 处均与引用相符（含 agent / coding-agent / ai 的 deferred、session、settings、provider compat、工具注册事实）。
