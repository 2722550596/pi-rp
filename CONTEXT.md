# CONTEXT.md — pi-rp Domain Language

Domain vocabulary for pi-rp, a deep fork of pi-coding-agent that bakes role-playing (RP) infrastructure into the agent core. Architecture-review decisions are recorded here as they crystallize; the 2026-08-13 review's designs (command registry, path-change events, compile collapse) are implemented — see the changelog for what landed.

## Session & tree

- **session** — one JSONL file (`~/.pi/agent/sessions/<cwd-encoded>/<timestamp>_<id>.jsonl`); header line + entry lines forming a tree.
- **entry** — one typed line in the session file: `message`, `custom_message`, `state`, `preset_change`, `schema_change`, `strict_change`, `model_change`, `thinking_level_change`, `compaction`, `branch_summary`, `label`, `session_info`, `custom`. Carries `id`/`parentId`.
- **tree / branch / leaf / path** — entries form a tree; **leaf** is the current insertion point; **branch** is the root→leaf path used for LLM context; **branching** re-points the leaf to an existing entry.
- **path-changing op** — any operation that rewrites the active path (reroll, tree navigation, fork, compaction). Contract: two-phase — mutate session state → UI sync → start agent run — and must restore state/schemas from the new path.
- **reroll** — regenerate the last assistant response: branch to the last user message, restore state, then run. Split into `reroll()` (mutate) + `startRerollRun()` (run).
- **continue / Continue.** — force generation regardless of last message state; strips trailing aborted/empty assistant messages from LLM context and injects a non-persisted "Continue." user message (`hiddenOverrides.continueText` overridable).
- **branch summary / branch_summary entry** — LLM summary of an abandoned path, attached at the navigation target.
- **fork** — extract a root→leaf path into a new session file.
- **compaction** — replace summarized history with a `compaction` entry (summary + `firstKeptEntryId`); the discarded transcript is currently unrecoverable (recall planned).
- **turn** — agent event span turn_start..turn_end; RP state snapshots persist at turn_end when dirty.
- **agent run / trace** — agent_start..agent_end span; multiple turns per run when queue/retry/compaction continue.
- **steering / followUp** — queued user messages during streaming; steer interrupts, followUp waits.

## State

- **state** — namespaced JSON conversation memory (game stats, inventory, flags); mutated by the `state_update` tool, ExtensionAPI, and RPC; persisted as full-snapshot `state` entries; top-level keys are namespaces.
- **namespace** — top-level state key governed by exactly one loaded schema; the unit of cross-process store files and strict-mode gating.
- **state op** — the mutation vocabulary: `add` (delta/append/set), `remove`, `replace`, `merge` (RFC 7396, null deletes); paths are dot notation or JSON Pointer.
- **schema** — TypeBox definition (or JSON Schema) per namespace, loaded from `.pi/schemas/*.ts`; defaults double as initial state seeding; load/unload recorded as `schema_change` entries; strict mode rejects uncovered paths.
- **custom validator** — per-namespace+path `.ts` function that can correct a value or reject a write; runs pre-write.
- **state entry** — the `state` session entry type carrying a full snapshot; branch restore replays the newest `state` entry on the active path.
- **cross-process state store** — optional opt-in overlay (`state.store: "file"` + `state.storeDir`): per-namespace `{revision, state}` JSON files with CAS commits; files are authoritative over session-restored values.

## Prompts

- **prompt preset** — JSON file (`.pi/prompt-presets/*.json`) defining a prompt stack: ordered items (block/slot), tool/skill resource policies, regex rules, hiddenOverrides, `delegatable`/model/thinkingLevel for subagent profiles; compiled by `compileSystemPrompt`/`compileMessages`.
- **item** — one unit in `preset.items`; **block** = static text with macro expansion; **slot** = named dynamic content rendered at its position.
- **slot** — named dynamic content source in a process-global registry (built-in vs extension custom); 13 built-ins; `chat-history` is a position marker — SlotRenderer carries an additive `position?: "chat-history" | "content"` (default content) and the compiler dispatches on position instead of name-matching; `registerSlot` signature unchanged, custom-slot extensions unaffected. Renderers may return `Promise<string>` when the slot declares `async: true`; presets with async slots compile through the async path (parallel item rendering, serial when `{{setvar}}`/`{{addvar}}` side-effecting macros are present), while the sync fast path (`compileMessagesSync` / static system-prompt rebuilds) renders them empty.
- **macro** — `{{name}}` or `{{name:params}}` expansion in block content; built-ins: date/time/cwd/lastUserMessage/tools/selectedTools/activeModel/setvar/addvar/getvar/trim/user. `{{lastUserMessage}}` derives from the last real user message in the compile path when `PromptRuntime.latestUserMessage` is unset (the 7 construction sites pass undefined); the synthetic "Continue." injection is structurally indistinguishable from a real user message, so it is not excluded (documented edge).
- **regex rule** — preset-level text transformation with stage (history/compiled), effect (outgoing/display/both/finalize), target (system/messages), scope filters.
- **hiddenOverrides** — preset fields replacing built-in behavior: continueText + the five compaction prompts; `branchSummaryPrompt` must survive the loader (was dropped).
- **resource policy** — allow/deny glob arrays on `preset.tools`/`preset.skills`; empty allow = deny-all.
- **prompt template** — markdown `/command` template with `$1`/`$@` substitution — distinct from prompt presets.

## Commands & input

- **slash command** — `/`-prefixed string; built-in catalog in `core/slash-commands.ts`; RP commands (reroll, continue, preset, state, schema, subagent, prompt, validator) are slash commands.
- **command registry** — single seam `name → {execute, autocomplete, usage, argHint}` in core, implemented by builtins, RP commands, and extension commands (extension `registerCommand` contract unchanged); dispatch, autocomplete, and /hotkeys consume it; unknown `/x` still falls through to a user message. Non-command routing (bash `!`/`!!`, compaction queue, steer/followUp) stays in the submit handler before registry dispatch. Command bodies live in `src/commands/` (mode-agnostic; shared by TUI and RPC).
- **CommandContext** — `{ args: string[], session: AgentSession, view: CommandView }`; command bodies expose the real AgentSession (shared by TUI and RPC — RPC mode has one) and a narrow view.
- **CommandView** — the view interface command bodies receive: `renderMessage`, `showSelector`, `showStatus`, `invalidateFooter`, `updateEditorBorder`; two adapters: InteractiveMode and the RPC responder (reroll).
- **keybinding** — named action (`app.tree.foldOrUp`, `app.tree.editMessage`…) mapped to default keys in `core/keybindings.ts`; single source of truth, user-overridable; extensions use a conflict-checked parallel channel.
- **selector** — modal overlay widget (tree/session/model/settings/trust).

## Runtime & extension surface

- **extension** — TS module exporting a factory `(pi: ExtensionAPI) => void`; loaded via jiti.
- **ExtensionAPI (pi)** — per-extension registration + action surface: 36 lifecycle events, registerTool/registerCommand/registerShortcut, registerSlot/registerMacro, state access, provider registration.
- **extension runner** — executes extensions; dispatches events to handlers in load order; resolves command/shortcut conflicts; mirrors agent events into extension events.
- **handler / hook** — an `on(event, handler)` subscription to a lifecycle event.
- **session events** — `AgentSessionEvent` union members `leaf_changed` / `entry_edited` / `preset_activated`, emitted synchronously AFTER mutation + state/schema restore completes (reroll, editMessage, navigateTree, setActivePreset — previously reroll/editMessage/preset emitted nothing; navigateTree emitted only extension-only `session_tree`); mirrored to extensions (via `_emitSessionEvent` → `_extensionRunner.emit`); `session_tree` stays during the transition. TUI rebuild granularity: `leaf_changed` → full chat rebuild, `entry_edited` → chat rebuild (no entry→component index; a rebuild is the safe node refresh), `preset_activated` → footer + editor border.
- **subagent** — in-process delegated agent run built from a delegatable preset; two entry points: the `subagent`/`subagent_profiles` LLM tools and programmatic `spawnAgent`; runs without extensions.
- **tool definition** — the shared LLM-tool contract (name/description/TypeBox parameters/execute/renderers); core, RP, and extension tools all implement it.
- **resource** — extensions/skills/prompts/themes resolvable from packages, settings entries, auto-discovery, or `resources_discover` extensions.
- **settings.json** — global + project merged config; `SettingsManager` owns load/merge/persist (lockfile-serialized).
