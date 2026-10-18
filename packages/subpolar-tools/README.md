# `@subpolar/tools`

Persistence-neutral tool registration, authorization, and execution boundaries.

## What it does

- Canonicalizes tool IDs as `adapter/namespace/name`.
- Registers internal, HTTP, OpenAPI, MCP, browser, memory, and subagent adapters.
- Validates tool inputs against JSON-schema-style definitions.
- Resolves context and applies an injected policy before execution.
- Exposes authorization capabilities that cannot be manufactured by callers.
- Builds owner-scoped MCP connection cache keys from trusted host identity.
- Supports injected persistence, redaction hooks, and execution events.
- Provides the `subpolar-tools` CLI for calling a remote Subpolar gateway.

The registry does not choose a database or network implementation. Those boundaries are injected by the host application.
MCP cache keys must use the authenticated owner from host context; the registry's injected policy remains the authority for every tool call.

## Workspace setup

From the repository root, use Bun 1.3.14 and `bun install --frozen-lockfile`.
The hoisted workspace shares compatible dependencies, but incompatible versions
may still require nested copies. Do not install separately in this package.

Adapter availability is not a sandbox guarantee. The Subpolar Agent shared-host gateway
disables arbitrary shell and MCP stdio, and registered CLI is disabled by default.
Host applications must enforce their own execution boundary; live two-user
verification remains outstanding. See
[Bun and multi-user operations](../../docs/bun-and-multi-user.md).

## Usage

```ts
import { createToolRegistry, canonicalizeToolId } from "@subpolar/tools";
```

The CLI is available with:

```sh
bun packages/subpolar-tools/src/cli.ts health --json
```

## Testing

```sh
bun test packages/subpolar-tools
```
