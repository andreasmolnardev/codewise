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

This Compose project runs Codewise only on the tailnet. It intentionally has
no published production HTTP port: `tailscale` owns the network namespace and
proxies tailnet HTTPS traffic to Codewise on `127.0.0.1:3773`. Tailscale joins
both the private `docker-control` network and an outbound-enabled network so
it can reach the Tailscale control plane and DERP relays. Codewise shares that
network namespace; the manager and Docker proxy remain attached only to the
private control network.

## First start

1. Copy `docker/.env.example` to `docker/.env` and choose `DEPLOYMENT_NAME`.
2. Create `docker/secrets/tailscale-authkey` with a tagged, pre-authorized
   Tailscale auth key. Keep this file out of source control and restrict it to
   the deployer account (`chmod 600`). It is read only for initial enrollment;
   `tailscale-state` preserves the device identity after that.
3. From this directory run `docker compose --env-file .env up -d --build`.
4. Authenticate Codex, OpenCode, GitHub CLI, and SSH from the `codewise`
   container. Their dedicated volumes persist credentials across recreation.

Use `docker compose -f compose.yaml -f compose.local.yaml up -d` only when a
localhost recovery port is needed. Do not use that override on shared hosts.

The default deployment does not require a host Docker socket. To opt into
Codewise's read-only Docker API proxy, use the `docker` profile and its overlay:

```sh
docker compose --profile docker --env-file docker/.env \
  -f docker/compose.yaml \
  -f docker/compose.docker-proxy.yaml \
  up -d --build
```

The overlay sets `DOCKER_HOST` and makes Codewise wait for the proxy. The proxy
is reachable only on the private control network and rejects Docker API
mutations. This profile is independent of Subpolar execution.

## Durable paths

`/var/lib/codewise` is one durability unit and contains the SQLite database,
attachments, logs, settings, secrets, environment identity, and generated
worktrees. `/workspaces` contains project roots. The entrypoint refuses a
container-mode startup if either cannot be written by UID/GID 1000.

Projects must use container paths (for example `/workspaces/project-a`), never
the host path backing a bind mount. Deleting a Codewise project record does not
delete its workspace; delete files separately and deliberately.

## Optional Subpolar execution

Managed execution is disabled unless the `SUBPOLAR_MANAGER_*` and storage
settings are configured. The Compose profile adds a separate
`subpolar-manager` service with direct Docker socket access. Codewise reaches
the authenticated manager API over the private `docker-control` network, and
worker containers receive neither the socket nor Docker CLI.

From the repository root on a Linux Docker host, prepare the worker image and
discover the actual backing directory for the existing named workspace volume:

```sh
docker build -f docker/subpolar-worker.Dockerfile -t codewise-subpolar-worker:local .
docker volume inspect codewise_codewise-workspaces
```

Set these values in `docker/.env` before enabling the profile:

```dotenv
SUBPOLAR_MANAGER_URL=http://subpolar-manager:8787
SUBPOLAR_MANAGER_TOKEN=<random secret of at least 32 characters>
SUBPOLAR_STORAGE_ROOT=/workspaces
SUBPOLAR_DOCKER_HOST_STORAGE_ROOT=<volume Mountpoint from docker volume inspect>
SUBPOLAR_DOCKER_GID=<numeric group that can access /var/run/docker.sock>
SUBPOLAR_ACP_WORKER_COMMAND=["/usr/local/bin/subpolar-acp-worker"]
```

The host directory must be the same backing storage mounted as `/workspaces`
inside Codewise. Compose mounts it read-only at its host path inside the manager
so the manager can validate it; Docker then mounts only the selected worktree
into each worker. Linked Git worktrees also need matching gateway and host Git
metadata roots configured. If the host path cannot be made visible at the same
absolute path inside the manager, leave managed execution disabled.

Start the optional manager from the repository root with
`docker compose --profile subpolar --env-file docker/.env -f docker/compose.yaml up -d --build`.
Configure the Subpolar provider through T3's existing local ACP command setting,
using the installed `subpolar-acp` executable or Bun with
`packages/subpolar-acp/src/cli.ts` as its argument. Set
`SUBPOLAR_ACP_EXECUTION=managed` in the server environment to select the
authenticated worker-process proxy. The worker image includes the ACP bridge,
Pi SDK, and `/usr/local/bin/subpolar-acp-worker`; set
`SUBPOLAR_ACP_WORKER_COMMAND` to the JSON argv array shown above. The manager
token is passed only to the server process so the ACP bridge can authenticate.
The worker image contains no gateway token, T3 state, account credentials, or
Docker socket.

Workers currently run with Docker networking disabled. They therefore cannot
reach a model API. When `Use T3 managed Pi credentials` is enabled on an ACP
provider instance and its exact Pi provider ID is configured, T3's masked
sign-in flow can seed an encrypted, instance-scoped Pi credential for the
worker's private ACP credential bridge. The credential is not copied into the
worker image or its environment. A real Pi turn still cannot complete until
the manager provides and verifies a filtered model API path. Do not enable
direct worker networking as a workaround.

The `subpolar` admin CLI manages environments through the authenticated manager
API; it does not access Docker directly. See
[`packages/subpolar-environments/README.md`](../packages/subpolar-environments/README.md)
for commands and configuration.

The manager and worker protocol have focused unit coverage. A live Docker build
and container verification have not been performed where no Docker daemon is
available.

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

The Docker socket is mounted into `docker-proxy` only when the optional `docker`
profile is enabled. When the optional Subpolar profile is enabled, a separate
manager also receives the Docker socket and exposes only authenticated
environment lifecycle and process operations to Codewise. The manager's socket
access is still root-like; keep the service on the internal network, protect the
bearer token, and do not expose its port publicly. Worker containers receive
neither the Docker socket nor Docker CLI, run as UID 1000, drop capabilities,
disable networking, and mount only the selected worktree (plus explicitly
configured linked-Git metadata).

Do not bind mount the deployer's home, `.ssh`, or `.config`. Use the named
`ssh-config` volume or read-only Docker secrets for key files, and keep
`known_hosts` writable separately if using secret-mounted keys. Revoke a
harness credential in that harness; Codewise browser/client sessions remain a
separate SQLite-backed authorization domain.

## Operations

`GET /healthz` is a minimal readiness check and intentionally returns no
credential or topology information. Check `docker compose ps`, the Codewise
health check, and Tailscale status after an upgrade. Check Docker proxy health
when the optional `docker` profile is enabled.
Monitor free space for both `codewise-state` and `codewise-workspaces`; leave
enough space for a worktree, attachment upload, and SQLite WAL checkpoint.

Deleting `tailscale-state` is an intentional logout/re-enrollment operation
and creates a new Tailscale device identity. Apply tailnet tags and ACL/grants
so only intended users and devices can reach the node.
