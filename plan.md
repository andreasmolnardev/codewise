# Docker-hosted Codewise implementation plan

## Goal

Run Codewise as a durable Docker-hosted environment with Codex and OpenCode preinstalled, while providing:

- persistent project workspaces and generated worktrees;
- persistent SQLite/application state;
- persistent Codex, OpenCode, Git, and source-control authentication;
- an independent, stable Tailscale device identity;
- controlled access to the host Docker daemon.

The deployment should survive image upgrades, container recreation, and host reboots without changing project paths, losing sessions, or requiring harness reauthentication.

## Recommended topology

Use one Compose project containing three services:

1. `codewise`: the application server, web UI, Codex CLI, OpenCode CLI, Git tooling, and Docker CLI.
2. `tailscale`: owns the tailnet identity and shares the `codewise` network namespace.
3. `docker-proxy`: exposes only the Docker API operations explicitly required by Codewise.

Do not publish the Codewise HTTP port on the host by default. Expose it through Tailscale Serve. A localhost-only published port may be added as a documented recovery option.

## Storage contract

Define stable paths inside the application container. These paths become part of the persisted data contract and must not change between releases.

| Data | Container path | Suggested named volume/bind mount | Notes |
| --- | --- | --- | --- |
| Server base directory | `/var/lib/codewise` | `codewise-state` | Contains `userdata/state.sqlite`, attachments, secrets, logs, settings, and worktrees under the current `ServerConfig` layout. |
| Project workspaces | `/workspaces` | `codewise-workspaces` or `/srv/codewise/workspaces` | Every persisted project root must be below this path. |
| Codex home | `/home/codewise/.codex` | `codex-home` | Persist `auth.json`, config, and Codex-owned state. |
| OpenCode config/data | `/home/codewise/.config/opencode` and any runtime-specific data directory | `opencode-config` and, if needed, `opencode-data` | Confirm actual directories against the pinned OpenCode version during image implementation. |
| GitHub CLI auth | `/home/codewise/.config/gh` | `gh-config` | Optional but needed for durable `gh auth login`. |
| Git/SSH credentials | `/home/codewise/.ssh` and selected Git config | dedicated secret/config mounts | Avoid sharing the host user's entire home directory. |
| Tailscale state | `/var/lib/tailscale` | `tailscale-state` | Preserves node keys and device identity. |

Use UID/GID `1000:1000` for the non-root `codewise` user and initialize writable volumes with those ownership values. The entrypoint may perform narrowly scoped ownership initialization as root, then drop privileges before launching the server.

## Phase 1: container-ready server configuration

### Work

- Add an explicit container/deployment configuration layer rather than relying on the process working directory.
- Start the server with:
  - base directory `/var/lib/codewise`;
  - working/project discovery directory `/workspaces`;
  - host `0.0.0.0` because the Tailscale sidecar shares the network namespace;
  - headless/no-browser startup;
  - a fixed internal port, initially `3773`.
- Keep `deriveServerPaths` in `apps/server/src/config.ts` as the source of truth. Mount the complete base directory so `userdata`, `worktrees`, caches, attachments, settings, server secrets, and identity files remain consistent.
- Add startup validation that rejects container deployments when:
  - the base directory or workspace directory is not writable;
  - either resolves to an unexpected ephemeral path;
  - the SQLite database cannot be opened;
  - a workspace root points outside configured allowed roots.
- Add a health endpoint or extend the existing diagnostics surface with readiness checks for database access, provider executables, workspace write access, and optional Docker connectivity.
- Ensure SIGTERM stops accepting new WebSocket work, allows active persistence writes to finish, terminates provider subprocesses, and exits before Compose's stop timeout.

### Likely files

- `apps/server/src/cli/config.ts`
- `apps/server/src/cli/server.ts`
- `apps/server/src/config.ts`
- `apps/server/src/server.ts`
- `apps/server/src/workspace/WorkspacePaths.ts`
- new container entrypoint/configuration files under `docker/`

### Acceptance criteria

- Recreating only the application container preserves its environment ID and settings.
- The service starts from an arbitrary process working directory.
- The server listens inside the shared network namespace but is not publicly published by default.
- A graceful `docker compose stop` does not corrupt the database or leave provider processes running.

## Phase 2: persistent workspaces

### Work

- Make `/workspaces` the canonical container workspace root.
- Add an allowed-workspace-roots policy to the server configuration, initially containing only `/workspaces` and the managed worktree directory.
- Validate project creation/import and file APIs against canonical real paths to prevent `..` and symlink escapes.
- Store container paths such as `/workspaces/project-a` in projections and orchestration events. Never persist host paths such as `/srv/codewise/workspaces/project-a` or `/Users/...`.
- Decide how projects enter the volume:
  - clone through the Codewise UI/CLI; or
  - prepopulate a bind-mounted host directory.
- Keep generated Codewise worktrees in `/var/lib/codewise/worktrees`, because their lifecycle belongs to the application state. If users need direct host access, document the mapping rather than moving them into arbitrary host paths.
- Add free-space checks before cloning, creating worktrees, or accepting large attachments.
- Define deletion semantics explicitly: deleting a project record must not delete the underlying workspace unless the user chooses a separate, strongly confirmed filesystem deletion action.

### Tests

- Project and thread recovery after container recreation.
- Existing project discovery after image upgrade.
- Workspace traversal and symlink escape rejection.
- Paths remain stable when switching from named volumes to bind mounts.
- Worktree recovery or cleanup after an ungraceful container stop.

## Phase 3: persistent SQLite and application state

### Work

- Mount `/var/lib/codewise` as one durability unit so the SQLite database, attachments, checkpoint blobs, secrets, settings, and environment identity stay synchronized.
- Keep SQLite on a local Docker volume or local bind-mounted filesystem. Document that network filesystems are unsupported unless their locking and durability behavior is proven.
- Review `apps/server/src/persistence/NodeSqliteClient.ts` and the live SQLite layer for:
  - WAL journal mode;
  - `foreign_keys=ON`;
  - a non-zero busy timeout;
  - appropriate synchronous mode;
  - bounded checkpoint behavior.
- Continue running schema migrations before opening the network listener.
- Add a startup migration lock or single-instance guard so two Codewise containers cannot migrate the same database concurrently.
- Add a supported backup command that:
  - uses SQLite's online backup API or `VACUUM INTO`, rather than copying a live database file blindly;
  - includes attachments and other referenced files;
  - records application and schema versions in a manifest;
  - writes to a separate backup destination.
- Add a restore validation command that checks the manifest, database integrity, required files, and ownership before replacing an inactive deployment.
- Document host-level volume backup as a secondary option that requires stopping the service first.

### Likely files

- `apps/server/src/persistence/NodeSqliteClient.ts`
- `apps/server/src/persistence/Layers/Sqlite.ts`
- `apps/server/src/persistence/Migrations.ts`
- `apps/server/src/cli/` for backup, restore, and integrity-check commands
- `apps/server/src/diagnostics/`

### Acceptance criteria

- Threads, auth sessions, project metadata, attachments, checkpoints, and settings survive container recreation.
- Database migrations work when upgrading from the previous image.
- An online backup restores into a clean deployment and passes `PRAGMA integrity_check` plus application-level reference checks.
- Concurrent startup against the same volume fails safely with a clear error.

## Phase 4: persistent harness and source-control authentication

### Work

- Build Codex and OpenCode into the image at pinned versions. Record their versions as OCI labels and display them in diagnostics.
- Set `CODEX_HOME=/home/codewise/.codex` and persist that directory.
- Determine and persist the exact OpenCode config, data, and cache locations used by the pinned version. Persist credentials and durable configuration; caches may remain ephemeral.
- Persist only the source-control clients actually supported in the image, beginning with GitHub CLI at `/home/codewise/.config/gh`.
- Support SSH using one of these explicit modes:
  1. a dedicated persistent SSH directory owned by the container user; or
  2. read-only key files supplied through Docker secrets plus a writable `known_hosts` volume.
- Do not bind mount the host user's full `.ssh`, `.config`, or home directory.
- Ensure harness provider subprocesses inherit the intended home, `CODEX_HOME`, XDG paths, and secret-file environment variables.
- Add provider diagnostics that report authenticated/unauthenticated state without logging tokens, key material, or credential file contents.
- Ensure backups containing credentials are clearly marked sensitive and can be encrypted independently.
- Keep application remote-access authentication in the existing SQLite/server-secret model. Harness authentication and Codewise client authorization are separate domains and must remain separately revocable.

### Secret bootstrap

- Use Compose secrets for one-time or externally managed values such as the initial Tailscale auth key and optional provider API keys.
- Prefer `_FILE` environment variables where supported.
- If a harness requires an environment variable rather than a file, have the entrypoint read only that secret into the child process environment; never write it into generated Compose files or logs.
- Define a credential rotation runbook that does not require deleting the application database.

### Tests

- Authenticate Codex and OpenCode, recreate the container, and verify both remain authenticated.
- Verify a new image can read the previous version's persisted credential layout.
- Confirm logs and diagnostics redact access tokens and filesystem secret values.
- Confirm revoking one harness does not revoke Codewise client sessions or other harnesses.

## Phase 5: independent Tailscale device

### Work

- Run the official Tailscale image as a sidecar with persistent `/var/lib/tailscale` state.
- Give the Tailscale service the `NET_ADMIN` and `NET_RAW` capabilities and `/dev/net/tun` access when kernel networking is available.
- Make Tailscale and Codewise share one network namespace. Compose supports this by setting one service to `network_mode: service:<other-service>`; choose and test the direction carefully because it affects startup ordering, health checks, and port declarations.
- Set a deterministic hostname such as `codewise-${DEPLOYMENT_NAME}`.
- Supply a tagged, reusable or one-time preauthorized auth key through a Compose secret only for first registration. Once node state exists, startup must not require the key.
- Configure Tailscale Serve to proxy HTTPS to `http://127.0.0.1:3773`.
- Reconcile this deployment model with the current in-process `tailscale serve` integration in `packages/tailscale`:
  - preferred: let the sidecar own Serve configuration and disable the application's automatic Serve mutation in container mode;
  - alternative: allow the app container to call the sidecar's local Tailscale socket, but only if the API contract and permissions are explicitly managed.
- Add tags and tailnet ACL/grant guidance so only intended users/devices can access the Codewise node.
- Add logout/re-enrollment documentation. Deleting the Tailscale state volume intentionally creates a new tailnet device identity.

### Compose behavior to verify

- No host network mode.
- No public `ports` entry by default.
- Tailscale state survives both sidecar and application recreation.
- The app is reachable through MagicDNS and its tailnet HTTPS URL.
- Restarting either service recovers without changing the tailnet device.
- The service fails closed when Tailscale is unavailable unless a documented local recovery binding is explicitly enabled.

## Phase 6: host Docker access

### Security decision

Access to `/var/run/docker.sock` is effectively root-equivalent host access. A generic HTTP socket proxy reduces accidental API surface but is not a complete security boundary: many allowed Docker operations can still create a privileged container or mount sensitive host paths.

Implement Docker access in two stages:

1. Initial trusted-user deployment: use a socket proxy and clearly document that Codewise agents are trusted with host-equivalent privileges if they can create containers.
2. Hardened deployment: introduce a typed Docker worker/service that enforces policy before calling the daemon.

### Initial implementation

- Mount the host socket only into `docker-proxy`, never into `codewise` or agent-created containers.
- Connect Codewise to the proxy using `DOCKER_HOST=tcp://docker-proxy:2375` on a private Compose network.
- Configure the proxy with the smallest endpoint set required by actual features. Start with read-only version, ping, container-list, and image-list endpoints; enable create/start/stop/build/exec only when a tested feature requires each operation.
- Do not expose the proxy port to the host or tailnet.
- Add a Docker connectivity diagnostic and distinguish unavailable, unauthorized, and incompatible-daemon errors.
- Pin the Docker CLI version or maintain an explicit daemon compatibility range.

### Hardened worker design

- Define typed operations such as `BuildProjectImage`, `CreateWorkspaceContainer`, `StartContainer`, `StopManagedContainer`, and `ReadManagedLogs`.
- Require every managed resource to carry Codewise ownership labels and a deployment/environment ID.
- Reject requests containing:
  - privileged mode;
  - host PID, IPC, or network namespaces;
  - device mounts;
  - arbitrary bind mounts;
  - mounts outside approved workspace/cache roots;
  - the Docker socket;
  - unbounded CPU, memory, process, or disk use;
  - disallowed capabilities or security-profile changes.
- Use an image allowlist or configurable registry policy.
- Default to read-only root filesystems where compatible, non-root users, dropped capabilities, `no-new-privileges`, resource limits, and isolated networks.
- Serialize or bound expensive builds and container starts to keep the host predictable under load.
- Reconcile orphaned managed containers on startup using ownership labels, without touching unrelated host containers.
- Record auditable operation metadata without recording secrets passed to builds or processes.

### Tests

- Codewise can reach the daemon through the private proxy network.
- Codewise cannot access the Unix socket directly.
- The proxy is unreachable from the tailnet and ordinary agent workload networks.
- Policy tests reject privileged containers, host-root mounts, socket mounts, namespace sharing, and unbounded resources.
- Reconciliation never mutates containers lacking Codewise ownership labels.

## Phase 7: image and Compose artifacts

Add the following deployment artifacts:

- `docker/Dockerfile`: multi-stage production build with pinned Codex, OpenCode, Tailscale client if still needed by diagnostics, Git, GitHub CLI, Docker CLI, shell tooling, and required native runtime libraries.
- `docker/entrypoint.sh`: validates mounts, initializes narrow ownership targets, loads file-based secrets, and drops to the `codewise` user.
- `docker/compose.yaml`: production topology.
- `docker/compose.local.yaml`: optional localhost-only recovery/development overrides.
- `docker/.env.example`: non-secret deployment settings only.
- `docker/README.md`: install, enrollment, authentication, upgrade, backup, restore, and threat-model guidance.
- `.dockerignore`: exclude `.git`, `.repos`, local state, credentials, test artifacts, and build outputs not needed by the selected build stage.

The production image should:

- use immutable version tags or digests for external images and downloaded tools;
- verify downloaded binaries with checksums/signatures where available;
- run the application as a non-root user;
- include an OCI source revision and build timestamp;
- avoid embedding credentials or `.env` files in image layers;
- include a container health check;
- support both `amd64` and `arm64` if releases target both architectures.

## Phase 8: upgrades, backups, and operations

### Upgrade flow

1. Create and verify a backup.
2. Pull the new immutable image.
3. Stop the old application container while retaining volumes and the Tailscale sidecar state.
4. Start one application instance and run migrations before accepting traffic.
5. Verify health, harness versions/authentication, project access, and Docker connectivity.
6. Retain the previous image for rollback. Database rollback requires restoring the pre-upgrade backup when migrations are not backward compatible.

### Operational safeguards

- Document minimum free-space thresholds and volume monitoring.
- Rotate logs or keep them bounded using the existing trace/log limits.
- Add a diagnostic bundle command that excludes/redacts credentials.
- Make environment ID, image revision, database schema version, Codex/OpenCode versions, Tailscale status, and Docker daemon compatibility visible in diagnostics.
- Add startup warnings for insecure configurations: raw socket mounts, public port publishing, root execution, missing resource limits, or credential directories with broad permissions.

## Example Compose shape

This is a design target, not a drop-in file; exact image flags and health commands should be filled in while implementing and testing each service.

```yaml
services:
  codewise:
    build:
      context: ..
      dockerfile: docker/Dockerfile
    init: true
    user: "1000:1000"
    environment:
      CODEX_HOME: /home/codewise/.codex
      DOCKER_HOST: tcp://docker-proxy:2375
    volumes:
      - codewise-state:/var/lib/codewise
      - codewise-workspaces:/workspaces
      - codex-home:/home/codewise/.codex
      - opencode-config:/home/codewise/.config/opencode
      - gh-config:/home/codewise/.config/gh
    networks:
      - docker-control
    depends_on:
      docker-proxy:
        condition: service_healthy
    restart: unless-stopped

  tailscale:
    image: tailscale/tailscale:<pinned-version>
    hostname: codewise-node
    cap_add:
      - NET_ADMIN
      - NET_RAW
    devices:
      - /dev/net/tun:/dev/net/tun
    volumes:
      - tailscale-state:/var/lib/tailscale
    secrets:
      - tailscale-authkey
    restart: unless-stopped
    # Configure the final shared-network-namespace direction during implementation.

  docker-proxy:
    image: tecnativa/docker-socket-proxy:<pinned-version>
    environment:
      PING: 1
      VERSION: 1
      INFO: 1
      CONTAINERS: 1
      IMAGES: 1
      POST: 0
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock:ro
    networks:
      - docker-control
    restart: unless-stopped

networks:
  docker-control:
    internal: true

volumes:
  codewise-state:
  codewise-workspaces:
  codex-home:
  opencode-config:
  gh-config:
  tailscale-state:

secrets:
  tailscale-authkey:
    file: ./secrets/tailscale-authkey
```

The final Compose file must resolve the network-namespace relationship between `codewise` and `tailscale` while preserving Codewise's private connection to `docker-proxy`. Compose networking constraints may make a shared namespace plus a private service network awkward; test this early. If necessary, put the Docker proxy endpoint on loopback within the shared namespace through a narrowly configured relay, or run Tailscale in the Codewise container as a supervised process. Do not solve this by exposing the Docker proxy on a broadly reachable network.

## Delivery sequence

Keep changes reviewable and independently testable:

1. Container-ready server configuration and base image.
2. Persistent state and workspace mounts with restart tests.
3. Persistent Codex/OpenCode/source-control authentication.
4. Backup, restore, and migration safety.
5. Tailscale sidecar and tailnet-only access.
6. Read-only Docker proxy connectivity.
7. Required Docker mutations plus explicit policy enforcement.
8. Production documentation, diagnostics, and release automation.

## Definition of done

- `docker compose up` creates a usable tailnet-only Codewise node.
- Codex and OpenCode are preinstalled, versioned, diagnosable, and retain authentication after recreation.
- Projects, threads, worktrees, attachments, settings, auth sessions, and environment identity survive recreation and host restart.
- The Tailscale node keeps the same device identity after recreation.
- The host Docker socket is mounted only into the proxy/worker, and the API is inaccessible from the tailnet and agent workload networks.
- Backup and restore are documented and tested on real persisted data.
- Upgrade and rollback procedures are tested across at least one schema migration.
- Security tests cover workspace path escapes, secret redaction, unauthorized remote access, dangerous Docker options, and resource limits.
- Repository-required checks pass: `vp check` and `vp run typecheck`.
- Any implementation-specific tests added for server, persistence, authentication, Tailscale, and Docker policy pass through `vp test` or the appropriate package test command.
