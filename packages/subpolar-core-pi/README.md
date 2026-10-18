# `@subpolar/adapter-pi`

This package is the dependency-free execution boundary between Subpolar and Pi.
It exposes `createPiRunPort`, which creates one executor through an injected
factory for each run, passes the runtime context and a structured
`PiTranscriptProjection`, forwards JSON-safe normalized progress events, and
calls the executor's optional `dispose()` method before the run is released.

## Workspace setup

From the repository root, use Bun 1.3.14 and `bun install --frozen-lockfile`.
The hoisted workspace shares compatible dependencies, but incompatible versions
may still require nested copies. Do not install separately in this package.
See [Bun and multi-user operations](../../docs/bun-and-multi-user.md).

## Core port persistence boundary

`createPiRunPort` is intentionally transient. It does **not**:

- load the Pi SDK on package import (the explicit SDK factory loads it lazily);
- create, read, search, or write Pi JSONL session files or session directories;
- look up a session from `context.sessionId`;
- persist transcripts, run outcomes, or replay events; or
- decide tool policy, approvals, permissions, or audit outcomes.

A `sessionId` is only descriptive runtime context for the core port. Any prior
conversation must be supplied explicitly as the in-memory `transcript`
projection on the run request. `piAdapterCapabilities` advertises these core
port limits as `ephemeral` with persistence, replay, and durable-approval
support disabled.

The adapter calls the injected executor exactly for the current run and
supports an optional async `dispose()` hook. It does not assume a particular
Pi SDK API. `InMemoryPiExecutor` and `InMemoryPiSession` provide a small
in-process implementation for tests and for environments where the Pi SDK is
not installed; they retain the supplied projection only until disposal.

## Shared runtime and optional SDK integration

`createPiStatelessExecutor(factory, config, transcriptLoader?)` adapts the Pi port directly to `StatelessExecutor`, forwarding request/context, normalized events, abort signal, and `execution.tools`. A tool-enabled factory must route tool calls through this invoker; factories are trusted integration code, not a sandbox.

`createPiSdkExecutorFactory()` lazily loads the optional `@earendil-works/pi-coding-agent` SDK. The host owns its installation/version and credentials; there is no fallback to the in-memory echo fixture. A loader can be injected for tests. With `SUBPOLAR_RUNTIME_DATA_DIR` configured, the factory uses Pi's file-backed `SessionManager` under that private directory, keyed by a hash of the T3 ACP native session ID and checked against the session cwd on resume. Without that directory it remains in-memory. Both modes use `SettingsManager.inMemory`, disable tools and discovered resources, forward cancellation to `session.abort()`, extract assistant text, and dispose the session on completion/failure. The persisted Pi branch is runtime continuation state; T3 remains the thread/history authority.

Provider/model configuration may use the SDK's normal local credential/model files; session and outcome persistence still belong solely to host ports. Multi-user hosts must inject an owner-isolated `modelRuntime`, without ambient credential fallback. This adapter is not an OS sandbox. Subpolar Agent uses owned provider accounts and fails closed for unknown/custom inference; custom-provider CRUD does not imply inference support. Live authenticated execution is not covered by the deterministic adapter tests. Subpolar Agent still owns its richer SDK/tool/branch adapter; see `docs/progress-runtime-cli.md` for migration callsites.
