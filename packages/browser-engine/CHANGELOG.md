# Changelog

## [Unreleased]

### Fixed

- Resolve the public object-tree and truncation subpaths from workspace source when building the browser package in a clean checkout, without requiring prebuilt Node packages.

- Browser harness assembly now accepts an optional model and no LLM transport for native offline sessions; generation is explicitly rejected, while configuring a model without an LLM transport remains an assembly error.

### Added

- Added `startBrowserExecutor()` for hosting a browser-local Pi session through an outbound executor transport and sharing it with PiServer participants. See [Browser session collaboration](../coding-agent/docs/browser-session-collaboration.md).
- Added browser harness custom-tool and custom-message policy injection, session event subscriptions, session-scoped prompt-slot rendering, side requests, and an in-memory multi-session host with cancellable host-question routing.
