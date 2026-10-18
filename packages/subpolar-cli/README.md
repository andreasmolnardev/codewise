# `@subpolar/runtime-cli`

The Subpolar command-line runtime and composition entry point.

## What it does

- Provides the `subpolar-cli` executable.
- Runs prompts through `createStatelessSubpolarRuntime`, the same contract used by the Subpolar Agent composition.
- Lazily uses `@earendil-works/pi-coding-agent` for normal runs; missing SDK/auth is an error, never an echo fallback.
- Supports explicit `--fixture` test mode, `--pi-module <specifier>`, or injected `pi.factory`/`pi.module`.
- Supports ephemeral sessions, JSON-file sessions, JSON output, JSONL lifecycle events, timeouts, and cancellation.

The CLI composes `@subpolar/runtime`, `@subpolar/db-local`, and `@subpolar/runtime-pi`. It is an application boundary, not part of the policy or persistence implementations.

## Workspace setup

The T3 monorepo uses pnpm to install workspace dependencies. Run this CLI
with Bun from the repository root; do not install separately in this package.

## Usage

```sh
bun packages/subpolar-cli/src/cli.ts run "hello"
bun packages/subpolar-cli/src/cli.ts run "hello" --json
bun packages/subpolar-cli/src/cli.ts run "hello" --jsonl --timeout 30000
bun packages/subpolar-cli/src/cli.ts run "hello" --fixture --json
bun packages/subpolar-cli/src/cli.ts run "hello" --session demo --session-file ./sessions.json
bun packages/subpolar-cli/src/cli.ts run "hello" --pi-module /absolute/path/to/executor.ts
```

The optional Pi SDK must resolve from the standalone package through the root hoisted workspace, not by reaching into `@subpolar-agent/node_modules`. No installation/version change is performed by this package. The standalone CLI is trusted local execution and can use Pi's normal local SDK credentials; it is not the Subpolar Agent multi-user credential boundary. Multi-user hosts must inject an owner-isolated `pi.config.modelRuntime` or trusted factory, without ambient credential fallback. Provider calls send the prompt and projected history to the selected provider and may incur costs. Hosts can inject `pi.config.modelRuntime`, `model`, `agentDir`, or a custom factory instead.

The default SDK executor is **prompt-only**: built-in tools, extensions, skills, prompt templates, and context-file discovery are disabled. Tool-enabled hosts must provide a factory that delegates tool calls through `PiExecutionRequest.tools`; the shared gateway remains the policy boundary. The CLI does not provide durable approvals or an approval decision command.

Sessions are ephemeral unless `--session-file` is supplied. File sessions store user/assistant text and can resume conversation history, but are not full Pi branches or run recovery. JSON envelopes explicitly report `recoverable: false`; file sessions do not provide durable outcomes, replay, or multi-process guarantees. Each invocation gets fresh run/request IDs. JSONL emits shared started/progress/terminal events with redaction.

Exit codes: `0` completed, `1` execution/composition failure, `2` usage error, `3` timeout, `4` cancellation. Timeouts and signals are cooperative: the SDK calls `abort()`, while custom factories must honor their signal. The CLI does not pretend it can forcibly stop an uncooperative executor. An executor that settles after abort without durable recovery produces `unknown`, not a recoverable success.

## Testing

```sh
bun test packages/subpolar-cli
```
