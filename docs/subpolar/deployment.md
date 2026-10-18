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
# Optional: match the host group that can access /var/run/docker.sock.
SUBPOLAR_DOCKER_GID=999
# Optional: comma-separated exact provider instance IDs allowed to use managed Pi.
SUBPOLAR_MANAGED_PROVIDER_INSTANCE_IDS=
# Optional: override the worker image name.
SUBPOLAR_WORKER_IMAGE=codewise-subpolar-worker:local
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
a worker. Keep the manager token private;
the manager API is authenticated, but its Docker socket access is effectively
host-level control.

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

For upgrades, run the same `up -d --build` command. Keep the named volumes for
T3 state, manager registration, and provider configuration. Back up those
volumes and the workspace directory before removing the deployment.
