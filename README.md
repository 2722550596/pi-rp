<p align="center">
  <a href="https://pi.dev">
    <img alt="pi logo" src="https://pi.dev/logo-auto.svg" width="128">
  </a>
</p>

<p align="center">
  <b>English</b> | <a href="README.zh-CN.md">简体中文</a>
</p>

# pi-rp — Pi for Role-Playing

**pi-rp** is a role-playing-focused distribution of Pi with roleplay infrastructure built into the agent core. It keeps Pi's coding-agent workflow and extensible TypeScript ecosystem, while adding prompt composition, persistent character memory, session control, and host integration primitives for RP applications.

Use it as an interactive terminal agent, embed it through the SDK or RPC, or build a browser/hosted experience with host-provided storage and model access.

## What pi-rp adds

| Feature | What it enables | Documentation |
|---------|----------------|---------------|
| **Composable prompt presets** | Assemble system prompts from ordered blocks, slots, macros, filters, and regex rules. Async slots can load live data; presets can also define delegatable subagents. | [Prompt presets](packages/coding-agent/docs/prompt-presets.md) |
| **Opening presets** | Seed a session with an opening message and initial state from reusable JSON resources. | [Opening presets](packages/coding-agent/docs/opening-presets.md) |
| **Persistent memory system** | Store structured memories, aliases, associations, recall conditions, and source-linked conversation records in SQLite. Memory can be recalled into context, revised, and reconciled with session branching. | [Memory package](packages/memory/README.md) |
| **Memory browser** | Browse and edit memory databases in a local web UI, switch between multiple world/character databases, and restrict discovery to configured roots. | [Memory browser and security](packages/memory/README.md#24-记忆浏览器本地-web-界面) |
| **Native subagents** | Delegate work to in-process agents configured as prompt presets, with explicit tool policies and bounded results. | [Subagent delegation](packages/coding-agent/docs/prompt-presets.md#subagent-delegation) |
| **State schemas and validators** | Persist structured conversation state, validate updates against schemas, and add custom validation rules. | [State schemas](packages/coding-agent/docs/state-schemas.md) |
| **Branch-aware sessions** | Navigate, label, edit, reroll, and fork conversation branches while preserving session history and restoring state with the selected path. | [Sessions](packages/coding-agent/docs/sessions.md) |
| **RPC integration** | Control sessions over JSONL, including preset/model control, tree navigation, custom-message persistence, and affiliated-session context exchange. | [RPC mode](packages/coding-agent/docs/rpc.md) |
| **Tool search** | Fold eligible low-frequency tools out of model requests and let the model discover them when needed. | [Tool search](packages/coding-agent/docs/tool-search.md) |
| **Browser and hosted harness** | Run agent sessions with host-supplied resources, storage, and LLM access; browser profiles use workspace-scoped file tools rather than a general shell. | [SDK and hosted harness](packages/coding-agent/docs/sdk.md#browser-and-hosted-harnesses) |
| **Extensible display and runtime** | Add custom tools, commands, lifecycle handlers, display-time message transformations, and streaming-tolerant XML-like tag projections. | [Extensions](packages/coding-agent/docs/extensions.md) |

Pi's coding-agent features remain available alongside these additions: built-in providers, interactive TUI, skills, prompt templates, packages, session compaction, and custom providers. See the [coding-agent documentation index](packages/coding-agent/docs/index.md) for setup and the complete user guide.

## Why core, not extensions?

Pi's extension system is powerful, but some primitives need stable behavior across extensions and runtime modes. Prompt presets, session-state restoration, and native subagent support are part of the core so roleplay extensions can build on shared contracts instead of each implementing their own prompt and session machinery. The extension system remains the customization layer around those primitives.

## Quick start

To install from npm:

```bash
npm install -g --ignore-scripts @earendil-works/pi-coding-agent
pi
```

Authenticate with `/login` for a supported subscription provider, or set the provider's API key before starting. For source development:

```bash
git clone https://github.com/2722550596/pi-rp.git
cd pi-rp
npm install --ignore-scripts
npm run build
./pi-test.sh
```

See [Quickstart](packages/coding-agent/docs/quickstart.md) for a full first-run guide and [development docs](packages/coding-agent/docs/development.md) for contributor setup.

## Relationship with upstream

pi-rp builds on Pi's coding-agent runtime and tracks the upstream project, but RP-specific features are developed in this monorepo. The goal is a usable RP foundation that preserves Pi's existing coding-agent capabilities and extension model.

## Development commands

```bash
npm run check        # Lint, format, and type check
./test.sh            # Run tests
./pi-test.sh         # Run pi-rp from sources
```

## Star history

<a href="https://www.star-history.com/?repos=2722550596%2Fpi-rp&type=date&legend=top-left">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=2722550596/pi-rp&type=date&theme=dark&legend=top-left&sealed_token=M7qUeNHsq2vjzE1YJGRqbMiuTcNCsCeWZ7tbHjj9igeb29mZBJcRa0XZM0B_KUBUNPNmUiQw-ZBFIaDWsXetAqjGXy39JXDrJXLwESuft7hcx4sE75zINjvcRTIg1xR5tKAejEGNng_l6yTayhgOwP6H8INHe4zT1HKDnMvWiUumEceTK-ULJow1ZU85" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=2722550596/pi-rp&type=date&legend=top-left&sealed_token=M7qUeNHsq2vjzE1YJGRqbMiuTcNCsCeWZ7tbHjj9igeb29mZBJcRa0XZM0B_KUBUNPNmUiQw-ZBFIaDWsXetAqjGXy39JXDrJXLwESuft7hcx4sE75zINjvcRTIg1xR5tKAejEGNng_l6yTayhgOwP6H8INHe4zT1HKDnMvWiUumEceTK-ULJow1ZU85" />
   <img alt="Star History Chart" src="https://api.star-history.com/chart?repos=2722550596/pi-rp&type=date&legend=top-left&sealed_token=M7qUeNHsq2vjzE1YJGRqbMiuTcNCsCeWZ7tbHjj9igeb29mZBJcRa0XZM0B_KUBUNPNmUiQw-ZBFIaDWsXetAqjGXy39JXDrJXLwESuft7hcx4sE75zINjvcRTIg1xR5tKAejEGNng_l6yTayhgOwP6H8INHe4zT1HKDnMvWiUumEceTK-ULJow1ZU85" />
 </picture>
</a>

## License

MIT — same as upstream Pi.
