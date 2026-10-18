# `@subpolar/db-local`

Local persistence implementations for development, tests, and standalone CLI use.

## What it provides

- `EphemeralSessionStore` for in-memory session transcripts.
- `JsonFileSessionStore` for atomic JSON-file session persistence.
- `LocalMemoryStore` for owner-scoped local memories.
- `LocalSkillRepository` for versioned local skill records.
- `createLocalAdapter` to compose the local stores and capability metadata.

Without file paths, state is process-local and ephemeral. JSON-file persistence is deliberately single-process and does not claim multi-process concurrency, durable approvals, or event replay.

The adapter implements shared contracts and does not depend on Pi, PocketBase, Subpolar Agent, or network services.

## Workspace setup

The T3 monorepo uses pnpm to install workspace dependencies. Run this package's
tests with `bun test packages/subpolar-persistance-local/test` from the
repository root. Owner-scoped records do not provide OS or hostile-tenant
isolation, and this adapter must not be used as T3's thread or event store.

## Testing

```sh
bun test packages/subpolar-persistance-local
```
