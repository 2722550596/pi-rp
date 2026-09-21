# Changelog

## [Unreleased]

### Added

- Disclosure recall channel: the 想起条件 is embedded on its own (`memory_embeddings` row at `seg_index = -1`, cached against a hash of the disclosure text itself) and fused with the body view in rank space via RRF (k=30, pool-max normalized, `VEC_ABS_FLOOR = 0.3` absolute guard) — associative queries whose wording shares nothing with the body now surface their target (elias-benchmark MRR 0.350 → 0.540, top-3 33% → 73%) while descriptive queries are unaffected. Databases without disclosure signals fall back to the legacy ordering bit-for-bit.

### Changed

- `memorize` / `revise` / `associate` / `consolidate` `when` guidance now teaches the write-time trigger protocol: anticipate the future cue (a superordinate anchor or a strongly-predictive scene), never restate the body, avoid over-general conditions.
