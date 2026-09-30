# Changelog

## [Unreleased]

### Added

- TEMP 自动整理 autoTidy(`memory.temp.autoTidy`,默认开):TEMP 阈值命中 → 跨进程互斥锁下后台起 TidyRunner(pi-agent-core `agentLoop` + 全套 12 记忆工具,独立 tidyCtx 署名 `temp-tidy`,无会话锚),fire-and-forget 不阻塞回合;tidy 最终回复文本即简报,经 `rp-notify` `triggerTurn:false` 投递,失败(超时/轮数上限/无模型/空简报等)降级为现有手动 notify,禁用或 host 无 side-stream 原语时保持现状手动通知。提示词经 `hiddenOverrides.tempTidy.{systemPrompt,taskPrompt}` 覆写(空白/缺省字段级落内置默认;`{temp_list}`/`{max_turns}` replace-if-present),配置 `enabled`/`model`/`maxTurns`/`timeoutMs` 字段级容错。
- TEMP 导航缺陷修复(全 domain 通用):`recall("<domain>://")` 域根虚拟视图(域根不再"未找到记忆",depth/max_nodes 语义与普通节点一致,浏览不触 access time);stub 类目 recall 渲染子树并恢复记账(替换早退黑洞);`MEM://index/<domain>` 列出 stub 类目并计非 stub 子代(`（类目，N 条）`/`（类目，空）`);非 stub recall 渲染字节不变(`includeStubs` 默认 false)。
- Agent-readable audit view: `recall` now exposes read-only `MEM://audit[/<event>/<N>]` and exact `MEM://audit/id/<ID>` queries with full `details`; audit reads do not append another audit row. Truncated TEMP tidy briefings carry the exact completion-row URI, and the default tidy prompt/tool description teach agents how to use it.

### Changed

- Disclosure recall channel: the 想起条件 is embedded on its own (`memory_embeddings` row at `seg_index = -1`, cached against a hash of the disclosure text itself) and fused with the body view in rank space via RRF (k=30, pool-max normalized, `VEC_ABS_FLOOR = 0.3` absolute guard) — associative queries whose wording shares nothing with the body now surface their target (elias-benchmark MRR 0.350 → 0.540, top-3 33% → 73%) while descriptive queries are unaffected. Databases without disclosure signals fall back to the legacy ordering bit-for-bit.
- Injection breaker (opt-in, `memory.recall.breaker`): before injecting, the fused top-8 candidates are reranked with `BAAI/bge-reranker-v2-m3` and injection is skipped entirely when the best score is below `tau` (default 0.01) — cross-domain prompts (code, science) no longer fire memories through register similarity, which `MIN_SCORE` cannot gate (score bands of relevant and unrelated queries fully overlap). Reranker outages fail open; breaks leave a `recall_breaker` audit row.
- Injection selector (opt-in, `memory.recall.select`, needs `TYPEAFE_API_KEY`): TypeSafe Jev judges each fused top-8 candidate — "does injecting this memory right now actually matter to this exchange" — and only candidates clearing `tau` (default 0.6) inject. Unlike the breaker's register check, Jev reads the arc: elias-benchmark kept 8/8 targets, recalled whole storylines together (all four warm_water nodes), and suppressed duplicate content domains and unrelated monologues. Implies the breaker; fails open without a key.

### Changed

- `self-reflection` default autoretain task now lands in the `TEMP` domain (dynamic buffer) instead of `meta` — reflection drafts join the TEMP tidy loop (consolidate away / forget) instead of piling up in the meta tree. The seeded `meta://` root copy is now "Meta domain (consolidated themes)".
- `memorize` / `revise` / `associate` / `consolidate` `when` guidance now teaches the write-time trigger protocol: anticipate the future cue (a superordinate anchor or a strongly-predictive scene), never restate the body, avoid over-general conditions.
- Tool guidance for the unused-by-default structural tools: `associate` (build an edge when a new memory and an existing one share a "thinking of A always brings B" arc), `trigger` (register distinctive proper nouns of long memories so they survive body dilution), `awaken` (keep the wake list a working set, not an archive). Autoretain's JSON contract now carries the same disclosure protocol for its side-LLM products.
