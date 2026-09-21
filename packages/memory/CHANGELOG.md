# Changelog

## [Unreleased]

### Added

- Disclosure recall channel: the 想起条件 is embedded on its own (`memory_embeddings` row at `seg_index = -1`, cached against a hash of the disclosure text itself) and fused with the body view in rank space via RRF (k=30, pool-max normalized, `VEC_ABS_FLOOR = 0.3` absolute guard) — associative queries whose wording shares nothing with the body now surface their target (elias-benchmark MRR 0.350 → 0.540, top-3 33% → 73%) while descriptive queries are unaffected. Databases without disclosure signals fall back to the legacy ordering bit-for-bit.
- Injection breaker (opt-in, `memory.recall.breaker`): before injecting, the fused top-8 candidates are reranked with `BAAI/bge-reranker-v2-m3` and injection is skipped entirely when the best score is below `tau` (default 0.01) — cross-domain prompts (code, science) no longer fire memories through register similarity, which `MIN_SCORE` cannot gate (score bands of relevant and unrelated queries fully overlap). Reranker outages fail open; breaks leave a `recall_breaker` audit row.

### Changed

- `memorize` / `revise` / `associate` / `consolidate` `when` guidance now teaches the write-time trigger protocol: anticipate the future cue (a superordinate anchor or a strongly-predictive scene), never restate the body, avoid over-general conditions.
- Tool guidance for the unused-by-default structural tools: `associate` (build an edge when a new memory and an existing one share a "thinking of A always brings B" arc), `trigger` (register distinctive proper nouns of long memories so they survive body dilution), `awaken` (keep the wake list a working set, not an archive). Autoretain's JSON contract now carries the same disclosure protocol for its side-LLM products.
