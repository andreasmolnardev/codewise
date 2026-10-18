import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  createEnvironmentManager,
} from "../src/index.ts";
import {
  createDockerEnvironmentBackend,
  DockerEnvironmentError,
  type DockerClient,
  type DockerImageBuildRequest,
  type DockerContainerCreateOptions,
  type DockerContainerInspection,
  type DockerContainerProcessRequest,
  type DockerContainerManagedSessionRequest,
  type DockerVolumeCreateOptions,
  type DockerVolumeInspection,
  type DockerNetworkInspection,
  type DockerNetworkCreateOptions,
} from "../src/docker.ts";
import type { EnvironmentManagedProcessSession } from "../src/index.ts";

const tempRoots: string[] = [];

async function fixture(options: { readonly allowedDevContainerFeatures?: readonly string[]; readonly allowDevContainerCompose?: boolean } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "subpolar-docker-backend-"));
  tempRoots.push(root);
  const gatewayStorageRoot = path.join(root, "gateway-workspaces");
  const hostStorageRoot = path.join(root, "docker-host-workspaces");
  const gatewayWorktree = path.join(gatewayStorageRoot, "repo", "worktree-a");
  const hostWorktree = path.join(hostStorageRoot, "repo", "worktree-a");
  await Promise.all([
    mkdir(path.join(gatewayWorktree, ".git"), { recursive: true }),
    mkdir(path.join(hostWorktree, ".git"), { recursive: true }),
  ]);
  const request = {
    ownerId: "owner-1",
    workspaceId: "workspace-1",
    storageRoot: gatewayStorageRoot,
    worktreePath: gatewayWorktree,
  };
  const config = {
    gatewayStorageRoot,
    hostStorageRoot,
    containerStorageRoot: "/workspaces",
    image: "registry.example/subpolar-worker@sha256:0123456789abcdef",
    ...(options.allowedDevContainerFeatures === undefined ? {} : { allowedDevContainerFeatures: options.allowedDevContainerFeatures }),
    ...(options.allowDevContainerCompose === undefined ? {} : { allowDevContainerCompose: options.allowDevContainerCompose }),
  };
  const client = new FakeDockerClient();
  const backend = createDockerEnvironmentBackend(client, config);
  const manager = createEnvironmentManager(backend);
  const identity = await manager.identity(request);
  return { root, request, config, client, backend, manager, identity, hostWorktree };
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

class FakeDockerClient implements DockerClient {
  readonly containers = new Map<string, DockerContainerInspection>();
  readonly volumes = new Map<string, DockerVolumeInspection>();
  readonly networks = new Map<string, DockerNetworkInspection>();
  readonly createCalls: DockerContainerCreateOptions[] = [];
  readonly startCalls: string[] = [];
  readonly stopCalls: string[] = [];
  readonly removeCalls: string[] = [];
  readonly createVolumeCalls: DockerVolumeCreateOptions[] = [];
  readonly removeVolumeCalls: string[] = [];
  readonly processCalls: Array<{ id: string; request: DockerContainerProcessRequest }> = [];
  readonly processExitCodes: number[] = [];
  readonly postCreateRuns: string[] = [];
  private readonly completedPostCreateMarkers = new Set<string>();
  readonly managedSessionCalls: Array<{ id: string; request: DockerContainerManagedSessionRequest }> = [];
  readonly imageBuildCalls: DockerImageBuildRequest[] = [];
  readonly pulledImages: string[] = [];
  wrongOwner = false;

  async inspectContainer(name: string) {
    const current = this.containers.get(name);
    if (!current) return null;
    if (!this.wrongOwner) return current;
    return { ...current, labels: { ...current.labels, "io.subpolar.owner-sha256": "not-the-owner" } };
  }

  async createContainer(options: DockerContainerCreateOptions) {
    this.createCalls.push(options);
    const id = `docker-${options.name}-${this.createCalls.length}`;
    const inspection: DockerContainerInspection = {
      id,
      name: options.name,
      state: "created",
      labels: options.labels,
      config: {
        image: options.image,
        user: options.user,
        privileged: options.privileged,
        readOnlyRootfs: options.readOnlyRootfs,
        networkMode: options.networkMode,
        ...(options.networkAliases === undefined ? {} : { networkAliases: { [options.networkMode]: options.networkAliases } }),
        capDrop: options.capDrop,
        securityOpt: options.securityOpt,
        memoryBytes: options.memoryBytes,
        nanoCpus: options.nanoCpus,
        pidsLimit: options.pidsLimit,
        mounts: options.mounts,
        tmpfs: options.tmpfs,
        environment: options.environment,
      },
    };
    this.containers.set(options.name, inspection);
    const network = this.networks.get(options.networkMode);
    if (network) this.networks.set(network.name, {
      ...network,
      containerIds: [...network.containerIds, id],
      containerAliases: { ...network.containerAliases, [id]: options.networkAliases ?? [] },
    });
    return { id };
  }

  async buildImage(request: DockerImageBuildRequest) {
    this.imageBuildCalls.push(request);
  }

  async startContainer(id: string) {
    this.startCalls.push(id);
    this.update(id, { state: "running" });
  }

  async stopContainer(id: string, options: { readonly timeoutSeconds: 10 }) {
    expect(options.timeoutSeconds).toBe(10);
    this.stopCalls.push(id);
    this.update(id, { state: "exited" });
  }

  async removeContainer(id: string, options: { readonly force: false; readonly removeVolumes: false }) {
    expect(options).toEqual({ force: false, removeVolumes: false });
    this.removeCalls.push(id);
    for (const [name, container] of this.containers) if (container.id === id) {
      this.containers.delete(name);
      const network = this.networks.get(container.config.networkMode);
      if (network) {
        const containerAliases = { ...network.containerAliases };
        delete containerAliases[id];
        this.networks.set(network.name, { ...network, containerIds: network.containerIds.filter((entry) => entry !== id), containerAliases });
      }
    }
  }

  async inspectVolume(name: string) {
    return this.volumes.get(name) ?? null;
  }

  async createVolume(options: DockerVolumeCreateOptions) {
    this.createVolumeCalls.push(options);
    const volume = { name: options.name, driver: options.driver, labels: options.labels } satisfies DockerVolumeInspection;
    this.volumes.set(options.name, volume);
    return volume;
  }

  async removeVolume(name: string) {
    this.removeVolumeCalls.push(name);
    this.volumes.delete(name);
  }

  async inspectNetwork(name: string) { return this.networks.get(name) ?? null; }
  async createNetwork(options: DockerNetworkCreateOptions) {
    const network = { id: `network-${options.name}`, name: options.name, driver: options.driver, internal: options.internal, labels: options.labels, containerIds: [], containerAliases: {} } satisfies DockerNetworkInspection;
    this.networks.set(options.name, network);
    return network;
  }
  async removeNetwork(name: string) { this.networks.delete(name); }
  async waitContainerHealthy() {}
  async pullImage(image: string) { this.pulledImages.push(image); }

  async executeContainer(id: string, request: DockerContainerProcessRequest) {
    this.processCalls.push({ id, request });
    await request.onOutput?.({ stream: "stdout", data: new TextEncoder().encode("hello") });
    const exitCode = this.processExitCodes.shift() ?? 7;
    const [shell, option, script, , marker, , ...command] = request.command;
    if (shell === "/bin/sh" && option === "-c" && script?.includes('marker="$1"') && marker) {
      if (!this.completedPostCreateMarkers.has(marker) && exitCode === 0) {
        this.postCreateRuns.push(command.join(" "));
        this.completedPostCreateMarkers.add(marker);
      }
    }
    return { processId: "exec-1", exitCode, cancelled: request.signal?.aborted ?? false };
  }

  async startManagedSessionContainer(id: string, request: DockerContainerManagedSessionRequest): Promise<EnvironmentManagedProcessSession> {
    this.managedSessionCalls.push({ id, request });
    return {
      async write() {},
      output: { async *[Symbol.asyncIterator]() {} },
      result: Promise.resolve({ exitCode: null, cancelled: false }),
      async terminate() {},
    };
  }

  private update(id: string, patch: Partial<DockerContainerInspection>) {
    for (const [name, container] of this.containers) {
      if (container.id === id) this.containers.set(name, { ...container, ...patch });
    }
  }
}

function setLegacyContainerState(client: FakeDockerClient): string {
  const [name, current] = [...client.containers.entries()][0]!;
  const legacy: DockerContainerInspection = {
    ...current,
    config: {
      ...current.config,
      mounts: current.config.mounts.filter((mount) => mount.type === "bind"),
      environment: { HOME: "/tmp/home", TMPDIR: "/tmp" },
    },
  };
  client.containers.set(name, legacy);
  client.volumes.clear();
  return legacy.id;
}

describe("Docker environment backend", () => {
  test("verifies manager environment while allowing image defaults", async () => {
    const { manager, request, backend, identity, client } = await fixture();
    await manager.ensure(request);
    const [name, current] = [...client.containers.entries()][0]!;
    client.containers.set(name, {
      ...current,
      config: {
        ...current.config,
        environment: { ...current.config.environment, NODE_VERSION: "24.22.0", YARN_VERSION: "1.22.22" },
      },
    });

    await expect(backend.inspect(identity)).resolves.toMatchObject({ resourceId: current.id });

    client.containers.set(name, {
      ...client.containers.get(name)!,
      config: {
        ...client.containers.get(name)!.config,
        environment: { ...client.containers.get(name)!.config.environment, HOME: "/unexpected" },
      },
    });
    await expect(backend.inspect(identity)).rejects.toMatchObject({ code: "DOCKER_CONFIGURATION_MISMATCH" });
  });

  test("rejects provider egress until Docker-host firewall enforcement is available", async () => {
    const { client, config } = await fixture();

    let error: unknown;
    try {
      createDockerEnvironmentBackend(client, { ...config, egress: { allowHosts: ["api.example"] } });
    } catch (cause) {
      error = cause;
    }
    expect(error).toMatchObject({
      code: "EGRESS_UNAVAILABLE",
      message: expect.stringContaining("Docker-host firewall enforcement"),
    });
    expect(client.createCalls).toEqual([]);
  });

  test("executes argv in the verified mounted worktree and streams output", async () => {
    const { backend, identity, client } = await fixture();
    const created = await backend.create(identity);
    const ready = await backend.start(created);
    const output: string[] = [];
    const result = await backend.execute(ready, ["node", "-e", "process.exit(7)"], {
      cwd: "packages",
      environment: { NODE_ENV: "test" },
      onOutput: ({ stream, data }) => output.push(`${stream}:${new TextDecoder().decode(data)}`),
    });

    expect(result).toEqual({ processId: "exec-1", exitCode: 7, cancelled: false });
    expect(client.processCalls[0]).toMatchObject({
      id: ready.resourceId,
      request: {
        command: ["node", "-e", "process.exit(7)"],
        workingDirectory: "/workspaces/repo/worktree-a/packages",
        environment: { NODE_ENV: "test" },
      },
    });
    expect(output).toEqual(["stdout:hello"]);
  });

  test("keeps worker egress closed when a process supplies proxy environment variables", async () => {
    const { backend, identity, client } = await fixture();
    const ready = await backend.start(await backend.create(identity));

    await backend.execute(ready, ["node", "agent.js"], {
      cwd: ".",
      environment: {
        HTTPS_PROXY: "http://proxy.example:8080",
        ALL_PROXY: "socks5://proxy.example:1080",
      },
    });

    expect(client.createCalls[0]?.networkMode).toBe("none");
    expect(client.processCalls[0]?.request.environment).toEqual({
      HTTPS_PROXY: "http://proxy.example:8080",
      ALL_PROXY: "socks5://proxy.example:1080",
    });
  });

  test("starts non-TTY process sessions inside the verified mounted worktree", async () => {
    const { backend, identity, client } = await fixture();
    const ready = await backend.start(await backend.create(identity));
    const session = await backend.startManagedSession(ready, ["node", "acp-server.js"], {
      cwd: "packages", environment: { MODE: "stdio" }, clientSessionId: "thread-acp",
    });
    expect(client.managedSessionCalls[0]).toMatchObject({
      id: ready.resourceId,
      request: {
        command: ["node", "acp-server.js"],
        worktreeDirectory: "/workspaces/repo/worktree-a",
        workingDirectory: "/workspaces/repo/worktree-a/packages",
        environment: { MODE: "stdio" },
      },
    });
    await expect(backend.startManagedSession({ ...ready, ownerId: "other-owner" }, ["node"], {})).rejects.toMatchObject({ code: "DOCKER_IDENTITY_MISMATCH" });
    await session.terminate();
  });

  test("starts ACP workers from the configured Dev Container workspaceFolder", async () => {
    const { backend, identity, client } = await fixture();
    await mkdir(path.join(identity.worktreePath, ".devcontainer"), { recursive: true });
    await Bun.write(path.join(identity.worktreePath, ".devcontainer", "devcontainer.json"), JSON.stringify({
      image: "project:latest",
      workspaceFolder: "/workspaces/repo/worktree-a/apps/web",
    }));
    const ready = await backend.start(await backend.create(identity));
    const session = await backend.startManagedSession(ready, ["node", "acp-server.js"], { cwd: "." });

    expect(client.managedSessionCalls[0]?.request.workingDirectory).toBe("/workspaces/repo/worktree-a/apps/web");
    await session.terminate();
  });

  test("rejects process working directories that escape the worktree", async () => {
    const { backend, identity, client } = await fixture();
    const ready = await backend.start(await backend.create(identity));

    await expect(backend.execute(ready, ["id"], { cwd: "../../etc" })).rejects.toMatchObject({ code: "PROCESS_REQUEST_INVALID" });
    expect(client.processCalls).toEqual([]);
  });

  test("maps the explicit gateway path to the daemon host and enforces safe defaults", async () => {
    const { client, manager, request, identity, config } = await fixture();
    const created = await manager.ensure(request);
    const options = client.createCalls[0]!;

    expect(created.status).toBe("ready");
    expect(options.mounts).toEqual([
      {
        type: "bind",
        source: await realpath(path.join(config.hostStorageRoot, "repo", "worktree-a")),
        target: "/workspaces/repo/worktree-a",
        readOnly: false,
      },
      { type: "volume", source: `${options.name}-data`, target: "/var/lib/subpolar", readOnly: false },
    ]);
    expect(options).toMatchObject({
      user: "1000:1000",
      privileged: false,
      readOnlyRootfs: true,
      networkMode: "none",
      capDrop: ["ALL"],
      securityOpt: ["no-new-privileges:true"],
      memoryBytes: 1024 * 1024 * 1024,
      nanoCpus: 1_000_000_000,
      pidsLimit: 256,
    });
    expect(JSON.stringify(options)).not.toContain("docker.sock");
    expect(options.environment).toMatchObject({ SUBPOLAR_RUNTIME_DATA_DIR: "/var/lib/subpolar" });
    expect(options.mounts).toHaveLength(2);
    expect(client.createVolumeCalls).toHaveLength(1);
  });

  test("discovers a JSONC image configuration while keeping manager isolation defaults", async () => {
    const { client, manager, request, identity, config } = await fixture();
    await mkdir(path.join(identity.worktreePath, ".devcontainer"), { recursive: true });
    await Bun.write(path.join(identity.worktreePath, ".devcontainer", "devcontainer.json"), `{
      // A project image is supported without granting it host access.
      "$schema": "https://containers.dev/schema/devContainer.schema.json",
      "name": "worker",
      "image": "registry.example/project@sha256:abcdef",
    }`);

    await manager.ensure(request);

    expect(client.createCalls[0]).toMatchObject({
      image: "registry.example/project@sha256:abcdef",
      privileged: false,
      networkMode: "none",
      mounts: [
        { source: await realpath(path.join(config.hostStorageRoot, "repo", "worktree-a")) },
        { type: "volume", target: "/var/lib/subpolar", readOnly: false },
      ],
    });
  });

  test("runs postCreate once per persistent marker and postStart on each worker start", async () => {
    const { client, manager, request, identity } = await fixture();
    await mkdir(path.join(identity.worktreePath, ".devcontainer"), { recursive: true });
    await Bun.write(path.join(identity.worktreePath, ".devcontainer", "devcontainer.json"), JSON.stringify({
      image: "project:latest",
      postCreateCommand: "npm install",
      postStartCommand: ["node", "setup.js"],
    }));
    client.processExitCodes.push(0, 0, 0, 0);

    const first = await manager.ensure(request);
    expect(client.processCalls).toHaveLength(2);
    expect(client.processCalls[0]?.request.command).toEqual(expect.arrayContaining([
      expect.stringContaining("post-create-"),
      "npm install",
    ]));
    expect(client.processCalls[0]?.request.workingDirectory).toBe("/workspaces/repo/worktree-a");
    expect(client.processCalls[1]?.request.command).toEqual(["node", "setup.js"]);

    await manager.stop(request);
    const restarted = await manager.start(request);
    expect(restarted.resourceId).toBe(first.resourceId);
    expect(client.createCalls).toHaveLength(1);
    expect(client.startCalls).toHaveLength(2);
    expect(client.processCalls).toHaveLength(4);
    expect(client.processCalls[2]?.request.command).toEqual(client.processCalls[0]?.request.command);
    expect(client.processCalls[3]?.request.command).toEqual(["node", "setup.js"]);
    expect(client.postCreateRuns).toEqual(["/bin/sh -c npm install"]);
  });

  test("supports a workspace bind mount only when it maps the current worktree", async () => {
    const { client, manager, request, identity, config } = await fixture();
    await mkdir(path.join(identity.worktreePath, ".devcontainer"), { recursive: true });
    await Bun.write(path.join(identity.worktreePath, ".devcontainer", "devcontainer.json"), JSON.stringify({
      image: "project:latest",
      workspaceMount: "source=${localWorkspaceFolder},target=/workspaces/project,type=bind,consistency=cached",
      workspaceFolder: "/workspaces/project/app",
      postStartCommand: "pwd",
    }));
    client.processExitCodes.push(0);

    await manager.ensure(request);

    expect(client.createCalls[0]?.mounts[0]).toMatchObject({
      type: "bind",
      source: await realpath(path.join(config.hostStorageRoot, "repo", "worktree-a")),
      target: "/workspaces/project",
      readOnly: false,
    });
    expect(client.processCalls[0]?.request.workingDirectory).toBe("/workspaces/project/app");
  });

  test("supports workspaceFolder under the default isolated worktree mount", async () => {
    const { client, manager, request, identity } = await fixture();
    await mkdir(path.join(identity.worktreePath, ".devcontainer"), { recursive: true });
    await Bun.write(path.join(identity.worktreePath, ".devcontainer", "devcontainer.json"), JSON.stringify({
      image: "project:latest",
      workspaceFolder: "/workspaces/repo/worktree-a/apps/web",
      postStartCommand: "pwd",
    }));
    client.processExitCodes.push(0);

    await manager.ensure(request);

    expect(client.createCalls[0]?.mounts[0]?.target).toBe("/workspaces/repo/worktree-a");
    expect(client.processCalls[0]?.request.workingDirectory).toBe("/workspaces/repo/worktree-a/apps/web");
  });

  test("stops and fails closed when postCreate fails, then retries on the same container", async () => {
    const { client, backend, identity } = await fixture();
    await mkdir(path.join(identity.worktreePath, ".devcontainer"), { recursive: true });
    await Bun.write(path.join(identity.worktreePath, ".devcontainer", "devcontainer.json"), JSON.stringify({
      image: "project:latest",
      postCreateCommand: ["./setup.sh"],
    }));
    client.processExitCodes.push(9, 0);
    const created = await backend.create(identity);

    await expect(backend.start(created)).rejects.toMatchObject({ code: "DEV_CONTAINER_SETUP_FAILED" });
    expect(client.stopCalls).toEqual([created.resourceId]);
    expect(client.containers.get(client.createCalls[0]!.name)?.state).toBe("exited");

    const retried = await backend.start(created);
    expect(retried.resourceId).toBe(created.resourceId);
    expect(retried.status).toBe("ready");
    expect(client.createCalls).toHaveLength(1);
    expect(client.processCalls).toHaveLength(2);
    expect(client.postCreateRuns).toEqual(["./setup.sh"]);
  });

  test("reruns postCreate for a rebuilt container generation", async () => {
    const { client, manager, request, identity } = await fixture();
    await mkdir(path.join(identity.worktreePath, ".devcontainer"), { recursive: true });
    await Bun.write(path.join(identity.worktreePath, ".devcontainer", "devcontainer.json"), JSON.stringify({
      image: "project:latest",
      postCreateCommand: ["./setup.sh"],
    }));
    client.processExitCodes.push(0, 0);

    const first = await manager.ensure(request);
    const rebuilt = await manager.rebuild!(request);

    expect(rebuilt.resourceId).not.toBe(first.resourceId);
    expect(client.createCalls).toHaveLength(2);
    expect(client.postCreateRuns).toEqual(["./setup.sh", "./setup.sh"]);
    const firstMarker = client.processCalls[0]?.request.command[4];
    const rebuiltMarker = client.processCalls[1]?.request.command[4];
    expect(firstMarker).toBeDefined();
    expect(rebuiltMarker).toBeDefined();
    expect(rebuiltMarker).not.toBe(firstMarker);
    expect(client.processCalls[0]?.request.command[5]).toMatch(/^\/tmp\/subpolar-post-create-/);
    expect(client.processCalls[1]?.request.command[5]).toMatch(/^\/tmp\/subpolar-post-create-/);
  });

  test("stops a worker when postStart fails", async () => {
    const { client, backend, identity } = await fixture();
    await mkdir(path.join(identity.worktreePath, ".devcontainer"), { recursive: true });
    await Bun.write(path.join(identity.worktreePath, ".devcontainer", "devcontainer.json"), JSON.stringify({
      image: "project:latest",
      postStartCommand: "./start.sh",
    }));
    client.processExitCodes.push(12);
    const created = await backend.create(identity);

    await expect(backend.start(created)).rejects.toMatchObject({ code: "DEV_CONTAINER_SETUP_FAILED" });
    expect(client.stopCalls).toEqual([created.resourceId]);
    expect(client.containers.get(client.createCalls[0]!.name)?.state).toBe("exited");
  });

  test("applies literal Dev Container containerEnv values and verifies them on inspection", async () => {
    const { client, manager, request, identity, backend } = await fixture();
    await mkdir(path.join(identity.worktreePath, ".devcontainer"), { recursive: true });
    await Bun.write(path.join(identity.worktreePath, ".devcontainer", "devcontainer.json"), JSON.stringify({
      image: "project:latest",
      containerEnv: { NODE_ENV: "development", FEATURE_FLAG: "enabled" },
    }));

    const created = await manager.ensure(request);
    expect(client.createCalls[0]?.environment).toMatchObject({
      HOME: "/tmp/home",
      TMPDIR: "/tmp",
      SUBPOLAR_RUNTIME_DATA_DIR: "/var/lib/subpolar",
      NODE_ENV: "development",
      FEATURE_FLAG: "enabled",
    });
    expect(await backend.inspect(identity)).toMatchObject({ resourceId: created.resourceId });
  });

  test("rejects Dev Container environment interpolation and reserved runtime variables", async () => {
    for (const containerEnv of [
      { API_TOKEN: "${localEnv:API_TOKEN}" },
      { SUBPOLAR_RUNTIME_DATA_DIR: "/workspace/.subpolar" },
    ]) {
      const { client, manager, request, identity } = await fixture();
      await mkdir(path.join(identity.worktreePath, ".devcontainer"), { recursive: true });
      await Bun.write(path.join(identity.worktreePath, ".devcontainer", "devcontainer.json"), JSON.stringify({
        image: "project:latest",
        containerEnv,
      }));

      await expect(manager.ensure(request)).rejects.toMatchObject({ cause: { code: "DEV_CONTAINER_CONFIGURATION_INVALID" } });
      expect(client.createCalls).toEqual([]);
    }
  });

  test("builds a contained Dev Container Dockerfile in the manager mapped context", async () => {
    const { client, manager, request, identity, config, hostWorktree } = await fixture();
    const gatewayDevContainer = path.join(identity.worktreePath, ".devcontainer");
    const hostDevContainer = path.join(hostWorktree, ".devcontainer");
    await Promise.all([
      mkdir(gatewayDevContainer, { recursive: true }),
      mkdir(hostDevContainer, { recursive: true }),
    ]);
    await Promise.all([
      Bun.write(path.join(gatewayDevContainer, "devcontainer.json"), JSON.stringify({ build: { dockerfile: "Dockerfile", context: "." } })),
      Bun.write(path.join(hostDevContainer, "devcontainer.json"), JSON.stringify({ build: { dockerfile: "Dockerfile", context: "." } })),
      Bun.write(path.join(gatewayDevContainer, "Dockerfile"), "FROM node:22\n"),
      Bun.write(path.join(hostDevContainer, "Dockerfile"), "FROM node:22\n"),
    ]);

    await manager.ensure(request);

    expect(client.imageBuildCalls).toHaveLength(1);
    expect(client.imageBuildCalls[0]).toEqual({
      kind: "dockerfile",
      contextPath: await realpath(hostDevContainer),
      dockerfilePath: await realpath(path.join(hostDevContainer, "Dockerfile")),
      image: client.createCalls[0]?.image,
    });
    expect(client.createCalls[0]?.image).toMatch(/^subpolar-devcontainer:[a-f0-9]{32}$/);
    expect(client.createCalls[0]?.privileged).toBe(false);
    expect(client.createCalls[0]?.networkMode).toBe("none");
  });

  test("builds image-based Features through the locked Dev Container CLI and then runs lifecycle hooks", async () => {
    const feature = "ghcr.io/devcontainers/features/node:1";
    const { client, manager, request, identity, hostWorktree } = await fixture({ allowedDevContainerFeatures: [feature] });
    const gatewayDevContainer = path.join(identity.worktreePath, ".devcontainer");
    const hostDevContainer = path.join(hostWorktree, ".devcontainer");
    const configSource = JSON.stringify({
      image: "node:22",
      features: { [feature]: { version: "22" } },
      postCreateCommand: "npm install",
      postStartCommand: ["node", "setup.js"],
    });
    client.processExitCodes.push(0, 0);
    const lockfile = JSON.stringify({ features: { [feature]: { version: "1.0.0", resolved: "ghcr.io/devcontainers/features/node@sha256:" + "a".repeat(64) } } });
    await Promise.all([
      mkdir(gatewayDevContainer, { recursive: true }),
      mkdir(hostDevContainer, { recursive: true }),
      Bun.write(path.join(identity.worktreePath, ".devcontainer-lock.json"), lockfile),
      Bun.write(path.join(hostWorktree, ".devcontainer-lock.json"), lockfile),
      Bun.write(path.join(gatewayDevContainer, "devcontainer.json"), configSource),
      Bun.write(path.join(hostDevContainer, "devcontainer.json"), configSource),
    ]);

    await manager.ensure(request);

    expect(client.imageBuildCalls).toHaveLength(1);
    expect(client.imageBuildCalls[0]).toEqual({
      kind: "devcontainer",
      workspaceFolder: await realpath(hostWorktree),
      configurationPath: await realpath(path.join(hostDevContainer, "devcontainer.json")),
      image: client.createCalls[0]?.image,
    });
    expect(client.processCalls.map(({ request: processRequest }) => processRequest.command.slice(-3))).toContainEqual(["/bin/sh", "-c", "npm install"]);
    expect(client.processCalls.map(({ request: processRequest }) => processRequest.command)).toContainEqual(["node", "setup.js"]);
  });

  test("builds Dockerfile-based Features with the pinned official CLI request", async () => {
    const feature = "ghcr.io/devcontainers/features/git:1";
    const { client, manager, request, identity, hostWorktree } = await fixture({ allowedDevContainerFeatures: [feature] });
    const gatewayDevContainer = path.join(identity.worktreePath, ".devcontainer");
    const hostDevContainer = path.join(hostWorktree, ".devcontainer");
    const configSource = JSON.stringify({ build: { dockerfile: "Dockerfile", context: "." }, features: { [feature]: {} } });
    const lockfile = JSON.stringify({ features: { [feature]: { version: "1.0.0", resolved: "ghcr.io/devcontainers/features/git@sha256:" + "b".repeat(64) } } });
    await Promise.all([
      mkdir(gatewayDevContainer, { recursive: true }),
      mkdir(hostDevContainer, { recursive: true }),
      Bun.write(path.join(identity.worktreePath, ".devcontainer-lock.json"), lockfile),
      Bun.write(path.join(hostWorktree, ".devcontainer-lock.json"), lockfile),
      Bun.write(path.join(gatewayDevContainer, "devcontainer.json"), configSource),
      Bun.write(path.join(hostDevContainer, "devcontainer.json"), configSource),
      Bun.write(path.join(gatewayDevContainer, "Dockerfile"), "FROM alpine:3.21\n"),
      Bun.write(path.join(hostDevContainer, "Dockerfile"), "FROM alpine:3.21\n"),
    ]);

    await manager.ensure(request);

    expect(client.imageBuildCalls[0]).toEqual({
      kind: "devcontainer",
      workspaceFolder: await realpath(hostWorktree),
      configurationPath: await realpath(path.join(hostDevContainer, "devcontainer.json")),
      image: client.createCalls[0]?.image,
    });
  });

  test("rejects privileged requests even when the feature is authorized", async () => {
    const feature = "ghcr.io/devcontainers/features/node:1";
    const { client, identity, backend } = await fixture({ allowedDevContainerFeatures: [feature] });
    await mkdir(path.join(identity.worktreePath, ".devcontainer"), { recursive: true });
    await Bun.write(path.join(identity.worktreePath, ".devcontainer-lock.json"), JSON.stringify({ features: {} }));
    await Bun.write(path.join(identity.worktreePath, ".devcontainer", "devcontainer.json"), JSON.stringify({
      image: "node:22",
      features: { [feature]: {} },
      privileged: true,
    }));

    await expect(backend.inspectForLifecycle!(identity)).rejects.toMatchObject({
      code: "DEV_CONTAINER_CONFIGURATION_UNSUPPORTED",
    });
    expect(client.imageBuildCalls).toEqual([]);
    expect(client.createCalls).toEqual([]);
  });

  test("rejects Dockerfile contexts or files that escape their mapped worktree", async () => {
    const { client, manager, request, identity } = await fixture();
    const devContainer = path.join(identity.worktreePath, ".devcontainer");
    await mkdir(devContainer, { recursive: true });
    await Bun.write(path.join(devContainer, "devcontainer.json"), JSON.stringify({ build: { dockerfile: "Dockerfile", context: "../../outside" } }));

    await expect(manager.ensure(request)).rejects.toMatchObject({ cause: { code: "DEV_CONTAINER_CONFIGURATION_INVALID" } });
    expect(client.imageBuildCalls).toEqual([]);
    expect(client.createCalls).toEqual([]);
  });

  test("does not create an environment if its Dev Container image build fails", async () => {
    const { client, manager, request, identity, hostWorktree } = await fixture();
    const gatewayDevContainer = path.join(identity.worktreePath, ".devcontainer");
    const hostDevContainer = path.join(hostWorktree, ".devcontainer");
    await Promise.all([
      mkdir(gatewayDevContainer, { recursive: true }),
      mkdir(hostDevContainer, { recursive: true }),
    ]);
    await Promise.all([
      Bun.write(path.join(gatewayDevContainer, "devcontainer.json"), '{"build":{"dockerfile":"Dockerfile"}}'),
      Bun.write(path.join(gatewayDevContainer, "Dockerfile"), "FROM node:22\n"),
      Bun.write(path.join(hostDevContainer, "Dockerfile"), "FROM node:22\n"),
    ]);
    client.buildImage = async () => { throw new Error("builder failed"); };

    await expect(manager.ensure(request)).rejects.toMatchObject({ cause: { code: "DEV_CONTAINER_BUILD_FAILED" } });
    expect(client.createCalls).toEqual([]);
  });

  test("requires an explicit choice when several Dev Container configurations exist", async () => {
    const { client, manager, request, identity } = await fixture();
    await mkdir(path.join(identity.worktreePath, ".devcontainer", "api"), { recursive: true });
    await mkdir(path.join(identity.worktreePath, ".devcontainer", "web"), { recursive: true });
    await Promise.all([
      Bun.write(path.join(identity.worktreePath, ".devcontainer", "api", "devcontainer.json"), '{"image":"api:latest"}'),
      Bun.write(path.join(identity.worktreePath, ".devcontainer", "web", "devcontainer.json"), '{"image":"web:latest"}'),
    ]);

    await expect(manager.ensure(request)).rejects.toMatchObject({
      cause: { code: "DEV_CONTAINER_CONFIGURATION_SELECTION_REQUIRED" },
    });
    expect(client.createCalls).toEqual([]);
  });

  test("rejects features, arbitrary mounts, and unsafe container options explicitly", async () => {
    const unsupportedConfigurations = [
      [{ features: { "ghcr.io/devcontainers/features/node:1": {} } }, /Features/],
      [{ mounts: ["source=/var/run/docker.sock,target=/var/run/docker.sock,type=bind"] }, /mounts/],
      [{ privileged: true }, /privileged/],
      [{ capAdd: ["SYS_ADMIN"] }, /capAdd/],
      [{ runArgs: ["--privileged"] }, /runArgs/],
      [{ forwardPorts: [3000] }, /forwardPorts/],
    ] as const;
    for (const [configuration, message] of unsupportedConfigurations) {
      const { client, identity, backend } = await fixture();
      await mkdir(path.join(identity.worktreePath, ".devcontainer"), { recursive: true });
      await Bun.write(path.join(identity.worktreePath, ".devcontainer", "devcontainer.json"), JSON.stringify({
        image: "project:latest",
        ...configuration,
      }));

      let failure: unknown;
      try {
        await backend.inspectForLifecycle!(identity);
      } catch (cause) {
        failure = cause;
      }
      expect(failure).toBeInstanceOf(DockerEnvironmentError);
      expect((failure as DockerEnvironmentError).code).toBe("DEV_CONTAINER_CONFIGURATION_UNSUPPORTED");
      expect(message.test((failure as Error).message)).toBe(true);
      expect(client.createCalls).toEqual([]);
      expect(client.imageBuildCalls).toEqual([]);
    }
  });

  test("runs the selected Compose app with an owned PostgreSQL sidecar on an internal network", async () => {
    const { client, manager, request, identity, hostWorktree } = await fixture({ allowDevContainerCompose: true });
    const directory = path.join(identity.worktreePath, ".devcontainer");
    await mkdir(directory, { recursive: true });
    await Promise.all([
      Bun.write(path.join(directory, "devcontainer.json"), JSON.stringify({
        dockerComposeFile: "compose.yaml",
        service: "app",
        runServices: ["app", "db"],
        workspaceMount: "source=${localWorkspaceFolder},target=/workspaces/project,type=bind",
        workspaceFolder: "/workspaces/project",
      })),
      Bun.write(path.join(directory, "compose.yaml"), [
        "services:",
        "  app:",
        "    image: subpolar/worker:1.0",
        "    depends_on:",
        "      - db",
        "  db:",
        "    image: postgres:16",
        "    environment:",
        "      POSTGRES_DB: app",
        "      POSTGRES_USER: app",
        "      POSTGRES_PASSWORD: local-test-password",
        "    volumes:",
        "      - subpolar-data:/var/lib/postgresql/data",
        "volumes:",
        "  subpolar-data: {}",
      ].join("\n")),
    ]);

    const created = await manager.ensure(request);
    expect(client.createCalls).toHaveLength(2);
    const databaseOptions = client.createCalls.find((call) => call.name.endsWith("-db"))!;
    const workerOptions = client.createCalls.find((call) => call.name === `subpolar-${identity.id}`)!;
    expect(databaseOptions.image).toBe("postgres:16");
    expect(databaseOptions.user).toBe("999:999");
    expect(databaseOptions.networkMode).toMatch(/^subpolar-net-/);
    expect(databaseOptions.readOnlyRootfs).toBe(true);
    expect(databaseOptions.privileged).toBe(false);
    expect(databaseOptions.mounts[0]).toMatchObject({ type: "volume", target: "/var/lib/postgresql/data", readOnly: false });
    expect(workerOptions.networkMode).toBe(databaseOptions.networkMode);
    expect(workerOptions.mounts[0]).toMatchObject({ source: await realpath(hostWorktree), target: "/workspaces/project" });
    expect(client.pulledImages).toEqual(["postgres:16"]);
    expect(client.networks.get(databaseOptions.networkMode)?.internal).toBe(true);

    expect(client.startCalls).toEqual([client.containers.get(databaseOptions.name)?.id, client.containers.get(workerOptions.name)?.id]);
    await manager.start(request);
    await manager.stop(request);
    expect(client.stopCalls).toEqual([client.containers.get(workerOptions.name)?.id, client.containers.get(databaseOptions.name)?.id]);
    await manager.remove(request);
    expect(client.networks.has(databaseOptions.networkMode)).toBe(false);
    expect(client.volumes.has(databaseOptions.mounts[0]!.source)).toBe(false);
  });

  test("rejects Compose by default before creating Docker resources", async () => {
    const { client, backend, identity } = await fixture();
    const directory = path.join(identity.worktreePath, ".devcontainer");
    await mkdir(directory, { recursive: true });
    await Bun.write(path.join(directory, "devcontainer.json"), JSON.stringify({ dockerComposeFile: "compose.yaml", service: "app" }));
    await Bun.write(path.join(directory, "compose.yaml"), "services:\n  app:\n    image: project:latest\n");

    await expect(backend.inspectForLifecycle!(identity)).rejects.toMatchObject({
      code: "DEV_CONTAINER_CONFIGURATION_UNSUPPORTED",
      message: expect.stringContaining("SUBPOLAR_ENABLE_DEVCONTAINER_COMPOSE=true"),
    });
    expect(client.createCalls).toEqual([]);
    expect(client.networks.size).toBe(0);
    expect(client.volumes.size).toBe(0);
  });

  test("rejects extra Compose services, app side effects, and unmanaged database storage", async () => {
    const invalidFiles = [
      "services:\n  app:\n    image: project:latest\n  cache:\n    image: redis:7\n",
      "services:\n  app:\n    image: project:latest\n    privileged: true\n",
      "services:\n  app:\n    image: project:latest\n    ports: ['3000:3000']\n",
      "services:\n  app:\n    image: project:latest\n  db:\n    image: postgres:16\n    environment:\n      POSTGRES_PASSWORD: secret\n    volumes:\n      - /tmp/db:/var/lib/postgresql/data\n",
      "services:\n  app:\n    image: project:latest\n  db:\n    image: postgres:16\n    environment:\n      POSTGRES_PASSWORD: ${DB_PASSWORD}\n    volumes:\n      - subpolar-data:/var/lib/postgresql/data\nvolumes:\n  subpolar-data: {}\n",
    ];
    for (const composeSource of invalidFiles) {
      const { client, backend, identity } = await fixture({ allowDevContainerCompose: true });
      const directory = path.join(identity.worktreePath, ".devcontainer");
      await mkdir(directory, { recursive: true });
      await Bun.write(path.join(directory, "devcontainer.json"), JSON.stringify({ dockerComposeFile: "compose.yaml", service: "app" }));
      await Bun.write(path.join(directory, "compose.yaml"), composeSource);

      await expect(backend.inspectForLifecycle!(identity)).rejects.toBeInstanceOf(DockerEnvironmentError);
      expect(client.createCalls).toEqual([]);
      expect(client.networks.size).toBe(0);
      expect(client.volumes.size).toBe(0);
    }
  });

  test("rejects workspace mounts that escape the container worktree namespace", async () => {
    for (const workspaceMount of [
      "source=/etc,target=/workspaces/project,type=bind",
      "source=${localWorkspaceFolder},target=/var/lib/subpolar,type=bind",
      "source=${localWorkspaceFolder},target=/etc,type=bind",
      "source=${localWorkspaceFolder},target=/workspaces/project,type=volume",
    ]) {
      const { client, manager, request, identity } = await fixture();
      await mkdir(path.join(identity.worktreePath, ".devcontainer"), { recursive: true });
      await Bun.write(path.join(identity.worktreePath, ".devcontainer", "devcontainer.json"), JSON.stringify({ image: "project:latest", workspaceMount }));

      await expect(manager.ensure(request)).rejects.toBeTruthy();
      expect(client.createCalls).toEqual([]);
    }
  });

  test("uses the configured default selection for multiple Dev Container configurations", async () => {
    const { client, request, identity, config } = await fixture();
    await mkdir(path.join(identity.worktreePath, ".devcontainer", "api"), { recursive: true });
    await mkdir(path.join(identity.worktreePath, ".devcontainer", "web"), { recursive: true });
    await Promise.all([
      Bun.write(path.join(identity.worktreePath, ".devcontainer", "api", "devcontainer.json"), '{"image":"api:latest"}'),
      Bun.write(path.join(identity.worktreePath, ".devcontainer", "web", "devcontainer.json"), '{"image":"web:latest"}'),
    ]);
    const selected = createDockerEnvironmentBackend(client, {
      ...config,
      defaultDevContainerConfiguration: ".devcontainer/api/devcontainer.json",
    });

    await createEnvironmentManager(selected).ensure(request);
    expect(client.createCalls[0]?.image).toBe("api:latest");
  });

  test("verifies owner labels before every lifecycle operation", async () => {
    const { backend, client, identity } = await fixture();
    const created = await backend.create(identity);
    client.wrongOwner = true;

    await expect(backend.start(created)).rejects.toMatchObject({ code: "DOCKER_IDENTITY_MISMATCH" });
    expect(client.startCalls).toEqual([]);
    await expect(backend.stop(created)).rejects.toMatchObject({ code: "DOCKER_IDENTITY_MISMATCH" });
    expect(client.stopCalls).toEqual([]);
    await expect(backend.remove(created)).rejects.toMatchObject({ code: "DOCKER_IDENTITY_MISMATCH" });
    expect(client.removeCalls).toEqual([]);
  });

  test("rejects a linked Git worktree when shared metadata roots are not configured", async () => {
    const { backend, client, identity, request } = await fixture();
    await rm(path.join(identity.worktreePath, ".git"), { recursive: true });
    await Bun.write(path.join(identity.worktreePath, ".git"), "gitdir: ../../.git/worktrees/worktree-a\n");
    await Bun.write(path.join(request.storageRoot, "repo", "worktree-a", ".git"), "gitdir: ../../.git/worktrees/worktree-a\n");

    await expect(backend.create(identity)).rejects.toBeInstanceOf(DockerEnvironmentError);
    await expect(backend.create(identity)).rejects.toMatchObject({ code: "UNSUPPORTED_GIT_LAYOUT" });
    expect(client.createCalls).toEqual([]);
  });

  test("mounts only the verified shared Git directory for a linked T3 worktree", async () => {
    const { backend, client, identity, config, root } = await fixture();
    const gatewayGitRoot = path.join(root, "gateway-git-metadata");
    const hostGitRoot = path.join(root, "docker-host-git-metadata");
    const gatewayCommonDir = path.join(gatewayGitRoot, "project", ".git");
    const hostCommonDir = path.join(hostGitRoot, "project", ".git");
    const gatewayGitDir = path.join(gatewayCommonDir, "worktrees", "t3-worktree");
    const hostGitDir = path.join(hostCommonDir, "worktrees", "t3-worktree");
    await Promise.all([
      mkdir(gatewayGitDir, { recursive: true }),
      mkdir(hostGitDir, { recursive: true }),
    ]);
    await Promise.all([
      rm(path.join(identity.worktreePath, ".git"), { recursive: true }),
      rm(path.join(config.hostStorageRoot, "repo", "worktree-a", ".git"), { recursive: true }),
    ]);
    await Promise.all([
      Bun.write(path.join(gatewayGitDir, "commondir"), "../..\n"),
      Bun.write(path.join(hostGitDir, "commondir"), "../..\n"),
      Bun.write(path.join(identity.worktreePath, ".git"), `gitdir: ${gatewayGitDir}\n`),
      Bun.write(path.join(config.hostStorageRoot, "repo", "worktree-a", ".git"), `gitdir: ${hostGitDir}\n`),
    ]);

    const linkedBackend = createDockerEnvironmentBackend(client, {
      ...config,
      gatewayGitRoot,
      hostGitRoot,
    });
    await linkedBackend.create(identity);
    expect(client.createCalls[0]?.mounts).toEqual([
      {
        type: "bind",
        source: await realpath(path.join(config.hostStorageRoot, "repo", "worktree-a")),
        target: "/workspaces/repo/worktree-a",
        readOnly: false,
      },
      {
        type: "bind",
        source: await realpath(hostCommonDir),
        target: await realpath(gatewayCommonDir),
        readOnly: false,
      },
      { type: "volume", source: `${client.createCalls[0]!.name}-data`, target: "/var/lib/subpolar", readOnly: false },
    ]);
  });

  test("preserves the private runtime volume through rebuild and deletes it only on explicit removal", async () => {
    const { manager, request, client } = await fixture();
    const created = await manager.ensure(request);
    const volumeName = client.createCalls[0]!.mounts.at(-1)!.source;
    expect(client.volumes.has(volumeName)).toBe(true);

    await manager.rebuild!(request);
    expect(client.removeVolumeCalls).toEqual([]);
    expect(client.volumes.has(volumeName)).toBe(true);
    expect(client.createVolumeCalls).toHaveLength(1);

    await manager.remove(request);
    expect(client.removeVolumeCalls).toEqual([volumeName]);
    expect(client.volumes.has(volumeName)).toBe(false);
  });

  test("does not adopt or delete a data volume with mismatched ownership labels", async () => {
    const { backend, identity, client } = await fixture();
    const name = `subpolar-${identity.id}-data`;
    client.volumes.set(name, { name, driver: "local", labels: { "io.subpolar.environment-manager": "subpolar" } });

    await expect(backend.create(identity)).rejects.toMatchObject({ code: "DOCKER_IDENTITY_MISMATCH" });
    await expect(backend.removePersistentData!(identity)).rejects.toMatchObject({ code: "DOCKER_IDENTITY_MISMATCH" });
    expect(client.createCalls).toEqual([]);
    expect(client.removeVolumeCalls).toEqual([]);
  });

  test("keeps exact legacy containers out of normal inspection but supports stop and removal", async () => {
    const { manager, backend, identity, request, client } = await fixture();
    await manager.ensure(request);
    const legacyId = setLegacyContainerState(client);

    await expect(backend.inspect(identity)).resolves.toBeNull();
    await expect(backend.inspectForLifecycle!(identity)).resolves.toMatchObject({ compatibility: "legacy", environment: { resourceId: legacyId } });
    const stopped = await manager.stop(request);
    expect(stopped).toMatchObject({ resourceId: legacyId, status: "stopped" });
    expect(client.stopCalls).toContain(legacyId);
    await manager.remove(request);
    expect(client.removeCalls).toContain(legacyId);
  });

  test("migrates an exact legacy container during ensure and rebuild", async () => {
    const first = await fixture();
    await first.manager.ensure(first.request);
    const legacyId = setLegacyContainerState(first.client);
    const migrated = await first.manager.ensure(first.request);
    expect(migrated.resourceId).not.toBe(legacyId);
    expect(first.client.removeCalls).toContain(legacyId);
    expect(first.client.createCalls.at(-1)?.mounts.at(-1)).toMatchObject({ type: "volume", target: "/var/lib/subpolar" });

    const second = await fixture();
    await second.manager.ensure(second.request);
    const secondLegacyId = setLegacyContainerState(second.client);
    const rebuilt = await second.manager.rebuild!(second.request);
    expect(rebuilt.resourceId).not.toBe(secondLegacyId);
    expect(second.client.removeCalls).toContain(secondLegacyId);
    expect(second.client.createCalls.at(-1)?.mounts.at(-1)).toMatchObject({ type: "volume", target: "/var/lib/subpolar" });
  });

  test("does not recreate a missing runtime volume during inspection and can explicitly rebuild or remove", async () => {
    const { backend, manager, identity, request, client } = await fixture();
    await manager.ensure(request);
    const volumeName = client.createCalls[0]!.mounts.at(-1)!.source;
    client.volumes.delete(volumeName);

    await expect(backend.inspect(identity)).rejects.toMatchObject({ code: "DOCKER_CONFIGURATION_MISMATCH" });
    await expect(backend.inspectForLifecycle!(identity)).resolves.toMatchObject({ compatibility: "missing-runtime-data" });
    expect(client.createVolumeCalls).toHaveLength(1);

    const rebuilt = await manager.rebuild!(request);
    expect(rebuilt.status).toBe("ready");
    expect(client.createVolumeCalls).toHaveLength(2);

    client.volumes.delete(volumeName);
    await manager.remove(request);
    expect(client.volumes.has(volumeName)).toBe(false);
    expect(client.createVolumeCalls).toHaveLength(2);
  });

  test("revalidates daemon-host paths and rejects symlink escapes", async () => {
    const { backend, client, identity, hostWorktree, root } = await fixture();
    await rm(hostWorktree, { recursive: true });
    const outside = path.join(root, "outside-worktree");
    await mkdir(outside, { recursive: true });
    await mkdir(path.join(outside, ".git"));
    await symlink(outside, hostWorktree);

    await expect(backend.inspect(identity)).rejects.toMatchObject({ code: "WORKTREE_MAPPING_INVALID" });
    await expect(backend.create(identity)).rejects.toBeInstanceOf(DockerEnvironmentError);
    expect(client.createCalls).toEqual([]);
  });

  test("does not adopt an unlabelled container with the stable name", async () => {
    const { backend, client, identity } = await fixture();
    const valid = await backend.create(identity);
    const [containerName] = client.containers.keys();
    const current = client.containers.get(containerName!)!;
    client.containers.set(containerName!, { ...current, labels: { ...current.labels, "io.subpolar.environment-id": "other" } });

    await expect(backend.inspect(identity)).rejects.toMatchObject({ code: "DOCKER_IDENTITY_MISMATCH" });
    await expect(backend.start(valid)).rejects.toMatchObject({ code: "DOCKER_IDENTITY_MISMATCH" });
    expect(client.startCalls).toEqual([]);
  });

  test("rejects inspected containers with extra mounts or changed isolation settings", async () => {
    const { backend, client, identity } = await fixture();
    await backend.create(identity);
    const [name] = client.containers.keys();
    const container = client.containers.get(name!)!;
    client.containers.set(name!, {
      ...container,
      config: {
        ...container.config,
        mounts: [...container.config.mounts, {
          type: "bind",
          source: "/var/run/docker.sock",
          target: "/var/run/docker.sock",
          readOnly: false,
        }],
      },
    });

    await expect(backend.inspect(identity)).rejects.toMatchObject({ code: "DOCKER_CONFIGURATION_MISMATCH" });
  });

  test("refuses to execute in a worker whose network is no longer isolated", async () => {
    const { backend, client, identity } = await fixture();
    const ready = await backend.start(await backend.create(identity));
    const [name] = client.containers.keys();
    const container = client.containers.get(name!)!;
    client.containers.set(name!, {
      ...container,
      config: { ...container.config, networkMode: "bridge" },
    });

    await expect(backend.execute(ready, ["node", "agent.js"], {})).rejects.toMatchObject({
      code: "DOCKER_CONFIGURATION_MISMATCH",
    });
    expect(client.processCalls).toEqual([]);
  });
});
