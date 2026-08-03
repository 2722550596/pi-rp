# Contributing to pi-rp

pi-rp welcomes contributions. This guide keeps things straightforward.

## Philosophy

pi-rp is not minimal. It bakes RP infrastructure directly into core. If a feature is useful for RP workflows and doesn't belong in an extension, it belongs here. When in doubt, open an issue to discuss.

## Before submitting

```bash
npm run check
./test.sh
```

Both must pass.

## Issues

- Use a clear title that describes the problem or request.
- Include steps to reproduce for bugs.
- Explain why the change matters for RP use cases.
- Keep it concise.

## Pull requests

- Keep PRs focused on one change.
- Follow the code conventions in `AGENTS.md`.
- Do not edit `CHANGELOG.md` — maintainers handle that.
- If you're adding a new provider to `packages/ai`, see `AGENTS.md` for required tests.

## Questions?

Open an issue or ask on [Discord](https://discord.com/invite/3cU7Bz4UPx).