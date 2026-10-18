import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createEnvironmentManager, type EnvironmentBackend, type EnvironmentIdentity, type ManagedEnvironment } from "../src/index.ts";
import { createFileEnvironmentRegistrationStore } from "../src/persistence.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

class Backend implements EnvironmentBackend {
  readonly id = "fake";
  readonly records = new Map<string, ManagedEnvironment>();
  creates = 0;

  async inspect(identity: EnvironmentIdentity) {
    return this.records.get(identity.id) ?? null;
  }

  async create(identity: EnvironmentIdentity) {
    this.creates += 1;
    const record = { ...identity, backendId: this.id, resourceId: `resource-${identity.id}`, status: "stopped" as const };
    this.records.set(record.id, record);
    return record;
  }

  async start(environment: ManagedEnvironment) {
    const record = { ...environment, status: "ready" as const };
    this.records.set(record.id, record);
    return record;
  }

  async stop(environment: ManagedEnvironment) {
    const record = { ...environment, status: "stopped" as const };
    this.records.set(record.id, record);
    return record;
  }

  async remove(environment: ManagedEnvironment) {
    this.records.delete(environment.id);
  }
}

test("persists lifecycle records and reconciles them after manager restart", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "subpolar-environment-store-"));
  roots.push(root);
  const worktree = path.join(root, "workspace");
  await mkdir(worktree);
  const request = { ownerId: "owner", workspaceId: "workspace", storageRoot: root, worktreePath: worktree };
  const file = path.join(root, "state", "environments.json");
  const backend = new Backend();
  const firstManager = createEnvironmentManager(backend, createFileEnvironmentRegistrationStore(file), () => new Date("2026-10-16T00:00:00.000Z"));
  const created = await firstManager.ensure(request);
  const raw = await readFile(file, "utf8");
  expect(raw).toContain(created.id);
  expect(raw).not.toContain("token");

  const restartedManager = createEnvironmentManager(backend, createFileEnvironmentRegistrationStore(file));
  const [result] = await restartedManager.reconcile();
  expect(result).toMatchObject({ environmentId: created.id, environment: { status: "ready" } });
  expect(backend.creates).toBe(1);

  await restartedManager.remove(request);
  expect(await createFileEnvironmentRegistrationStore(file).loadAll()).toEqual([]);
});

test("reconciliation records stopped Docker state without starting the environment", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "subpolar-stopped-reconcile-"));
  roots.push(root);
  const worktree = path.join(root, "workspace");
  await mkdir(worktree);
  const request = { ownerId: "owner", workspaceId: "workspace", storageRoot: root, worktreePath: worktree };
  const file = path.join(root, "state", "environments.json");
  const backend = new Backend();
  const manager = createEnvironmentManager(backend, createFileEnvironmentRegistrationStore(file));
  const running = await manager.ensure(request);
  await backend.stop(running);

  const restartedManager = createEnvironmentManager(backend, createFileEnvironmentRegistrationStore(file));
  const [result] = await restartedManager.reconcile();

  expect(result).toMatchObject({ environmentId: running.id, environment: { status: "stopped" } });
  expect(backend.creates).toBe(1);
  expect((await createFileEnvironmentRegistrationStore(file).loadAll())[0]?.environment.status).toBe("stopped");
});

test("reconciliation reports a missing container and preserves its registration", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "subpolar-missing-reconcile-"));
  roots.push(root);
  const worktree = path.join(root, "workspace");
  await mkdir(worktree);
  const request = { ownerId: "owner", workspaceId: "workspace", storageRoot: root, worktreePath: worktree };
  const file = path.join(root, "state", "environments.json");
  const backend = new Backend();
  const manager = createEnvironmentManager(backend, createFileEnvironmentRegistrationStore(file));
  const created = await manager.ensure(request);
  backend.records.delete(created.id);

  const restartedManager = createEnvironmentManager(backend, createFileEnvironmentRegistrationStore(file));
  const [result] = await restartedManager.reconcile();

  expect(result).toMatchObject({ environmentId: created.id, error: { code: "ENVIRONMENT_NOT_FOUND" } });
  expect(backend.creates).toBe(1);
  expect(await createFileEnvironmentRegistrationStore(file).loadAll()).toHaveLength(1);
});
