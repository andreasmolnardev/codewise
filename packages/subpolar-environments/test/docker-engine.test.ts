import { expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createDockerEngineClient } from "../src/docker-engine.ts";
import type { DockerContainerCreateOptions, DockerContainerProcessRequest, DockerImageBuildRequest } from "../src/docker.ts";

function engineFixture(
  handler: (request: { method: string; url: string; body: string }) => { status: number; body?: unknown },
  processRunner?: (containerId: string, request: DockerContainerProcessRequest) => Promise<{ processId?: string; exitCode: number | null; cancelled: boolean }>,
) {
  return createDockerEngineClient({
    socketPath: "/var/run/docker.sock",
    ...(processRunner === undefined ? {} : { processRunner }),
    transport: async (request) => {
      const result = handler({
        method: request.method,
        url: request.path,
        body: request.body ? Buffer.from(request.body).toString("utf8") : "",
      });
      return {
        statusCode: result.status,
        body: result.body === undefined ? new Uint8Array() : Buffer.from(JSON.stringify(result.body)),
      };
    },
  });
}

const createOptions: DockerContainerCreateOptions = {
  name: "subpolar-env_123",
  image: "worker@sha256:abc",
  labels: { "io.subpolar.environment-id": "env_123" },
  user: "1000:1000",
  privileged: false,
  readOnlyRootfs: true,
  networkMode: "none",
  capDrop: ["ALL"],
  securityOpt: ["no-new-privileges:true"],
  memoryBytes: 512 * 1024 * 1024,
  nanoCpus: 500_000_000,
  pidsLimit: 100,
  mounts: [
    { type: "bind", source: "/host/worktree", target: "/workspaces/repo", readOnly: false },
    { type: "volume", source: "subpolar-env_123-data", target: "/var/lib/subpolar", readOnly: false },
  ],
  tmpfs: { "/tmp": "rw,nosuid,nodev,size=64m" },
  environment: { HOME: "/tmp/home", SUBPOLAR_RUNTIME_DATA_DIR: "/var/lib/subpolar" },
};

test("maps safe lifecycle operations to the Docker Engine API", async () => {
  const requests: Array<{ method: string; url: string; body: string }> = [];
  const client = engineFixture((request) => {
    requests.push(request);
    if (request.method === "GET") return { status: 200, body: {
      Id: "container-1",
      Name: "/subpolar-env_123",
      State: { Status: "running" },
      Config: { Image: "worker@sha256:abc", User: "1000:1000", Labels: { "io.subpolar.environment-id": "env_123" }, Env: ["HOME=/tmp/home"] },
      HostConfig: {
        Privileged: false, ReadonlyRootfs: true, NetworkMode: "none", CapDrop: ["ALL"],
        SecurityOpt: ["no-new-privileges:true"], Memory: 512 * 1024 * 1024, NanoCpus: 500_000_000,
        PidsLimit: 100, Tmpfs: { "/tmp": "rw,nosuid,nodev,size=64m" },
      },
      Mounts: [
        { Type: "bind", Source: "/host/worktree", Destination: "/workspaces/repo", RW: true },
        { Type: "volume", Name: "subpolar-env_123-data", Source: "/var/lib/docker/volumes/subpolar-env_123-data/_data", Destination: "/var/lib/subpolar", RW: true },
      ],
    } };
    if (request.url?.includes("/containers/create")) return { status: 201, body: { Id: "container-1" } };
    return { status: 204 };
  });

  const inspection = await client.inspectContainer("subpolar-env_123");
  expect(inspection).toMatchObject({
    id: "container-1",
    name: "subpolar-env_123",
    state: "running",
    config: { image: createOptions.image, networkMode: "none", mounts: [
      { type: "bind", source: "/host/worktree", target: "/workspaces/repo", readOnly: false },
      { type: "volume", source: "subpolar-env_123-data", target: "/var/lib/subpolar", readOnly: false },
    ] },
  });
  await expect(client.createContainer(createOptions)).resolves.toEqual({ id: "container-1" });
  await client.startContainer("container-1");
  await client.stopContainer("container-1", { timeoutSeconds: 10 });
  await client.removeContainer("container-1", { force: false, removeVolumes: false });

  expect(requests.map(({ method, url }) => [method, url])).toEqual([
    ["GET", "/v1.44/containers/subpolar-env_123/json"],
    ["POST", "/v1.44/containers/create?name=subpolar-env_123"],
    ["POST", "/v1.44/containers/container-1/start"],
    ["POST", "/v1.44/containers/container-1/stop?t=10"],
    ["DELETE", "/v1.44/containers/container-1?force=false&v=false"],
  ]);
  const payload = JSON.parse(requests[1]!.body) as { HostConfig: Record<string, unknown> };
  expect(payload.HostConfig).toMatchObject({
    Privileged: false,
    ReadonlyRootfs: true,
    NetworkMode: "none",
    CapDrop: ["ALL"],
    PidsLimit: 100,
    Mounts: [
      { Type: "bind", Source: "/host/worktree", Target: "/workspaces/repo", ReadOnly: false },
      { Type: "volume", Source: "subpolar-env_123-data", Target: "/var/lib/subpolar", ReadOnly: false },
    ],
  });
});

test("creates an internal Compose network and assigns service DNS aliases", async () => {
  const requests: Array<{ method: string; url: string; body: string }> = [];
  const client = engineFixture((request) => {
    requests.push(request);
    if (request.url === "/v1.44/networks/create") return { status: 201, body: { Id: "network-1" } };
    if (request.url === "/v1.44/networks/network-1") return { status: 200, body: {
      Id: "network-1", Name: "subpolar-net-test", Driver: "bridge", Internal: true,
      Labels: { "io.subpolar.resource-purpose": "compose-network" },
      Containers: { "container-db": { Aliases: ["db"] } },
    } };
    if (request.url === "/v1.44/containers/create?name=worker") return { status: 201, body: { Id: "worker-1" } };
    return { status: 204 };
  });
  const network = await client.createNetwork!({
    name: "subpolar-net-test",
    driver: "bridge",
    internal: true,
    labels: { "io.subpolar.resource-purpose": "compose-network" },
  });
  expect(network).toMatchObject({ name: "subpolar-net-test", internal: true, containerAliases: { "container-db": ["db"] } });
  await client.createContainer({
    ...createOptions,
    name: "worker",
    networkMode: network.name,
    networkAliases: ["app"],
    healthcheck: { test: ["CMD", "pg_isready"], intervalMs: 1000, timeoutMs: 3000, retries: 60, startPeriodMs: 1000 },
  });
  const body = JSON.parse(requests.find((request) => request.url.includes("/containers/create"))!.body);
  expect(body.HostConfig.NetworkMode).toBe("subpolar-net-test");
  expect(body.Healthcheck).toEqual({ Test: ["CMD", "pg_isready"], Interval: 1_000_000_000, Timeout: 3_000_000_000, Retries: 60, StartPeriod: 1_000_000_000 });
  expect(body.NetworkingConfig.EndpointsConfig["subpolar-net-test"].Aliases).toEqual(["app"]);
});

test("manages named runtime data volumes through the Docker Engine API", async () => {
  const requests: Array<{ method: string; url: string; body: string }> = [];
  const volume = {
    Name: "subpolar-env_123-data",
    Driver: "local",
    Labels: { "io.subpolar.environment-id": "env_123" },
  };
  const client = engineFixture((request) => {
    requests.push(request);
    if (request.method === "GET") return { status: 200, body: volume };
    if (request.method === "POST") return { status: 201, body: volume };
    return { status: 204 };
  });

  await expect(client.inspectVolume("subpolar-env_123-data")).resolves.toEqual({
    name: "subpolar-env_123-data", driver: "local", labels: { "io.subpolar.environment-id": "env_123" },
  });
  await expect(client.createVolume({
    name: "subpolar-env_123-data", driver: "local", labels: { "io.subpolar.environment-id": "env_123" },
  })).resolves.toEqual({
    name: "subpolar-env_123-data", driver: "local", labels: { "io.subpolar.environment-id": "env_123" },
  });
  await client.removeVolume("subpolar-env_123-data");

  expect(requests.map(({ method, url }) => [method, url])).toEqual([
    ["GET", "/v1.44/volumes/subpolar-env_123-data"],
    ["POST", "/v1.44/volumes/create"],
    ["DELETE", "/v1.44/volumes/subpolar-env_123-data"],
  ]);
  expect(JSON.parse(requests[1]!.body)).toEqual({
    Name: "subpolar-env_123-data", Driver: "local", Labels: { "io.subpolar.environment-id": "env_123" },
  });
});

test("returns null for an unknown container and does not leak daemon error details", async () => {
  const client = engineFixture(() => ({ status: 404, body: { message: "sensitive host detail" } }));
  await expect(client.inspectContainer("missing")).resolves.toBeNull();
  await expect(client.startContainer("missing")).rejects.toMatchObject({
    name: "DockerEngineClientError",
    message: "Docker Engine request failed with HTTP 404",
  });
});

test("routes container process requests through the worker runner", async () => {
  let seen: { id: string; request: DockerContainerProcessRequest } | undefined;
  const client = engineFixture(
    () => ({ status: 404 }),
    async (id, request) => {
      seen = { id, request };
      await request.onOutput?.({ stream: "stderr", data: new TextEncoder().encode("warning") });
      return { processId: "worker-process-1", exitCode: 0, cancelled: false };
    },
  );
  const output: string[] = [];
  const request = {
    command: ["node", "-e", "console.log('hello')"],
    worktreeDirectory: "/workspaces/repo",
    workingDirectory: "/workspaces/repo/packages",
    environment: { MODE: "test" },
    onOutput: ({ stream, data }: { stream: string; data: Uint8Array }) => output.push(`${stream}:${new TextDecoder().decode(data)}`),
  };

  await expect(client.executeContainer!("container-9", request)).resolves.toEqual({
    processId: "worker-process-1",
    exitCode: 0,
    cancelled: false,
  });
  expect(seen).toEqual({ id: "container-9", request });
  expect(output).toEqual(["stderr:warning"]);
});

test("routes Dev Container image builds through the injected manager runner", async () => {
  const seen: DockerImageBuildRequest[] = [];
  const client = createDockerEngineClient({
    socketPath: "/var/run/docker.sock",
    transport: async () => ({ statusCode: 200, body: new Uint8Array() }),
    imageBuildRunner: async (request) => { seen.push(request); },
  });
  const request: DockerImageBuildRequest = {
    kind: "dockerfile",
    contextPath: "/host/worktree/.devcontainer",
    dockerfilePath: "/host/worktree/.devcontainer/Dockerfile",
    image: "subpolar-devcontainer:0123456789abcdef0123456789abcdef",
  };

  await client.buildImage!(request);

  expect(seen).toEqual([request]);
});

test("invokes the Dev Container CLI with a frozen feature lock", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "subpolar-devcontainer-cli-"));
  const outputPath = path.join(directory, "args.json");
  const binaryPath = path.join(directory, "devcontainer");
  try {
    const source = "#!/usr/bin/env node\nrequire('node:fs').writeFileSync(" + JSON.stringify(outputPath) + ", JSON.stringify(process.argv.slice(2)));\n";
    await writeFile(binaryPath, source);
    await chmod(binaryPath, 0o755);
    const client = createDockerEngineClient({
      socketPath: "/var/run/docker.sock",
      transport: async () => ({ statusCode: 200, body: new Uint8Array() }),
      devContainerCliBinary: binaryPath,
    });

    await client.buildImage!({
      kind: "devcontainer",
      workspaceFolder: "/host/worktree",
      configurationPath: "/host/worktree/.devcontainer/devcontainer.json",
      image: "subpolar-devcontainer:0123456789abcdef0123456789abcdef",
    });

    expect(JSON.parse(await readFile(outputPath, "utf8"))).toEqual([
      "build",
      "--workspace-folder", "/host/worktree",
      "--config", "/host/worktree/.devcontainer/devcontainer.json",
      "--image-name", "subpolar-devcontainer:0123456789abcdef0123456789abcdef",
      "--frozen-lockfile",
    ]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("routes interactive sessions through the TTY runner and Docker resize API", async () => {
  const requests: string[] = [];
  let seen: { id: string; request: unknown } | undefined;
  let cleanup: (() => Promise<void>) | undefined;
  const client = createDockerEngineClient({
    socketPath: "/var/run/docker.sock",
    transport: async (request) => {
      requests.push(`${request.method} ${request.path}`);
      return {
        statusCode: request.path.endsWith("/exec") ? 201 : request.path.endsWith("/start") ? 200 : 200,
        body: request.path.endsWith("/exec") ? Buffer.from('{"Id":"cleanup-exec"}') : new Uint8Array(),
      };
    },
    interactiveRunner: async (id, request, resize, terminate) => {
      seen = { id, request };
      cleanup = () => terminate(id, request.controlToken!);
      return {
        output: { async *[Symbol.asyncIterator]() { yield Buffer.from("prompt"); } },
        result: Promise.resolve({ exitCode: null, cancelled: false }),
        async write() {},
        resize: (columns, rows) => resize("exec-tty", columns, rows),
        async terminate() { await cleanup?.(); },
      };
    },
  });
  const processRequest = { command: ["/bin/sh"], worktreeDirectory: "/workspaces/repo", workingDirectory: "/workspaces/repo" };
  const session = await client.startInteractiveContainer!("container-tty", processRequest);
  await session.resize(120, 40);
  const output = [];
  for await (const chunk of session.output) output.push(chunk);
  await session.terminate();

  expect(seen?.id).toBe("container-tty");
  const supervised = seen?.request as { command: string[]; workingDirectory: string; controlToken: string };
  expect(supervised.command.slice(0, 2)).toEqual(["node", "/usr/local/lib/subpolar/terminal-supervisor.mjs"]);
  expect(supervised.command[2]).toMatch(/^[a-f0-9-]{36}$/);
  expect(supervised.controlToken).toBe(supervised.command[2]);
  expect(supervised.workingDirectory).toBe(processRequest.worktreeDirectory);
  const payload = JSON.parse(Buffer.from(supervised.command[3], "base64url").toString("utf8"));
  expect(payload).toEqual({ ...processRequest, environment: {} });
  expect(requests).toEqual([
    "POST /v1.44/exec/exec-tty/resize?h=40&w=120",
    "POST /v1.44/containers/container-tty/exec",
    "POST /v1.44/exec/cleanup-exec/start",
  ]);
  expect(output).toEqual([Buffer.from("prompt")]);
});

test("launches non-TTY process sessions with JSON-safe argv and bidirectional stdio", async () => {
  let seen: { id: string; request: unknown } | undefined;
  const writes: Uint8Array[] = [];
  const requests: string[] = [];
  const client = createDockerEngineClient({
    socketPath: "/var/run/docker.sock",
    transport: async (request) => {
      requests.push(`${request.method} ${request.path}`);
      return request.path.endsWith("/exec")
        ? { statusCode: 201, body: Buffer.from('{"Id":"stdio-cleanup"}') }
        : { statusCode: 200, body: new Uint8Array() };
    },
    managedSessionRunner: async (id, request, terminate) => {
      seen = { id, request };
      return {
        async write(data) { writes.push(data); },
        output: { async *[Symbol.asyncIterator]() {
          yield { stream: "stdout" as const, data: Buffer.from("jsonrpc") };
          yield { stream: "stderr" as const, data: Buffer.from("diagnostic") };
        } },
        result: Promise.resolve({ exitCode: 0, cancelled: false }),
        async terminate() { await terminate(id, request.controlToken!); },
      };
    },
  });
  const request = {
    command: ["node", "acp-server.js", "arg with spaces"],
    worktreeDirectory: "/workspaces/repo",
    workingDirectory: "/workspaces/repo/packages",
    environment: { MODE: "stdio" },
  };
  const session = await client.startManagedSessionContainer!("container-stdio", request);
  await session.write(Buffer.from('{"jsonrpc":"2.0"}\n'));
  const output = [];
  for await (const event of session.output) output.push(event);
  await session.terminate();

  expect(seen?.id).toBe("container-stdio");
  const supervised = seen?.request as { command: string[]; workingDirectory: string; controlToken: string };
  expect(supervised.command.slice(0, 3)).toEqual(["node", "/usr/local/lib/subpolar/terminal-supervisor.mjs", "--stdio"]);
  expect(supervised.command[3]).toMatch(/^[a-f0-9-]{36}$/);
  expect(supervised.controlToken).toBe(supervised.command[3]);
  const payload = JSON.parse(Buffer.from(supervised.command[4]!, "base64url").toString("utf8"));
  expect(payload).toEqual(request);
  expect(writes).toEqual([Buffer.from('{"jsonrpc":"2.0"}\n')]);
  expect(output).toEqual([
    { stream: "stdout", data: Buffer.from("jsonrpc") },
    { stream: "stderr", data: Buffer.from("diagnostic") },
  ]);
  expect(requests).toEqual([
    "POST /v1.44/containers/container-stdio/exec",
    "POST /v1.44/exec/stdio-cleanup/start",
  ]);
});

test("closes Docker exec stdin after the worker reports command completion", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "subpolar-docker-worker-exit-"));
  const dockerStub = path.join(root, "docker-stub.sh");
  await writeFile(dockerStub, [
    "#!/bin/sh",
    "IFS= read -r request",
    "printf '%s\\n' '{\"type\":\"started\",\"processId\":\"child-1\"}'",
    "printf '%s\\n' '{\"type\":\"exit\",\"exitCode\":7}'",
    "cat >/dev/null",
    "",
  ].join("\n"));
  await chmod(dockerStub, 0o755);
  try {
    const client = createDockerEngineClient({
      socketPath: "/var/run/docker.sock",
      dockerBinary: dockerStub,
      workerCommand: ["worker.mjs"],
    });
    const result = await client.executeContainer("container-1", {
      command: ["sh", "-c", "exit 7"],
      worktreeDirectory: "/workspaces/repo",
      workingDirectory: "/workspaces/repo",
      environment: {},
    });
    expect(result).toEqual({ processId: "child-1", exitCode: 7, cancelled: false });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 5000);
