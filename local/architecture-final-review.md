# Architecture Final Review — pi-rp packages/coding-agent (uncommitted refactor)

Reviewer: CleanReview (re-review; original reviewer process died mid-review). Findings verified and fixed by orchestrator.
Date: 2026-08-14
Method: static reading only (no builds/tests run by the reviewer per constraints). Orchestrator ran npm run check + targeted tests after fixes.

## Verdict
overall_correctness: 0.92 (after fixes; 4 findings addressed)
confidence: 0.85

## Findings

### F1 [P1] Stale tests invoke deleted InteractiveMode methods → TypeError at runtime
- test/interactive-tui.test.ts ("InteractiveMode copy confirmation", 2 tests) called `copyCommandPrototype.handleCopyCommand.call(...)`; `handleCopyCommand` was deleted (replaced by registry /copy).
- test/suite/regressions/5943-session-start-notify.test.ts:469 & :508 called `interactiveModePrototype.handleReloadCommand.call(context)`; method renamed to `runReload`.
- Both files were unmodified in the work tree; vitest default include runs them → TypeError.
- **Also found while fixing**: the migration dropped the fullscreen flash confirmation — old `handleCopyCommand` flashed "Copied!" on `TuiAltScreen`; the new `copyCommand` unconditionally used a status line.
- Fix (applied):
  - Added `flash(message)` to the `CommandView` contract (slash-commands.ts); TUI adapter `showCommandFlash` flashes on `TuiAltScreen`, falls back to a status line in regular mode (interactive-mode.ts).
  - `copyCommand` now calls `ctx.view.flash("Copied!")` (builtins.ts).
  - Rewrote the copy tests: command-body contract tests (view.flash delegation + error path) plus adapter tests for the fullscreen-flash / regular-status behavior via prototype.call.
  - 5943 test: `handleReloadCommand` → `runReload` (method body identical, rename-only).

### F2 [P2] /compact runs immediately during compaction → parallel compaction
- The submit-handler compaction branch now dispatches ALL registry commands immediately (previously only extension commands; everything else queued).
- `compactCommand` had no isCompacting guard (reroll/continue do).
- `compact()` aborts the agent run, then replaces `_compactionAbortController` and starts a second compaction in parallel with the in-flight one; both append compaction entries (transcript corruption). `abort()` does not cancel compaction controllers.
- Fix (applied): `compactCommand` guards `isStreaming || isCompacting` like rerollCommand/continueCommand (builtins.ts).

### F3 [P3] Extension-driven navigateTree still manually rebuilt the chat (double rebuild with leaf_changed)
- interactive-mode.ts commandContextActions.navigateTree cleared + called renderInitialMessages after session.navigateTree, which now emits leaf_changed → event handler rebuilt again.
- Fix (applied): removed the manual clear + render; relies on the leaf_changed event (same as the tree-selector path).

### F4 [P3] CONTEXT.md claimed entry_edited → "node update"; implementation does full chat rebuild
- Fix (applied): CONTEXT.md now says "chat rebuild (no entry→component index; a rebuild is the safe node refresh)".

## Contract checklist verdicts (a-n)
a. EXTENSION CONTRACTS — VERIFIED. runner.ts untouched. types.ts diff additions-only (on() overloads + event interfaces). registerCommand/registerShortcut/registerSlot/registerMacro signatures identical to HEAD.
b. AgentSessionEvent additions-only — VERIFIED. Dispatch: runner emit() routes by handlers.get(event.type); interactive-mode handleEvent explicit cases; toJsonEvent passes non-message_update events through unchanged.
c. LLM context byte-identical for default preset — VERIFIED. chatHistoryIndex position-based (same index for built-in chat-history slot); default preset contains no {{lastUserMessage}} and no slot renderer uses it; expandMacros diagnostics only for non-keep policies (default: "keep"); compileSystemPrompt = system-role view of the same pipeline.
d. Unknown /x → plain message fallback — VERIFIED (tryDispatchRegistryCommand returns false → normal submission; no error).
e. Non-command routing preserved — VERIFIED: /quit, !/!! bash before registry; compaction queue + steer/followUp still handled (registry commands now execute immediately in those branches — deliberate; destructive commands carry their own guards).
f. Deleted symbols zero refs — VERIFIED: compilePromptMessages, applyAllRegexEffects, _hasToolCallParts, _rebuildPresetTemplates, getPathCommandArgument, handleCloneCommand, handleImportCommand — no remaining references (src + test).
g. reroll leaf_changed AFTER state/schema restore; navigateTree shares _moveLeafAndRestoreState — VERIFIED.
h. RPC reroll exactly one response, fire-and-forget documented — VERIFIED.
i. builtins.ts: no this. refs; only TUI-adjacent import is modes/interactive/model-search.ts (accepted) — VERIFIED.
j. Residual manual re-render — FIXED (F3 was the only residual; tree selector, editMessage, reroll, preset paths all event-driven).
k. Autocomplete rich items — VERIFIED.
l. Tests non-empty assertions — VERIFIED.
m. registerSlot signature unchanged; zero callers of dead prompt-preset code — VERIFIED.
n. CHANGELOG/CONTEXT match implementation — F4 fixed; CHANGELOG entries match.

## Known fixes from prior round — all verified correct
1. syncExtensionCommands skips clear+register on zero commands + regression test.
2. Easter-egg payloads explicit.
3. Extension autocomplete async + rich CommandCompletion mapping.
4. app.session.new restores editor.setText("") before dispatch.
5. import selector case uses void.

## Accepted tradeoffs — none re-reported.
