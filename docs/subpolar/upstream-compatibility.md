# Upstream compatibility

## T3 upstream merge

The local `upstream/main` reference was refreshed on 2026-10-18 to `c60afa29f154a663c620f31138639d1295644f0a` and merged by `68c8e0f828084f474dcda6cbcb32aa17ff8c204b`. The upstream tip is the second parent of that merge commit. This merge includes the latest upstream server, client, contract, dependency, and workspace changes. Local Docker deployment and Subpolar integration commits remain on the branch.

The older SQLite layer change was superseded by upstream's current `apps/server/src/persistence/Sqlite.ts`, which already configures WAL, `busy_timeout`, and `synchronous = NORMAL`. The container readiness endpoint was ported into the current server HTTP route composition.

## Client and provider compatibility

The current Subpolar changes do not modify `apps/web`, `apps/desktop`, `apps/mobile`, or `packages/contracts` compared with the fetched upstream tip. They add no client RPC methods or event schemas. T3 remains the owner of the client protocol and orchestration. The Subpolar ACP bridge is configured as an existing local ACP executable; no new provider kind is registered. T3's native Pi provider remains separate and available.

This source-level compatibility check does not prove the clients work against an integrated Subpolar runtime. A process-level mock ACP adapter test has been added; it exercises a prompt, T3 runtime permission acceptance, and completion, but could not be executed in this environment because Bun cannot resolve the workspace alias and the Vite+ native test runner binding is unavailable. This does not validate the full event-source/client path or a real Pi turn. No full provider regression pass has been validated. ACP configuration is server-side and operator supplied; no Subpolar-specific frontend build is needed.

## Validation status and limitations

The following focused checks passed in this checkout on 2026-10-18:

- Subpolar environment manager: 97 tests and 439 assertions across 10 files.
- Core and Pi runtime: 45 tests and 131 assertions; runtime host and tools: 31 tests and 115 assertions.
- Imported CLI, OpenAPI, operations, and local persistence packages: 40 tests and 126 assertions, including OpenAPI generation (5 tests and 23 assertions; also rerun standalone).
- Focused managed ACP tests passed for worker execution, session recovery, MCP bridging, model cancellation, and proxying. The full ACP package suite is not cleanly runnable under the available Bun runner: some tests import Vitest-only exports from `@effect/vitest`; the local Vite+ native test runner is unavailable.
- A new process-level mock ACP adapter test covers prompt, T3 runtime permission acceptance, and completion. It is present but unexecuted because the local Bun workspace alias and Vite+ native test runner bindings are unavailable.
- Frozen-lockfile validation succeeded across all 40 workspace projects. The latest gateway Compose image build timed out after six minutes during `pnpm install`, after lockfile and supply-chain validation passed and about 1,807 of 1,844 packages were fetched. The gateway image did not finish building.
- Docker Compose configuration validation passed, and a real Docker Compose smoke passed manager startup, PostgreSQL health, service DNS, app-to-database execution, and cleanup. Manager and worker image checks passed.
- `git diff --check` passed.

T3's Vitest-based provider/session tests and typechecks remain unverified because the local Vite+ native binding and platform-specific `tsc-rs` binaries are unavailable. The new process-level mock ACP adapter test is also unexecuted due to the missing Bun workspace alias and Vite+ native bindings. There is no verified full event-source/client ACP flow or real Pi turn. The gateway image build timed out during package installation, so gateway startup and persistence through that image remain unverified.

The authenticated Docker manager and `subpolar` admin CLI, approved ACP argv execution, managed ACP-to-worker stdio proxy, explicitly allowlisted T3 terminal routing, image-based Dev Container discovery, constrained Dockerfile builds, locked and allowlisted Features, literal `containerEnv`, lifecycle hooks, and constrained optional Compose support exist in source. Compose Dev Container support is off by default and requires `SUBPOLAR_ENABLE_DEVCONTAINER_COMPOSE=true`; its internal network can still reach host services, so enabling it is an administrator trust decision. Registered environment reconciliation observes verified running or stopped state without starting containers and reports missing containers while preserving registrations. Pi agent configuration and native sessions live in a manager-owned volume; resume validates the saved Pi session ID and cwd. T3 remains authoritative for thread history, and the runtime does not persist run outcomes or replay events. An opt-in, session-bound ACP credential bridge uses the configured T3 provider instance and a server-side provider allowlist. Its same-process write lock cannot coordinate separate T3 server processes. The opt-in model egress extension routes bounded HTTPS through the T3 host, is bound to the active ACP session and configured Pi provider ID, pins a public IPv4 address for fixed provider API hosts, rejects redirects, and leaves the worker on Docker's `none` network. It supports only provider HTTP adapters honoring Pi's fetch override; WebSocket transports, Google Vertex, custom endpoints, model catalog refresh, deferred operations, and real end-to-end Pi turns remain unverified. Preview routing, automatic setup-script routing, distributed manager locking, Docker-wide orphan enumeration/cleanup, and full shutdown recovery remain incomplete. The manager's local registration file is not a distributed coordination mechanism.

The code and focused package checks establish an upstream-compatible integration seam, not completion of the integration acceptance criteria. See [the architecture](architecture.md) and [migration matrix](migration-matrix.md) for ownership boundaries and retained/deferred source functionality.
