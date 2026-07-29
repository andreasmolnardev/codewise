# Codewise Docker deployment

The repository has separate container targets:

- `Dockerfile.dev` runs the server and Vite together and publishes the browser
  UI on `http://localhost:5173` (the server URL on `http://localhost:3773`
  redirects there).
- `Dockerfile.prod` builds the web UI and serves it directly from the server.

Start the development container with:

```sh
docker compose -f docker/compose.dev.yaml up --build
```

Open `http://localhost:3773/` or `http://localhost:5173/`.

The remaining instructions describe the production Compose deployment.

## First start

1. Copy `docker/.env.example` to `docker/.env` and choose `DEPLOYMENT_NAME`.
2. From this directory run `docker compose --env-file .env up -d --build`.
3. Authenticate Codex, OpenCode, GitHub CLI, and SSH from the `codewise`
   container. Their dedicated volumes persist credentials across recreation.

Codewise is published on `http://127.0.0.1:3773/`.

## Durable paths

`/var/lib/codewise` is one durability unit and contains the SQLite database,
attachments, logs, settings, secrets, environment identity, and generated
worktrees. `/workspaces` contains project roots. The entrypoint refuses a
container-mode startup if either cannot be written by UID/GID 1000.

Projects must use container paths (for example `/workspaces/project-a`), never
the host path backing a bind mount. Deleting a Codewise project record does not
delete its workspace; delete files separately and deliberately.

## Backup and restore

Stop Codewise before a host-level volume backup. For an online backup, mount a
separate destination and run `node /usr/local/lib/codewise/backup.mjs
/var/lib/codewise /backups/<timestamp>` in the application container. It uses
SQLite's online backup API, copies persistent state files, writes a manifest,
and verifies `integrity_check`. Run `node
/usr/local/lib/codewise/restore-validate.mjs /backups/<timestamp>` before
restoring into an inactive deployment. Do not copy a live `state.sqlite` file
by itself because WAL sidecar files and attachments are part of the consistency
boundary. Backups contain authentication material and must be encrypted and
access-controlled independently.

Before upgrading, create and verify a backup, retain the old image, then run a
single replacement instance. The entrypoint holds a lock in `codewise-state`,
so a second application container against the same volume exits instead of
concurrently migrating the database. A database downgrade requires restoring
the pre-upgrade backup when migrations are not backward compatible.

## Security model

The Docker socket is mounted only into `docker-proxy`; Codewise reaches its
read-only endpoint through `DOCKER_HOST`. The proxy is on an internal network,
not exposed to the host or tailnet. This is defense in depth, not a sandbox:
enabling Docker create/build/exec operations grants coding agents material host
power and needs a typed policy worker before it is enabled.

Do not bind mount the deployer's home, `.ssh`, or `.config`. Use the named
`ssh-config` volume or read-only Docker secrets for key files, and keep
`known_hosts` writable separately if using secret-mounted keys. Revoke a
harness credential in that harness; Codewise browser/client sessions remain a
separate SQLite-backed authorization domain.

## Operations

`GET /healthz` is a minimal readiness check and intentionally returns no
credential or topology information. Check `docker compose ps`, the Codewise
health check, and Docker proxy health after an upgrade.
Monitor free space for both `codewise-state` and `codewise-workspaces`; leave
enough space for a worktree, attachment upload, and SQLite WAL checkpoint.

Limit host/network access to `127.0.0.1:3773` using your standard firewall or
reverse-proxy controls when exposing Codewise beyond the local machine.
