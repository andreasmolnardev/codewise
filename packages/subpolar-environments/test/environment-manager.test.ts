import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  createEnvironmentManager,
  EnvironmentManagerError,
  type EnvironmentBackend,
  type EnvironmentIdentity,
  type EnvironmentInteractiveSession,
  type EnvironmentManagedProcessSession,
  type ManagedEnvironment,
} from "../src/index.ts";

const temporaryRoots: string[] = [];

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "subpolar-environment-"));
  temporaryRoots.push(root);
  const workspace = path.join(root, "workspaces", "repo", "worktree-a");
  await mkdir(workspace, { recursive: true });
  return {
    request: {
      ownerId: "owner-1",
      workspaceId: "workspace-1",
      storageRoot: path.join(root, "workspaces"),
      worktreePath: workspace,
    },
    root,
    workspace,
  };
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

class FakeBackend implements EnvironmentBackend {
  readonly id = "fake";
  readonly calls: string[] = [];
  readonly records = new Map<string, ManagedEnvironment>();
  mismatch = false;
  failStart = false;
  failCreateAfterAllocation = false;

  async inspect(identity: EnvironmentIdentity) {
    this.calls.push("inspect");
    const record = this.records.get(identity.id);
    return record ? (this.mismatch ? { ...record, ownerId: "other-owner" } : record) : null;
  }

  async create(identity: EnvironmentIdentity) {
    this.calls.push("create");
    const record: ManagedEnvironment = {
      ...identity,
      backendId: this.id,
      resourceId: `resource-${identity.id}`,
      status: "stopped",
    };
    this.records.set(record.id, record);
    if (this.failCreateAfterAllocation) throw new Error("manager exited after resource allocation");
    return record;
  }

  async start(environment: ManagedEnvironment) {
    this.calls.push("start");
    if (this.failStart) throw new Error("daemon unavailable");
    const record = { ...environment, status: "ready" as const };
    this.records.set(record.id, record);
    return record;
  }

  async stop(environment: ManagedEnvironment) {
    this.calls.push("stop");
    const record = { ...environment, status: "stopped" as const };
    this.records.set(record.id, record);
    return record;
  }

  async remove(environment: ManagedEnvironment) {
    this.calls.push("remove");
    this.records.delete(environment.id);
  }
}

describe("environment lifecycle coordinator", () => {
  test("derives a stable owner and worktree scoped identity", async () => {
    const { request } = await fixture();
    const manager = createEnvironmentManager(new FakeBackend());

    const first = await manager.identity(request);
    const second = await manager.identity({ ...request, worktreePath: path.join(request.storageRoot, "repo", ".", "worktree-a") });

    expect(first.id).toMatch(/^env_[a-f0-9]{32}$/);
    expect(second.id).toBe(first.id);
    expect(await manager.identity({ ...request, ownerId: "owner-2" })).not.toMatchObject({ id: first.id });
  });

  test("coalesces concurrent ensure calls and makes subsequent ensure/start idempotent", async () => {
    const { request } = await fixture();
    const backend = new FakeBackend();
    const manager = createEnvironmentManager(backend);

    const [first, concurrent] = await Promise.all([manager.ensure(request), manager.ensure(request)]);
    const started = await manager.start(request);
    const ensuredAgain = await manager.ensure(request);

    expect(first).toEqual(concurrent);
    expect(started).toEqual(first);
    expect(ensuredAgain).toEqual(first);
    expect(backend.calls.filter((call) => call === "create")).toHaveLength(1);
    expect(backend.calls.filter((call) => call === "start")).toHaveLength(1);
  });

  test("rebuild replaces the environment while preserving its worktree identity", async () => {
    const { request } = await fixture();
    const backend = new FakeBackend();
    const manager = createEnvironmentManager(backend);
    await manager.ensure(request);
    backend.calls.length = 0;

    const rebuilt = await manager.rebuild!(request);

    expect(rebuilt.status).toBe("ready");
    expect(rebuilt.worktreePath).toBe((await manager.identity(request)).worktreePath);
    expect(backend.calls).toEqual(["inspect", "remove", "create", "start"]);
  });

  test("restart stops and starts the same environment under one lifecycle operation", async () => {
    const { request } = await fixture();
    const backend = new FakeBackend();
    const manager = createEnvironmentManager(backend);
    await manager.ensure(request);
    backend.calls.length = 0;

    const restarted = await manager.restart!(request);

    expect(restarted.status).toBe("ready");
    expect(restarted.id).toBe((await manager.identity(request)).id);
    expect(backend.calls).toEqual(["inspect", "stop", "start"]);
  });

  test("restart records the stopped state when startup fails", async () => {
    const { request } = await fixture();
    const backend = new FakeBackend();
    const registrations = {
      records: new Map<string, { environment: ManagedEnvironment; createdAt: string; updatedAt: string }>(),
      async loadAll() { return [...this.records.values()]; },
      async save(environment: ManagedEnvironment, createdAt: string, updatedAt: string) {
        this.records.set(environment.id, { environment, createdAt, updatedAt });
      },
      async remove(id: string) { this.records.delete(id); },
    };
    const manager = createEnvironmentManager(backend, registrations);
    await manager.ensure(request);
    backend.failStart = true;

    await expect(manager.restart!(request)).rejects.toMatchObject({ code: "BACKEND_FAILURE" });
    const saved = [...registrations.records.values()][0]?.environment;
    expect(saved?.status).toBe("stopped");
  });

  test("rejects backend records owned by another principal", async () => {
    const { request } = await fixture();
    const backend = new FakeBackend();
    const manager = createEnvironmentManager(backend);
    const identity = await manager.identity(request);
    const record = await backend.create(identity);
    backend.mismatch = true;

    await expect(manager.start(request)).rejects.toMatchObject({ code: "OWNERSHIP_MISMATCH" });
    expect(record.ownerId).toBe(request.ownerId);
    expect(backend.calls).not.toContain("start");
  });

  test("propagates backend unavailability without a local execution fallback", async () => {
    const { request } = await fixture();
    const backend = new FakeBackend();
    backend.failStart = true;
    const manager = createEnvironmentManager(backend);

    await expect(manager.ensure(request)).rejects.toBeInstanceOf(EnvironmentManagerError);
    await expect(manager.ensure(request)).rejects.toMatchObject({ code: "BACKEND_FAILURE" });
    expect(backend.calls).toContain("create");
    expect(backend.calls.filter((call) => call === "start")).toHaveLength(2);
  });

  test("fails closed when a backend does not implement managed process execution", async () => {
    const { request } = await fixture();
    const backend = new FakeBackend();
    const manager = createEnvironmentManager(backend);

    await expect(manager.execute(request, ["echo", "hello"])).rejects.toMatchObject({
      code: "BACKEND_FAILURE",
      message: "Environment backend does not support managed process execution",
    });
    expect(backend.calls).toEqual([]);
  });

  test("binds interactive sessions to an environment and replays retained output after reconnect", async () => {
    const { request } = await fixture();
    const backend = new FakeBackend();
    let starts = 0;
    let terminated = 0;
    const interactiveBackend = {
      id: backend.id,
      inspect: backend.inspect.bind(backend),
      create: backend.create.bind(backend),
      start: backend.start.bind(backend),
      stop: backend.stop.bind(backend),
      remove: backend.remove.bind(backend),
      startInteractive: async (): Promise<EnvironmentInteractiveSession> => {
        starts += 1;
        return {
          async write() {},
          async resize() {},
          output: { async *[Symbol.asyncIterator]() { yield new TextEncoder().encode("prompt"); } },
          result: Promise.resolve({ exitCode: 0, cancelled: false }),
          async terminate() { terminated += 1; },
        };
      },
    };
    const manager = createEnvironmentManager(interactiveBackend);
    const first = await manager.startInteractive(request, ["/bin/sh"], { clientSessionId: "thread-terminal" });
    expect(first.outputSequence).toBe(0);

    const firstAttachment = manager.attachInteractiveOutput(request, first.sessionId)[Symbol.asyncIterator]();
    await expect(firstAttachment.next()).resolves.toMatchObject({ value: { type: "output", sequence: 1, data: new TextEncoder().encode("prompt") } });
    await firstAttachment.return?.();
    const replay = manager.attachInteractiveOutput(request, first.sessionId, 0)[Symbol.asyncIterator]();
    await expect(replay.next()).resolves.toMatchObject({ value: { type: "output", sequence: 1 } });
    await replay.return?.();
    const reconnected = await manager.startInteractive(request, ["/bin/sh"], { clientSessionId: "thread-terminal" });
    expect(reconnected).toEqual({ sessionId: first.sessionId, outputSequence: 1 });
    expect(starts).toBe(1);

    const resumed = [];
    for await (const event of manager.attachInteractiveOutput(request, first.sessionId, reconnected.outputSequence)) resumed.push(event);
    expect(resumed).toEqual([
      { type: "exit", result: { exitCode: 0, cancelled: false } },
    ]);

    await expect(manager.writeInteractive({ ...request, ownerId: "other-owner" }, first.sessionId, new Uint8Array([1])))
      .rejects.toMatchObject({ code: "OWNERSHIP_MISMATCH" });
    await manager.terminateInteractive(request, first.sessionId);
    expect(terminated).toBe(1);
    await manager.startInteractive(request, ["/bin/sh"]);
    await manager.stop(request);
    expect(terminated).toBe(2);
  });

  test("applies bounded backpressure to retained interactive output", async () => {
    const { request } = await fixture();
    const backend = new FakeBackend();
    const interactiveBackend = {
      id: backend.id,
      inspect: backend.inspect.bind(backend), create: backend.create.bind(backend),
      start: backend.start.bind(backend), stop: backend.stop.bind(backend), remove: backend.remove.bind(backend),
      startInteractive: async (): Promise<EnvironmentInteractiveSession> => ({
        async write() {}, async resize() {},
        output: { async *[Symbol.asyncIterator]() { yield new Uint8Array(1_048_576); yield new Uint8Array([1]); } },
        result: Promise.resolve({ exitCode: 0, cancelled: false }), async terminate() {},
      }),
    };
    const manager = createEnvironmentManager(interactiveBackend);
    const { sessionId } = await manager.startInteractive(request, ["/bin/sh"]);
    const events = [];
    for await (const event of manager.attachInteractiveOutput(request, sessionId)) events.push(event);
    expect(events.map((event) => event.type === "output" ? [event.sequence, event.data.byteLength] : [event.type])).toEqual([
      [1, 1_048_576], [2, 1], ["exit"],
    ]);
  });

  test("owns and resumes non-TTY sessions while preserving stdout and stderr", async () => {
    const { request } = await fixture();
    const backend = new FakeBackend();
    let starts = 0;
    let terminated = 0;
    const sessionBackend = {
      id: backend.id,
      inspect: backend.inspect.bind(backend), create: backend.create.bind(backend),
      start: backend.start.bind(backend), stop: backend.stop.bind(backend), remove: backend.remove.bind(backend),
      startManagedSession: async (): Promise<EnvironmentManagedProcessSession> => {
        starts += 1;
        return {
          async write() {},
          output: { async *[Symbol.asyncIterator]() {
            yield { stream: "stdout" as const, data: Buffer.from("jsonrpc") };
            yield { stream: "stderr" as const, data: Buffer.from("diagnostic") };
          } },
          result: Promise.resolve({ exitCode: 0, cancelled: false }),
          async terminate() { terminated += 1; },
        };
      },
    };
    const manager = createEnvironmentManager(sessionBackend);
    const started = await manager.startManagedSession(request, ["node", "acp-server.js"], { clientSessionId: "thread-acp" });
    const reconnected = await manager.startManagedSession(request, ["node", "acp-server.js"], { clientSessionId: "thread-acp" });
    expect(reconnected.sessionId).toBe(started.sessionId);
    expect(starts).toBe(1);

    const events = [];
    for await (const event of manager.attachManagedSessionOutput(request, started.sessionId)) events.push(event);
    expect(events).toEqual([
      { type: "output", sequence: 1, stream: "stdout", data: Buffer.from("jsonrpc") },
      { type: "output", sequence: 2, stream: "stderr", data: Buffer.from("diagnostic") },
      { type: "exit", result: { exitCode: 0, cancelled: false } },
    ]);
    await expect(manager.writeManagedSession({ ...request, ownerId: "other-owner" }, started.sessionId, Buffer.from("x")))
      .rejects.toMatchObject({ code: "OWNERSHIP_MISMATCH" });
    await manager.terminateManagedSession(request, started.sessionId);
    expect(terminated).toBe(1);
  });

  test("opens manager-owned TCP tunnels only to a valid worker loopback port", async () => {
    const { request } = await fixture();
    const backend = new FakeBackend();
    const commands: Array<{ command: readonly string[]; cwd?: string }> = [];
    const sessionBackend = {
      id: backend.id,
      inspect: backend.inspect.bind(backend), create: backend.create.bind(backend),
      start: backend.start.bind(backend), stop: backend.stop.bind(backend), remove: backend.remove.bind(backend),
      startManagedSession: async (_environment: ManagedEnvironment, command: readonly string[], process?: { cwd?: string }): Promise<EnvironmentManagedProcessSession> => {
        commands.push({ command, cwd: process?.cwd });
        return {
          async write() {},
          output: { async *[Symbol.asyncIterator]() {} },
          result: Promise.resolve({ exitCode: 0, cancelled: false }),
          async terminate() {},
        };
      },
    };
    const manager = createEnvironmentManager(sessionBackend);

    await expect(manager.startPortTunnel(request, 0)).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    const tunnel = await manager.startPortTunnel(request, 5173);

    expect(tunnel.sessionId).toBeTruthy();
    expect(commands).toHaveLength(1);
    expect(commands[0]?.command.slice(0, 2)).toEqual(["node", "-e"]);
    expect(commands[0]?.command[2]).toContain("host:'127.0.0.1'");
    expect(commands[0]?.command.at(-1)).toBe("5173");
    expect(commands[0]?.cwd).toBe(".");
  });

  test("rejects lexical and symlink escapes from the configured storage root", async () => {
    const { request, root } = await fixture();
    const outside = path.join(root, "outside");
    await mkdir(outside);
    const escapeLink = path.join(request.storageRoot, "escape");
    await symlink(outside, escapeLink);
    const manager = createEnvironmentManager(new FakeBackend());

    await expect(manager.identity({ ...request, worktreePath: outside })).rejects.toMatchObject({ code: "WORKTREE_OUTSIDE_ROOT" });
    await expect(manager.identity({ ...request, worktreePath: path.join(escapeLink, "missing") })).rejects.toBeInstanceOf(EnvironmentManagerError);
    await expect(manager.identity({ ...request, worktreePath: path.join(escapeLink, "..", "..", "outside") })).rejects.toMatchObject({ code: "WORKTREE_OUTSIDE_ROOT" });
  });

  test("reconciles a durable creation intent by adopting only the exact verified resource", async () => {
    const { request } = await fixture();
    const backend = new FakeBackend();
    backend.failCreateAfterAllocation = true;
    const registrations = {
      records: new Map<string, { environment: ManagedEnvironment; createdAt: string; updatedAt: string }>(),
      async loadAll() { return [...this.records.values()]; },
      async save(environment: ManagedEnvironment, createdAt: string, updatedAt: string) {
        this.records.set(environment.id, { environment, createdAt, updatedAt });
      },
      async remove(id: string) { this.records.delete(id); },
    };
    const firstManager = createEnvironmentManager(backend, registrations);

    await expect(firstManager.ensure(request)).rejects.toMatchObject({ code: "BACKEND_FAILURE" });
    const intent = [...registrations.records.values()][0]?.environment;
    expect(intent).toMatchObject({ status: "creating", resourceId: `pending:${intent?.id}` });

    backend.failCreateAfterAllocation = false;
    const restartedManager = createEnvironmentManager(backend, registrations);
    const [result] = await restartedManager.reconcile();

    expect(result?.environment).toEqual(backend.records.get(intent!.id));
    expect(result?.error).toBeUndefined();
    expect(backend.calls.filter((call) => call === "create")).toHaveLength(1);
    expect(backend.calls.filter((call) => call === "start")).toHaveLength(0);
  });

  test("reports registrations whose worktree disappeared as stale ownership", async () => {
    const { request, workspace } = await fixture();
    const backend = new FakeBackend();
    const registrations = {
      records: new Map<string, { environment: ManagedEnvironment; createdAt: string; updatedAt: string }>(),
      async loadAll() { return [...this.records.values()]; },
      async save(environment: ManagedEnvironment, createdAt: string, updatedAt: string) {
        this.records.set(environment.id, { environment, createdAt, updatedAt });
      },
      async remove(id: string) { this.records.delete(id); },
    };
    const manager = createEnvironmentManager(backend, registrations);
    const environment = await manager.ensure(request);
    backend.calls.length = 0;
    await rm(workspace, { recursive: true, force: true });

    const [result] = await manager.reconcile();
    expect(result?.environmentId).toBe(environment.id);
    expect(result?.error).toMatchObject({ code: "OWNERSHIP_MISMATCH", message: expect.stringContaining("stale") });
    expect(backend.calls).not.toContain("inspect");
  });
});
