<p align="center">
  <a href="https://pi.dev">
    <img alt="pi logo" src="https://pi.dev/logo-auto.svg" width="128">
  </a>
</p>

<p align="center">
  <b>English</b> | <a href="README.zh-CN.md">简体中文</a>
</p>

# pi-rp — Pi for Role-Playing

**pi-rp** is a deep fork of [pi-coding-agent](https://github.com/earendil-works/pi) that bakes RP infrastructure directly into the agent core. It is to role-playing what [Pi for IDE](https://github.com/can1357/oh-my-pi) is to IDE integration: a purpose-built agent that ships with the primitives RP creators need, without asking them to build everything from scratch.

## Why core, not extensions?

Pi's extension system is powerful, but some primitives are too fundamental to live behind a `pi -ne` flag. Modular prompt presets, subagent dispatch, and runtime knowledge-base loading are infrastructure that every RP extension would depend on — if they can be disabled, they can't be relied on. pi-rp moves these into core so the ecosystem builds on bedrock, not sand.

The goal is not to replace Pi's extension model. It is to provide the layer that makes RP extensions worth writing in the first place.

## What pi-rp adds

### Implemented

| Feature | Description |
|---------|-------------|
| **Prompt preset system** | JSON-based modular prompt stacks under `.pi/prompt-presets/`. Replace, append, or prepend system prompts. 13 built-in slots, macro engine (`{{date}}`, `{{tools}}`, custom macros), regex rules, hidden overrides for compaction and continue prompts. `/preset [id\|none]` to activate or disable, `/reload` to re-read preset files, `/prompt`. ExtensionAPI hooks for `registerSlot()` / `registerMacro()`. See [prompt-presets](packages/coding-agent/docs/prompt-presets.md). |
| **`/reroll`** | Regenerate the last assistant reply. Works with branching and tree navigation. |
| **`/continue`** | Force the agent to keep generating regardless of message state. |
| **Live message editing** | Press `e` in `/tree` to edit any message content in-place. |
| **State validation** | Schema-based structural constraints (TypeBox/JSON Schema) and custom validators for conversation state. `/schema list/load/unload/strict`. See [state-schemas](packages/coding-agent/docs/state-schemas.md). |
| **State management** | `state_update` and `get_state` tools for LLM-driven state read/write. Persisted in session JSONL. `/state` command for viewing current state. See [state-schemas](packages/coding-agent/docs/state-schemas.md). |
| **Native Subagent** | Native in-process task delegation to delegatable prompt presets (`delegatable: true`). Core `subagent` & `subagent_profiles` tools for LLM delegation, `/subagent` command in TUI. Minimal default tool set (`read`, `grep`, `find`, `ls`, `bash`), filtered by preset policy, with bounded result output. See [prompt-presets](packages/coding-agent/docs/prompt-presets.md#subagent-delegation). |

### Planned

| Feature | Description |
|---------|-------------|
| **Knowledge base** | `.knowledge/` directory with Markdown + frontmatter. `lookup` tool for LLM search. `/knowledge` command for switching. |
| **Compact + recall** | Smarter compaction that archives rather than discards. `recall` tool retrieves compacted content. |
| **Memory system** | Full memory tools — agent can actively remember and retrieve. |
| **Provider improvements** | `/login` for custom providers. Provider catalog cleanup. |

## Comparison: SillyTavern and the RP gap

Pi has better extensibility, better models, and a more capable agent runtime than any RP frontend. Yet the RP ecosystem around Pi is nearly nonexistent. The reason is simple: **native Pi is a coding agent.** It ships with zero RP primitives. Creators who want to build RP experiences on Pi must first reimplement reroll, prompt composition, state tracking, knowledge retrieval, and memory — the same infrastructure SillyTavern has provided for years.

SillyTavern's advantage is not its architecture. It is that it gives creators a complete, working foundation on day one. pi-rp aims to be that foundation for Pi.

## Backward compatibility

pi-rp does not remove or break Pi's existing functionality. It is a superset:

- All Pi commands, tools, and keybindings work as before.
- The coding agent workflow is fully preserved — use pi-rp for software development, then switch to RP mode.
- Pi community packages and extensions remain compatible. The extension system is untouched; pi-rp only adds to core.
- New users navigate onboarding, read docs, browse source, and write extensions with the same agent that runs their RP sessions.

## Quick start

```bash
git clone https://github.com/2722550596/pi-rp.git
cd pi-rp
npm install --ignore-scripts
npm run build
./pi-test.sh
```

## Development

```bash
npm run check        # Lint, format, and type check
./test.sh            # Run tests (skips LLM-dependent tests without API keys)
./pi-test.sh         # Run pi-rp from sources
```

## Relationship with upstream

pi-rp tracks upstream Pi but does not actively merge. RP features are developed directly in this monorepo and are not upstreamed. The goal is a focused RP distribution, not a set of patches to maintain.

## Star history

## Star History

<a href="https://www.star-history.com/?repos=2722550596%2Fpi-rp&type=date&legend=top-left">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=2722550596/pi-rp&type=date&theme=dark&legend=top-left&sealed_token=M7qUeNHsq2vjzE1YJGRqbMiuTcNCsCeWZ7tbHjj9igeb29mZBJcRa0XZM0B_KUBUNPNmUiQw-ZBFIaDWsXetAqjGXy39JXDrJXLwESuft7hcx4sE75zINjvcRTIg1xR5tKAejEGNng_l6yTayhgOwP6H8INHe4zT1HKDnMvWiUumEceTK-ULJow1ZU85" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=2722550596/pi-rp&type=date&legend=top-left&sealed_token=M7qUeNHsq2vjzE1YJGRqbMiuTcNCsCeWZ7tbHjj9igeb29mZBJcRa0XZM0B_KUBUNPNmUiQw-ZBFIaDWsXetAqjGXy39JXDrJXLwESuft7hcx4sE75zINjvcRTIg1xR5tKAejEGNng_l6yTayhgOwP6H8INHe4zT1HKDnMvWiUumEceTK-ULJow1ZU85" />
   <img alt="Star History Chart" src="https://api.star-history.com/chart?repos=2722550596/pi-rp&type=date&legend=top-left&sealed_token=M7qUeNHsq2vjzE1YJGRqbMiuTcNCsCeWZ7tbHjj9igeb29mZBJcRa0XZM0B_KUBUNPNmUiQw-ZBFIaDWsXetAqjGXy39JXDrJXLwESuft7hcx4sE75zINjvcRTIg1xR5tKAejEGNng_l6yTayhgOwP6H8INHe4zT1HKDnMvWiUumEceTK-ULJow1ZU85" />
 </picture>
</a>

## License

MIT — same as upstream Pi.
