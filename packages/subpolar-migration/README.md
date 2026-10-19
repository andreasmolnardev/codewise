# Subpolar legacy migration staging

This package builds a validated staging bundle from explicitly supplied legacy
JSON files. It does not connect to PocketBase, modify T3 settings, import Pi
transcripts, or migrate credentials. Review the output and apply supported
records manually through the destination service's normal APIs.

Supported inputs:

- `projects.json`: project names and paths (simple map or `{ "projects": ... }`).
- `tools.json`: external tool name, HTTP(S) base URL, OpenAPI file path,
  operation allowlist, and environment-variable header references.
- `settings.json`: only `defaultModel` and `sessionTitleGenModel` are retained.
- `agent-profiles.json`: an explicit JSON export array with `id`, `name`, and
  optional model, thinking level, instructions, and allowed tool IDs.
- `.sessions.json`: counted for the report only; session IDs and titles are not
  copied.

Run the package tests with `bun test packages/subpolar-migration/test`.
Applications can call `createLegacyMigrationBundle` with paths selected by an
operator and then `writeLegacyMigrationBundle` to write the result under a new,
deterministic `subpolar-import-<hash>` directory. Repeating the same import is
idempotent. A destination collision is rejected; nothing is overwritten. The
staged bundle and its source hashes provide a review snapshot. Hashes cover only
import-safe projections, not source secrets or conversation titles. Removing
the staging directory reverses this operation because source and destination
state are never changed.

## Safety and limitations

- Credentials are never copied. Header values are retained only as valid
  `{ "env": "VARIABLE_NAME" }` references. Literal or malformed values are
  dropped and counted. Credential stores and provider credentials must be
  reconnected or imported through a separate secure operator-controlled flow.
- Inline OpenAPI documents are omitted and counted for manual review.
- `.sessions.json` metadata, Pi JSONL transcripts, old conversation histories,
  and memory records are not imported.
- `agent-profiles.json` must be an operator-created export; the old backend's
  PocketBase profile, skill, memory, and MCP/OpenAPI records are not queried or
  automatically migrated by this utility.
- This is staging only. It does not claim that every legacy setting maps to a
  current T3 or Subpolar runtime capability.
