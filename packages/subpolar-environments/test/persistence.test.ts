import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  createEnvironmentManager,
  type EnvironmentBackend,
  type EnvironmentIdentity,
  type ManagedEnvironment,
} from "../src/index.ts";
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
    const record = {
      ...identity,
      backendId: this.id,
      resourceId: `resource-${identity.id}`,
      status: "stopped" as const,
    };
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
  const request = {
    ownerId: "owner",
    workspaceId: "workspace",
    storageRoot: root,
    worktreePath: worktree,
  };
  const file = path.join(root, "state", "environments.json");
  const backend = new Backend();
  const firstManager = createEnvironmentManager(
    backend,
    createFileEnvironmentRegistrationStore(file),
    () => new Date("2026-10-16T00:00:00.000Z"),
  );
  const created = await firstManager.ensure(request);
  const raw = await readFile(file, "utf8");
  expect(raw).toContain(created.id);
  expect(raw).not.toContain("token");

  const restartedManager = createEnvironmentManager(
    backend,
    createFileEnvironmentRegistrationStore(file),
  );
  const [result] = await restartedManager.reconcile();
  expect(result).toMatchObject({ environmentId: created.id, environment: { status: "ready" } });
  expect(backend.creates).toBe(1);

  await restartedManager.remove(request);
  expect(await createFileEnvironmentRegistrationStore(file).loadAll()).toEqual([]);
});

test("serializes read-modify-write operations across independent store instances", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "subpolar-registration-race-"));
  roots.push(root);
  const file = path.join(root, "state", "environments.json");
  const stores = Array.from({ length: 4 }, () => createFileEnvironmentRegistrationStore(file));

  await Promise.all(
    Array.from({ length: 24 }, (_, index) => {
      const id = `env-${index}`;
      const environment: ManagedEnvironment = {
        id,
        ownerId: "owner",
        workspaceId: `workspace-${index}`,
        storageRoot: root,
        worktreePath: path.join(root, `workspace-${index}`),
        backendId: "fake",
        resourceId: `resource-${index}`,
        status: "stopped",
      };
      return stores[index % stores.length]!.save(environment, "created", "updated");
    }),
  );

  const registrations = await stores[0]!.loadAll();
  expect(registrations).toHaveLength(24);
  expect(new Set(registrations.map(({ environment }) => environment.id)).size).toBe(24);
});

test("rejects persisted registrations that do not match the managed environment schema", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "subpolar-invalid-registration-"));
  roots.push(root);
  const file = path.join(root, "state", "environments.json");
  const store = createFileEnvironmentRegistrationStore(file);
  const environment: ManagedEnvironment = {
    id: "env-1",
    ownerId: "owner",
    workspaceId: "workspace",
    storageRoot: root,
    worktreePath: path.join(root, "workspace"),
    backendId: "fake",
    resourceId: "resource-1",
    status: "ready",
    forwardedPorts: [3000],
  };
  await store.save(environment, "created", "updated");
  const validDocument = JSON.parse(await readFile(file, "utf8")) as {
    version: number;
    registrations: Array<{
      environment: Record<string, unknown>;
      createdAt: string;
      updatedAt: string;
    }>;
  };
  expect(await store.loadAll()).toMatchObject([{ environment: { forwardedPorts: [3000] } }]);

  const invalidCases: Array<[string, unknown]> = [
    ["unknown lifecycle state", { status: "paused" }],
    ["relative storage root", { storageRoot: "./workspace" }],
    ["invalid forwarded port", { forwardedPorts: [0] }],
    ["malformed forwarded ports", { forwardedPorts: "3000" }],
    ["empty resource ID", { resourceId: " " }],
  ];
  for (const [label, change] of invalidCases) {
    const corrupted = structuredClone(validDocument);
    Object.assign(corrupted.registrations[0]!.environment, change);
    await writeFile(file, JSON.stringify(corrupted));
    await expect(store.loadAll(), label).rejects.toThrow("invalid or duplicate record");
  }
});

test("atomically replaces an empty lock directory left by a crashed writer", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "subpolar-registration-empty-lock-"));
  roots.push(root);
  const file = path.join(root, "state", "environments.json");
  await mkdir(path.dirname(file), { recursive: true });
  await mkdir(file + ".lock");

  const environment: ManagedEnvironment = {
    id: "env-1",
    ownerId: "owner",
    workspaceId: "workspace",
    storageRoot: root,
    worktreePath: path.join(root, "workspace"),
    backendId: "fake",
    resourceId: "resource-1",
    status: "stopped",
  };
  await createFileEnvironmentRegistrationStore(file).save(environment, "created", "updated");

  expect(await createFileEnvironmentRegistrationStore(file).loadAll()).toMatchObject([
    { environment: { id: environment.id } },
  ]);
});

test("reconciliation records stopped Docker state without starting the environment", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "subpolar-stopped-reconcile-"));
  roots.push(root);
  const worktree = path.join(root, "workspace");
  await mkdir(worktree);
  const request = {
    ownerId: "owner",
    workspaceId: "workspace",
    storageRoot: root,
    worktreePath: worktree,
  };
  const file = path.join(root, "state", "environments.json");
  const backend = new Backend();
  const manager = createEnvironmentManager(backend, createFileEnvironmentRegistrationStore(file));
  const running = await manager.ensure(request);
  await backend.stop(running);

  const restartedManager = createEnvironmentManager(
    backend,
    createFileEnvironmentRegistrationStore(file),
  );
  const [result] = await restartedManager.reconcile();

  expect(result).toMatchObject({ environmentId: running.id, environment: { status: "stopped" } });
  expect(backend.creates).toBe(1);
  expect(
    (await createFileEnvironmentRegistrationStore(file).loadAll())[0]?.environment.status,
  ).toBe("stopped");
});

test("reconciliation reports a missing container and preserves its registration", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "subpolar-missing-reconcile-"));
  roots.push(root);
  const worktree = path.join(root, "workspace");
  await mkdir(worktree);
  const request = {
    ownerId: "owner",
    workspaceId: "workspace",
    storageRoot: root,
    worktreePath: worktree,
  };
  const file = path.join(root, "state", "environments.json");
  const backend = new Backend();
  const manager = createEnvironmentManager(backend, createFileEnvironmentRegistrationStore(file));
  const created = await manager.ensure(request);
  backend.records.delete(created.id);

  const restartedManager = createEnvironmentManager(
    backend,
    createFileEnvironmentRegistrationStore(file),
  );
  const [result] = await restartedManager.reconcile();

  expect(result).toMatchObject({
    environmentId: created.id,
    error: { code: "ENVIRONMENT_NOT_FOUND" },
  });
  expect(backend.creates).toBe(1);
  expect(await createFileEnvironmentRegistrationStore(file).loadAll()).toHaveLength(1);
});

test("reconciliation rejects a replacement Docker resource with the same environment identity", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "subpolar-replaced-resource-"));
  roots.push(root);
  const worktree = path.join(root, "workspace");
  await mkdir(worktree);
  const request = {
    ownerId: "owner",
    workspaceId: "workspace",
    storageRoot: root,
    worktreePath: worktree,
  };
  const file = path.join(root, "state", "environments.json");
  const backend = new Backend();
  const manager = createEnvironmentManager(backend, createFileEnvironmentRegistrationStore(file));
  const registered = await manager.ensure(request);
  backend.records.set(registered.id, { ...registered, resourceId: "replacement-resource" });

  const restartedManager = createEnvironmentManager(
    backend,
    createFileEnvironmentRegistrationStore(file),
  );
  const [result] = await restartedManager.reconcile();

  expect(result).toMatchObject({
    environmentId: registered.id,
    error: { code: "OWNERSHIP_MISMATCH", message: expect.stringContaining("resource") },
  });
  expect(
    (await createFileEnvironmentRegistrationStore(file).loadAll())[0]?.environment.resourceId,
  ).toBe(registered.resourceId);
});
