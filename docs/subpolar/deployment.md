# Docker deployment

The standalone Compose deployment runs the T3 gateway and Subpolar manager on
the same host. The manager controls Docker through the host Docker socket, so
use it only on a host and workspace directory you trust. The gateway is
published on loopback; put any remote access behind a separately configured
authenticated reverse proxy or tunnel.

From the repository root, create a persistent workspace directory and a
`docker/subpolar-gateway.env` file:

```dotenv
SUBPOLAR_WORKSPACES_HOST_PATH=/absolute/path/to/persistent/workspaces
SUBPOLAR_MANAGER_TOKEN=<random secret with at least 32 characters>
SUBPOLAR_MANAGER_INSTANCE_TOKENS={"<provider-instance-secret>":{"ownerId":"subpolar_team_a","storageRoot":"/workspaces","allowedOperations":["identity","ensure","start","stdio","execute"]}}
# Optional: match the host group that can access /var/run/docker.sock.
SUBPOLAR_DOCKER_GID=999
# Optional: comma-separated exact provider instance IDs allowed to use managed Pi.
SUBPOLAR_MANAGED_PROVIDER_INSTANCE_IDS=
# Optional: override the worker image name.
SUBPOLAR_WORKER_IMAGE=codewise-subpolar-worker:local
# Optional: use the production image published by GitHub Actions instead of building the gateway locally.
SUBPOLAR_GATEWAY_IMAGE=ghcr.io/andreasmolnardev/codewise:latest
# Optional: override the locally built manager image name.
SUBPOLAR_MANAGER_IMAGE=codewise-subpolar-manager:local
# Optional: exact Dev Container Feature references allowed by the manager.
SUBPOLAR_ALLOWED_DEVCONTAINER_FEATURES=
# Optional: select a repository-relative config if a worktree has several.
SUBPOLAR_DEFAULT_DEVCONTAINER_CONFIG=
# Optional and security-sensitive; Compose Dev Containers are disabled by default.
SUBPOLAR_ENABLE_DEVCONTAINER_COMPOSE=false
```

The workspace path must be absolute and writable by UID 1000 (`codewise`) in
the gateway container. On Linux, make sure the host directory grants that
container user write access before starting Compose. Docker Desktop manages host
path sharing for macOS and Windows. The manager also mounts that host path
read-only so it can validate workspaces and pass only the selected worktree to
a worker. Keep both tokens private. The manager token is reserved for the
administrator CLI; the instance token is limited to its configured owner,
workspace root, and operations. The manager API is authenticated, but its
Docker socket access is effectively host-level control.

Set the registry's `ownerId` to the configured ACP provider instance ID, such
as `subpolar_team_a`. Set the corresponding token as
`SUBPOLAR_MANAGER_INSTANCE_TOKEN` in that provider instance's existing
environment settings; do not put it in Compose. T3 binds `SUBPOLAR_OWNER_ID`
and `SUBPOLAR_PROVIDER_INSTANCE_ID` to the server-assigned provider ID and
strips any manager instance token inherited from the gateway environment.

Build and start the gateway and manager:

```sh
mkdir -p /absolute/path/to/persistent/workspaces
docker compose --env-file docker/subpolar-gateway.env \
  -f docker/subpolar-gateway.compose.yaml up -d --build
```

The gateway listens at `http://127.0.0.1:3773` by default. Set `T3CODE_PORT`
in the environment or env file to choose a different host port. To build the
worker image explicitly before first use:

```sh
docker compose --env-file docker/subpolar-gateway.env \
  -f docker/subpolar-gateway.compose.yaml --profile worker-image \
  build subpolar-worker-image
```

Build the worker image before first use when worktrees use the configured base
image. Compose Dev Container configurations remain disabled unless
`SUBPOLAR_ENABLE_DEVCONTAINER_COMPOSE=true` is set on the manager. Enabling
them is an administrator trust decision: containers on the internal Compose
network may still reach services exposed by the Docker host. See
[`dev-containers.md`](dev-containers.md) for the supported configuration
subset and Feature lock/allowlist requirements.

When using the GitHub-published gateway image, build the manager and worker
locally first, then start with `up -d --no-build`; Compose pulls the configured
gateway image and reuses the named local manager image. For local gateway
builds and upgrades, run the same `up -d --build` command. Keep the named volumes for
T3 state, manager registration, and provider configuration. Back up those
volumes and the workspace directory before removing the deployment.
