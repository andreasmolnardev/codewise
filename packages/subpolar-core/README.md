# `@subpolar/runtime`

Core execution and authorization logic for Subpolar.

## What it does

- Creates the policy gateway with `createPolicyGateway` or `createGateway`.
- Validates tool input and fails closed when no policy allows a call.
- Applies deny > approval-required > allow precedence.
- Coordinates approval stores, continuation ports, claims, idempotency, and audit events.
- Redacts credentials and other sensitive values from errors and audit data.
- Provides the stateful run service and the stateless Subpolar runtime.

The runtime depends on shared contracts and injected ports. It does not import Pi, PocketBase, Subpolar Agent, or concrete HTTP adapters. Storage and provider behavior must be supplied by the composition root.

## Main APIs

- `createPolicyGateway`
- `createRunService`
- `createStatelessSubpolarRuntime`
- `redactAuditValue`

## Workspace setup

From the repository root, use Bun 1.3.14 and `bun install --frozen-lockfile`.
The hoisted workspace shares compatible dependencies, but incompatible versions
may still require nested copies. Do not install separately in this package.
Policy and context checks are application boundaries, not an OS sandbox.
See [Bun and multi-user operations](../../docs/bun-and-multi-user.md) for current
shared-host restrictions and the outstanding live two-user verification.

## Testing

```sh
bun test packages/subpolar-core
```
