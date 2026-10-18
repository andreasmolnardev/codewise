# Local Operations Artifacts

`createBackupArtifacts` creates a deterministic, in-memory archive from only the roots explicitly passed by the caller. Filesystem roots are traversed in sorted order, regular files are read in bounded stream chunks, and artifact count/size/total limits are enforced. In-memory roots use relative paths and are copied before returning.

Artifact paths are classified as `configuration`, `metadata`, or `transcript`. Secret-looking filenames and path components, traversal, absolute paths, backslashes, and symlinks are refused. The archive contains checksums and a validated operations manifest. No network, current time, ambient working directory, or arbitrary filesystem search is used.

`restoreBackupArtifacts` verifies every payload before writing beneath the caller-provided target root. Non-dry-run restores stage all payloads in a temporary sibling directory, then commit with temporary backups for overwritten files; any staging or commit failure rolls back installed files and removes temporary state. Destination path components are revalidated immediately before writes, and no-follow exclusive file creation is used for staging. It supports dry runs, refuses existing destinations unless `overwrite` is enabled, and requires `approved: true` for overwrite or non-merge restores. Reports are stable and contain no payload contents.

## Workspace setup

The T3 monorepo uses pnpm to install workspace dependencies. Run this package's
tests with `bun test packages/subpolar-operations/test` from the repository root.

## Operational limits

This is a local artifact workflow, not a live database backup or migration system. It does not access PocketBase, coordinate with running processes, quiesce a database, encrypt payloads, or guarantee consistency while another process changes a source. The manifest's encrypted flag is compatibility metadata; callers requiring confidentiality must provide already-protected input through an approved mechanism. PocketBase/live restore remains out of scope.
