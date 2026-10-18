#!/usr/bin/env bun

import { createDockerEnvironmentManager } from "./manager.ts";
import { createEnvironmentManagerServer } from "./manager-http.ts";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function integer(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed)) throw new Error(`${name} must be an integer`);
  return parsed;
}

const host = process.env.SUBPOLAR_MANAGER_HOST ?? "127.0.0.1";
const port = integer("SUBPOLAR_MANAGER_PORT", 8787);
const gatewayGitRoot = process.env.SUBPOLAR_GATEWAY_GIT_ROOT;
const dockerGitRoot = process.env.SUBPOLAR_DOCKER_HOST_GIT_ROOT;
if (Boolean(gatewayGitRoot) !== Boolean(dockerGitRoot)) {
  throw new Error("SUBPOLAR_GATEWAY_GIT_ROOT and SUBPOLAR_DOCKER_HOST_GIT_ROOT must be configured together");
}
const manager = createDockerEnvironmentManager({
  dockerEngine: {
    socketPath: process.env.SUBPOLAR_DOCKER_SOCKET ?? "/var/run/docker.sock",
    dockerBinary: process.env.SUBPOLAR_DOCKER_BINARY ?? "docker",
  },
  docker: {
    gatewayStorageRoot: required("SUBPOLAR_GATEWAY_STORAGE_ROOT"),
    hostStorageRoot: required("SUBPOLAR_DOCKER_HOST_STORAGE_ROOT"),
    containerStorageRoot: process.env.SUBPOLAR_CONTAINER_STORAGE_ROOT ?? "/workspaces",
    ...(gatewayGitRoot && dockerGitRoot
      ? { gatewayGitRoot, hostGitRoot: dockerGitRoot }
      : {}),
    image: required("SUBPOLAR_WORKER_IMAGE"),
    allowedDevContainerFeatures: (process.env.SUBPOLAR_ALLOWED_DEVCONTAINER_FEATURES ?? "")
      .split(",")
      .map((feature) => feature.trim())
      .filter(Boolean),
    allowDevContainerCompose: process.env.SUBPOLAR_ENABLE_DEVCONTAINER_COMPOSE === "true",
    ...(process.env.SUBPOLAR_DEFAULT_DEVCONTAINER_CONFIG
      ? { defaultDevContainerConfiguration: process.env.SUBPOLAR_DEFAULT_DEVCONTAINER_CONFIG }
      : {}),
    ...(process.env.SUBPOLAR_MEMORY_BYTES ? { memoryBytes: integer("SUBPOLAR_MEMORY_BYTES", 0) } : {}),
    ...(process.env.SUBPOLAR_NANO_CPUS ? { nanoCpus: integer("SUBPOLAR_NANO_CPUS", 0) } : {}),
    ...(process.env.SUBPOLAR_PIDS_LIMIT ? { pidsLimit: integer("SUBPOLAR_PIDS_LIMIT", 0) } : {}),
  },
  registrationFile: process.env.SUBPOLAR_REGISTRATION_FILE ?? "/var/lib/subpolar/environments.json",
});
const server = createEnvironmentManagerServer({ manager, token: required("SUBPOLAR_MANAGER_TOKEN"), hostname: host, port });
server.once("error", (error) => {
  process.stderr.write(`Subpolar manager could not listen: ${error.message}\n`);
  process.exitCode = 1;
});
server.listen(port, host, () => {
  process.stdout.write(`Subpolar environment manager listening on ${host}:${port}\n`);
  void manager.reconcile().then((results) => {
    const failures = results.filter((result) => result.error).length;
    if (failures > 0) process.stderr.write(`Environment reconciliation completed with ${failures} failed registrations\n`);
  }).catch(() => process.stderr.write("Environment reconciliation failed\n"));
});

let shuttingDown = false;
const shutdown = () => {
  if (shuttingDown) return;
  shuttingDown = true;
  void Promise.all([manager.closeInteractiveSessions?.(), manager.closeManagedSessions?.()]).finally(() => server.close(() => { process.exitCode = 0; }));
};
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
