# `@subpolar/shared`

Shared contracts for the Subpolar runtime, adapters, tools, and applications.

## What it contains

- Runtime, execution, and principal context types.
- Run requests, outcomes, lifecycle events, and persistence ports.
- Tool definitions, calls, policies, approvals, and audit contracts.
- Session, transcript, memory, and skill interfaces.
- Operations manifest types and validation helpers.
- Skill validation, versioning, scope resolution, and an in-memory skill repository.

This package is intentionally implementation-neutral. It defines the interfaces that `@subpolar/runtime`, storage adapters, Pi integration, and applications compose together. It does not import Pi, PocketBase, Subpolar Agent, or HTTP implementations.

## Workspace setup

From the repository root, use Bun 1.3.14 and `bun install --frozen-lockfile`.
The hoisted workspace shares compatible dependencies, but incompatible versions
may still require nested copies. Do not install separately in this package.
See [Bun and multi-user operations](../../docs/bun-and-multi-user.md).

## Testing

```sh
bun test packages/subpolar-contracts
```
