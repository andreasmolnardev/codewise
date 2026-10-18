import { expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createDockerEnvironmentManager } from "../src/manager.ts";
import type { DockerClient } from "../src/docker.ts";

test("Docker manager composition resolves the configured worktree identity", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "subpolar-manager-"));
  const worktree = path.join(root, "repo");
  await mkdir(worktree);
  const dockerClient: DockerClient = {
    inspectContainer: async () => null,
    createContainer: async () => ({ id: "container-a" }),
    startContainer: async () => undefined,
    stopContainer: async () => undefined,
    removeContainer: async () => undefined,
    inspectVolume: async () => null,
    createVolume: async (options) => ({ name: options.name, driver: options.driver, labels: options.labels }),
    removeVolume: async () => undefined,
  };
  try {
    const manager = createDockerEnvironmentManager({
      dockerEngine: { socketPath: "/var/run/docker.sock" },
      docker: {
        gatewayStorageRoot: root,
        hostStorageRoot: root,
        containerStorageRoot: "/workspaces",
        image: "subpolar-worker:test",
      },
      registrationFile: path.join(root, "state", "environments.json"),
      dockerClient,
    });
    const identity = await manager.identity({
      ownerId: "installation-a",
      workspaceId: "workspace-a",
      storageRoot: root,
      worktreePath: worktree,
    });
    const [canonicalRoot, canonicalWorktree] = await Promise.all([realpath(root), realpath(worktree)]);
    expect(identity).toMatchObject({
      ownerId: "installation-a",
      workspaceId: "workspace-a",
      storageRoot: canonicalRoot,
      worktreePath: canonicalWorktree,
    });
    expect(identity.id).toMatch(/^env_[a-f0-9]{32}$/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
