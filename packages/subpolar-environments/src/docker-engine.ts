import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import path from "node:path";
import { request as httpRequest, type IncomingMessage, type RequestOptions } from "node:http";
import type { DockerClient, DockerContainerCreateOptions, DockerContainerInspection, DockerContainerProcessRequest, DockerContainerInteractiveRequest, DockerContainerManagedSessionRequest, DockerImageBuildRequest, DockerVolumeCreateOptions, DockerVolumeInspection, DockerNetworkInspection, DockerNetworkCreateOptions } from "./docker.ts";
import type { EnvironmentInteractiveSession, EnvironmentManagedProcessSession, EnvironmentProcessOutput, EnvironmentProcessResult } from "./index.ts";

export interface DockerEngineClientOptions {
  readonly socketPath: string;
  readonly apiVersion?: string;
  readonly timeoutMs?: number;
  readonly transport?: DockerEngineTransport;
  readonly dockerBinary?: string;
  readonly devContainerCliBinary?: string;
  readonly workerCommand?: readonly string[];
  readonly terminalSupervisorCommand?: readonly string[];
  readonly processRunner?: DockerContainerProcessRunner;
  readonly interactiveRunner?: DockerContainerInteractiveRunner;
  readonly managedSessionRunner?: DockerContainerManagedSessionRunner;
  readonly imageBuildRunner?: (request: DockerImageBuildRequest) => Promise<void>;
}

export type DockerContainerProcessRunner = (
  containerId: string,
  request: DockerContainerProcessRequest,
) => Promise<EnvironmentProcessResult>;

export type DockerContainerInteractiveRunner = (
  containerId: string,
  request: DockerContainerInteractiveRequest,
  resize: (execId: string, columns: number, rows: number) => Promise<void>,
  terminate: (containerId: string, controlToken: string) => Promise<void>,
) => Promise<EnvironmentInteractiveSession>;

export type DockerContainerManagedSessionRunner = (
  containerId: string,
  request: DockerContainerManagedSessionRequest,
  terminate: (containerId: string, controlToken: string) => Promise<void>,
) => Promise<EnvironmentManagedProcessSession>;

async function runDockerImageBuild(dockerBinary: string, request: DockerImageBuildRequest): Promise<void> {
  if (request.kind !== "dockerfile" || !path.isAbsolute(request.contextPath) || !path.isAbsolute(request.dockerfilePath) ||
      !/^subpolar-devcontainer:[a-f0-9]{32}$/.test(request.image)) {
    throw new DockerEngineClientError(undefined, "Dev Container image build request is invalid");
  }
  await new Promise<void>((resolve, reject) => {
    const child = spawn(dockerBinary, ["build", "--file", request.dockerfilePath, "--tag", request.image, request.contextPath], {
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "inherit", "inherit"],
    });
    let spawnError: Error | undefined;
    child.once("error", (error) => { spawnError = error; });
    child.once("close", (code) => {
      if (spawnError) reject(new DockerEngineClientError(undefined, "Docker image build could not start", { cause: spawnError }));
      else if (code !== 0) reject(new DockerEngineClientError(undefined, `Docker image build failed with exit code ${code ?? "unknown"}`));
      else resolve();
    });
  });
}

async function runDockerImagePull(dockerBinary: string, image: string): Promise<void> {
  if (!/^postgres(?::[A-Za-z0-9._-]+)?(?:@sha256:[a-f0-9]{64})?$/.test(image)) {
    throw new DockerEngineClientError(undefined, "Compose PostgreSQL image request is invalid");
  }
  const alreadyAvailable = await new Promise<boolean>((resolve, reject) => {
    const child = spawn(dockerBinary, ["image", "inspect", image], { shell: false, windowsHide: true, stdio: "ignore" });
    let spawnError: Error | undefined;
    child.once("error", (error) => { spawnError = error; });
    child.once("close", (code) => {
      if (spawnError) reject(new DockerEngineClientError(undefined, "Docker image inspection could not start", { cause: spawnError }));
      else resolve(code === 0);
    });
  });
  if (alreadyAvailable) return;
  await new Promise<void>((resolve, reject) => {
    const child = spawn(dockerBinary, ["pull", image], { shell: false, windowsHide: true, stdio: ["ignore", "inherit", "inherit"] });
    let spawnError: Error | undefined;
    child.once("error", (error) => { spawnError = error; });
    child.once("close", (code) => {
      if (spawnError) reject(new DockerEngineClientError(undefined, "Docker image pull could not start", { cause: spawnError }));
      else if (code !== 0) reject(new DockerEngineClientError(undefined, `Docker image pull failed with exit code ${code ?? "unknown"}`));
      else resolve();
    });
  });
}

async function runDevContainerCliBuild(binary: string, request: DockerImageBuildRequest): Promise<void> {
  if (request.kind !== "devcontainer" || !path.isAbsolute(request.workspaceFolder) || !path.isAbsolute(request.configurationPath) ||
      !/^subpolar-devcontainer:[a-f0-9]{32}$/.test(request.image)) {
    throw new DockerEngineClientError(undefined, "Dev Container Feature build request is invalid");
  }
  const relativeConfiguration = path.relative(request.workspaceFolder, request.configurationPath);
  if (!relativeConfiguration || relativeConfiguration === ".." || relativeConfiguration.startsWith(`..${path.sep}`) || path.isAbsolute(relativeConfiguration)) {
    throw new DockerEngineClientError(undefined, "Dev Container configuration must be inside the workspace");
  }
  await new Promise<void>((resolve, reject) => {
    const child = spawn(binary, [
      "build",
      "--workspace-folder", request.workspaceFolder,
      "--config", request.configurationPath,
      "--image-name", request.image,
      "--frozen-lockfile",
    ], {
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "inherit", "inherit"],
    });
    let spawnError: Error | undefined;
    child.once("error", (error) => { spawnError = error; });
    child.once("close", (code) => {
      if (spawnError) reject(new DockerEngineClientError(undefined, "Dev Container CLI could not start", { cause: spawnError }));
      else if (code !== 0) reject(new DockerEngineClientError(undefined, `Dev Container CLI build failed with exit code ${code ?? "unknown"}`));
      else resolve();
    });
  });
}

export interface DockerEngineTransportRequest {
  readonly method: string;
  readonly path: string;
  readonly headers?: Readonly<Record<string, string | number>>;
  readonly body?: Uint8Array;
}

export interface DockerEngineTransportResponse {
  readonly statusCode: number;
  readonly body: Uint8Array;
}

export type DockerEngineTransport = (request: DockerEngineTransportRequest) => Promise<DockerEngineTransportResponse>;

export class DockerEngineClientError extends Error {
  constructor(readonly statusCode: number | undefined, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "DockerEngineClientError";
  }
}

interface EngineResponse {
  readonly statusCode: number;
  readonly body: Uint8Array;
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function text(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function number(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function boolean(value: unknown): boolean {
  return value === true;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

function stringRecord(value: unknown): Record<string, string> {
  return Object.fromEntries(Object.entries(record(value)).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
}

function envRecord(value: unknown): Record<string, string> {
  if (!Array.isArray(value)) return {};
  const entries: Array<[string, string]> = [];
  for (const item of value) {
    if (typeof item !== "string") continue;
    const separator = item.indexOf("=");
    if (separator <= 0) continue;
    entries.push([item.slice(0, separator), item.slice(separator + 1)]);
  }
  return Object.fromEntries(entries);
}

function dockerState(value: unknown): DockerContainerInspection["state"] {
  switch (value) {
    case "created": case "running": case "paused": case "restarting": case "exited": case "dead": return value;
    default: return "dead";
  }
}

function normalizeInspection(value: unknown): DockerContainerInspection {
  const container = record(value);
  const config = record(container.Config);
  const host = record(container.HostConfig);
  const state = record(container.State);
  const networks = record(record(container.NetworkSettings).Networks);
  const networkAliases = Object.fromEntries(Object.entries(networks).map(([name, network]) => [name, stringArray(record(network).Aliases)]));
  const mounts = Array.isArray(container.Mounts) ? container.Mounts.map((mountValue) => {
    const mount = record(mountValue);
    const type = text(mount.Type);
    return {
      type: type as "bind" | "volume",
      source: type === "volume" ? text(mount.Name) : text(mount.Source),
      target: text(mount.Destination),
      readOnly: !boolean(mount.RW),
    };
  }) : [];
  return {
    id: text(container.Id),
    name: text(container.Name).replace(/^\//, ""),
    state: dockerState(state.Status),
    labels: stringRecord(config.Labels),
    config: {
      image: text(config.Image),
      user: text(config.User),
      privileged: boolean(host.Privileged),
      readOnlyRootfs: boolean(host.ReadonlyRootfs),
      networkMode: text(host.NetworkMode),
      networkAliases,
      capDrop: stringArray(host.CapDrop),
      securityOpt: stringArray(host.SecurityOpt),
      memoryBytes: number(host.Memory),
      nanoCpus: number(host.NanoCpus),
      pidsLimit: number(host.PidsLimit),
      mounts,
      tmpfs: stringRecord(host.Tmpfs),
      environment: envRecord(config.Env),
    },
  };
}

function normalizeVolumeInspection(value: unknown): DockerVolumeInspection {
  const volume = record(value);
  return {
    name: text(volume.Name),
    driver: text(volume.Driver),
    labels: stringRecord(volume.Labels),
  };
}

function normalizeNetworkInspection(value: unknown): DockerNetworkInspection {
  const network = record(value);
  const containers = record(network.Containers);
  const aliases = Object.fromEntries(Object.entries(containers).map(([id, entry]) => [id, stringArray(record(entry).Aliases)]));
  return {
    id: text(network.Id),
    name: text(network.Name),
    driver: text(network.Driver),
    internal: boolean(network.Internal),
    labels: stringRecord(network.Labels),
    containerIds: Object.keys(containers),
    containerAliases: aliases,
  };
}

function createVolumePayload(options: DockerVolumeCreateOptions): Record<string, unknown> {
  return { Name: options.name, Driver: options.driver, Labels: options.labels };
}

function createPayload(options: DockerContainerCreateOptions): Record<string, unknown> {
  return {
    Image: options.image,
    User: options.user,
    Labels: options.labels,
    Env: Object.entries(options.environment).map(([key, value]) => `${key}=${value}`),
    ...(options.healthcheck === undefined ? {} : { Healthcheck: {
      Test: options.healthcheck.test,
      Interval: options.healthcheck.intervalMs * 1_000_000,
      Timeout: options.healthcheck.timeoutMs * 1_000_000,
      Retries: options.healthcheck.retries,
      StartPeriod: options.healthcheck.startPeriodMs * 1_000_000,
    } }),
    HostConfig: {
      Privileged: options.privileged,
      ReadonlyRootfs: options.readOnlyRootfs,
      NetworkMode: options.networkMode,
      CapDrop: options.capDrop,
      SecurityOpt: options.securityOpt,
      Memory: options.memoryBytes,
      NanoCpus: options.nanoCpus,
      PidsLimit: options.pidsLimit,
      Mounts: options.mounts.map((mount) => ({ Type: mount.type, Source: mount.source, Target: mount.target, ReadOnly: mount.readOnly })),
      Tmpfs: options.tmpfs,
    },
    ...(options.networkAliases === undefined ? {} : {
      NetworkingConfig: {
        EndpointsConfig: {
          [options.networkMode]: { Aliases: options.networkAliases },
        },
      },
    }),
  };
}

function readResponse(response: IncomingMessage, maxBytes: number): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    response.on("data", (chunk: Buffer | string) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += bytes.byteLength;
      if (size > maxBytes) {
        response.destroy(new Error("Docker Engine response exceeded the size limit"));
        return;
      }
      chunks.push(bytes);
    });
    response.on("end", () => resolve(Buffer.concat(chunks)));
    response.on("error", reject);
  });
}

async function runDockerWorker(
  dockerBinary: string,
  workerCommand: readonly string[],
  containerId: string,
  request: DockerContainerProcessRequest,
): Promise<EnvironmentProcessResult> {
  if (request.signal?.aborted) return { exitCode: null, cancelled: true };
  const docker = spawn(dockerBinary, ["exec", "-i", containerId, ...workerCommand], {
    shell: false,
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const reader = createInterface({ input: docker.stdout, crlfDelay: Infinity });
  const childClosed = new Promise<void>((resolve) => docker.once("close", () => resolve()));
  let protocolResult: EnvironmentProcessResult | undefined;
  let processId: string | undefined;
  let spawnError = false;
  let stderrBytes = 0;
  docker.stderr.on("data", (chunk: Buffer) => { stderrBytes += chunk.byteLength; });
  docker.once("error", () => { spawnError = true; });
  const abort = () => {
    if (!docker.stdin.destroyed) docker.stdin.write(`${JSON.stringify({ type: "terminate" })}\n`);
  };
  request.signal?.addEventListener("abort", abort, { once: true });
  try {
    const startMessage = `${JSON.stringify({
      type: "execute",
      command: request.command,
      worktreeDirectory: request.worktreeDirectory,
      workingDirectory: request.workingDirectory,
      environment: request.environment,
    })}\n`;
    if (!docker.stdin.write(startMessage)) await new Promise<void>((resolve) => docker.stdin.once("drain", resolve));
    if (request.signal?.aborted) abort();
    for await (const line of reader) {
      let event: Record<string, unknown>;
      try {
        event = record(JSON.parse(line));
      } catch {
        throw new DockerEngineClientError(undefined, "Managed process returned an invalid protocol message");
      }
      if (event.type === "started" && typeof event.processId === "string") processId = event.processId;
      else if (event.type === "output" && (event.stream === "stdout" || event.stream === "stderr") && typeof event.data === "string") {
        await request.onOutput?.({ stream: event.stream, data: Buffer.from(event.data, "base64") });
      } else if (event.type === "error") {
        throw new DockerEngineClientError(undefined, "Managed process could not be started");
      } else if (event.type === "exit") {
        protocolResult = {
          ...(processId === undefined ? {} : { processId }),
          exitCode: typeof event.exitCode === "number" ? event.exitCode : null,
          cancelled: event.cancelled === true || request.signal?.aborted === true,
        };
        // The worker keeps its readline loop open between requests. EOF lets
        // it exit, which closes Docker exec's stdout and releases this reader.
        if (!docker.stdin.destroyed) docker.stdin.end();
      }
    }
    await childClosed;
    if (spawnError || !protocolResult) {
      const message = stderrBytes > 0 ? "Docker exec failed" : "Managed process ended without a result";
      throw new DockerEngineClientError(undefined, message);
    }
    return protocolResult;
  } catch (error) {
    docker.kill("SIGTERM");
    throw error instanceof DockerEngineClientError ? error : new DockerEngineClientError(undefined, "Managed process transport failed", { cause: error });
  } finally {
    request.signal?.removeEventListener("abort", abort);
    if (!docker.stdin.destroyed) docker.stdin.end();
    reader.close();
  }
}

const MAX_MANAGED_SESSION_BUFFER_BYTES = 1_048_576;

async function runDockerManagedSession(
  dockerBinary: string,
  containerId: string,
  request: DockerContainerManagedSessionRequest,
  terminateSupervisor: (containerId: string, controlToken: string) => Promise<void>,
): Promise<EnvironmentManagedProcessSession> {
  if (!request.controlToken) throw new DockerEngineClientError(undefined, "Managed process session has no cleanup token");
  const docker = spawn(dockerBinary, ["exec", "-i", containerId, ...request.command], {
    shell: false,
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let queue: EnvironmentProcessOutput[] = [];
  let bufferedBytes = 0;
  let ended = false;
  let failure: Error | undefined;
  let cancelled = false;
  let wakeReader: (() => void) | undefined;
  let wakeSpace: (() => void) | undefined;
  const notifyReader = () => { wakeReader?.(); wakeReader = undefined; };
  const notifySpace = () => { wakeSpace?.(); wakeSpace = undefined; };
  const push = async (stream: "stdout" | "stderr", chunk: Buffer) => {
    for (let offset = 0; offset < chunk.byteLength; offset += 65_536) {
      const data = chunk.subarray(offset, Math.min(offset + 65_536, chunk.byteLength));
      while (!ended && bufferedBytes + data.byteLength > MAX_MANAGED_SESSION_BUFFER_BYTES) {
        await new Promise<void>((resolve) => { wakeSpace = resolve; });
      }
      if (ended) return;
      queue.push({ stream, data });
      bufferedBytes += data.byteLength;
      notifyReader();
    }
  };
  const subscribe = (stream: "stdout" | "stderr", source: NodeJS.ReadableStream) => {
    source.on("data", (chunk: Buffer) => {
      source.pause();
      void push(stream, Buffer.from(chunk)).then(() => source.resume(), (error: unknown) => {
        failure = error instanceof Error ? error : new Error("Managed process session output failed");
        ended = true;
        notifyReader();
        notifySpace();
      });
    });
    source.once("error", (error) => { failure = error; ended = true; notifyReader(); notifySpace(); });
  };
  subscribe("stdout", docker.stdout);
  subscribe("stderr", docker.stderr);
  let exitCode: number | null = null;
  const result = new Promise<EnvironmentProcessResult>((resolve) => {
    docker.once("error", (error) => {
      failure = error;
      ended = true;
      notifyReader();
      notifySpace();
      resolve({ exitCode: null, cancelled });
    });
    docker.once("close", (code) => {
      exitCode = typeof code === "number" && code >= 0 ? code : null;
      ended = true;
      notifyReader();
      notifySpace();
      resolve({ exitCode, cancelled });
    });
  });
  let claimed = false;
  const output: AsyncIterable<EnvironmentProcessOutput> = {
    async *[Symbol.asyncIterator]() {
      if (claimed) throw new Error("Managed session output already has an attached reader");
      claimed = true;
      while (true) {
        const next = queue.shift();
        if (next) {
          bufferedBytes -= next.data.byteLength;
          notifySpace();
          yield next;
        } else if (ended) {
          if (failure) throw failure;
          return;
        } else {
          await new Promise<void>((resolve) => { wakeReader = resolve; });
        }
      }
    },
  };
  return {
    output,
    result,
    async write(data) {
      if (ended || docker.stdin.destroyed) throw new DockerEngineClientError(undefined, "Managed process session has ended");
      if (!docker.stdin.write(data)) await new Promise<void>((resolve, reject) => {
        docker.stdin.once("drain", resolve);
        docker.stdin.once("error", reject);
      });
    },
    async terminate() {
      if (ended) { await result; return; }
      cancelled = true;
      await terminateSupervisor(containerId, request.controlToken!);
      await result;
    },
  };
}

const MAX_TTY_BUFFER_BYTES = 1_048_576;

async function runDockerTty(
  socketPath: string,
  version: string,
  timeoutMs: number,
  containerId: string,
  request: DockerContainerInteractiveRequest,
  resize: (execId: string, columns: number, rows: number) => Promise<void>,
  terminateSupervisor: (containerId: string, controlToken: string) => Promise<void>,
): Promise<EnvironmentInteractiveSession> {
  if (!request.controlToken) throw new DockerEngineClientError(undefined, "Interactive process has no cleanup token");
  const create = await new Promise<IncomingMessage>((resolve, reject) => {
    const outgoing = httpRequest({
      socketPath, method: "POST", path: `/${version}/containers/${encodeURIComponent(containerId)}/exec`, timeout: timeoutMs,
      headers: { "content-type": "application/json" },
    }, resolve);
    outgoing.once("error", reject);
    outgoing.end(JSON.stringify({
      Cmd: request.command,
      WorkingDir: request.workingDirectory,
      Env: Object.entries(request.environment ?? {}).map(([key, value]) => `${key}=${value}`),
      AttachStdin: true,
      AttachStdout: true,
      AttachStderr: true,
      Tty: true,
    }));
  });
  const createBody = await readResponse(create, 1024 * 1024);
  if (create.statusCode !== 201) throw new DockerEngineClientError(create.statusCode, "Docker Engine could not create an interactive process");
  const created = record(decodeDockerJson(createBody));
  const execId = text(created.Id);
  if (!execId) throw new DockerEngineClientError(undefined, "Docker Engine did not return an interactive process ID");

  const socket = await new Promise<import("node:stream").Duplex>((resolve, reject) => {
    const outgoing = httpRequest({
      socketPath, method: "POST", path: `/${version}/exec/${encodeURIComponent(execId)}/start`, timeout: timeoutMs,
      headers: {
        "content-type": "application/json",
        "content-length": Buffer.byteLength('{"Detach":false,"Tty":true}'),
        Connection: "Upgrade",
        Upgrade: "tcp",
      },
    });
    outgoing.once("upgrade", (response, upgraded, head) => {
      if (response.statusCode !== 101) {
        upgraded.destroy();
        reject(new DockerEngineClientError(response.statusCode, "Docker Engine did not attach the interactive process"));
        return;
      }
      if (head.byteLength) upgraded.unshift(head);
      resolve(upgraded);
    });
    outgoing.once("response", (response) => {
      response.resume();
      reject(new DockerEngineClientError(response.statusCode, "Docker Engine rejected the interactive attach"));
    });
    outgoing.once("error", reject);
    outgoing.end('{"Detach":false,"Tty":true}');
  });
  let buffers: Buffer[] = [];
  let bufferedBytes = 0;
  let ended = false;
  let failure: Error | undefined;
  let resolveRead: (() => void) | undefined;
  let resolveSpace: (() => void) | undefined;
  const wakeReader = () => { resolveRead?.(); resolveRead = undefined; };
  const wakeWriter = () => { resolveSpace?.(); resolveSpace = undefined; };
  const put = async (chunk: Buffer) => {
    while (!ended && bufferedBytes + chunk.byteLength > MAX_TTY_BUFFER_BYTES) {
      await new Promise<void>((resolve) => { resolveSpace = resolve; });
    }
    if (ended) return;
    buffers.push(chunk);
    bufferedBytes += chunk.byteLength;
    wakeReader();
  };
  socket.on("data", (chunk: Buffer) => {
    socket.pause();
    void put(Buffer.from(chunk)).then(() => socket.resume(), (error: unknown) => {
      failure = error instanceof Error ? error : new Error("Interactive output failed");
      ended = true;
      wakeReader();
    });
  });
  socket.once("error", (error) => { failure = error; ended = true; wakeReader(); wakeWriter(); });

  let claimed = false;
  const output: AsyncIterable<Uint8Array> = {
    async *[Symbol.asyncIterator]() {
      if (claimed) throw new Error("Interactive output already has an attached reader");
      claimed = true;
      try {
        while (true) {
          const chunk = buffers.shift();
          if (chunk) {
            bufferedBytes -= chunk.byteLength;
            wakeWriter();
            yield chunk;
          } else if (ended) {
            if (failure) throw failure;
            return;
          } else {
            await new Promise<void>((resolve) => { resolveRead = resolve; });
          }
        }
      } finally {
        // A disconnected output reader leaves the terminal alive and bounded.
      }
    },
  };

  let resolveResult!: (result: EnvironmentProcessResult) => void;
  const result = new Promise<EnvironmentProcessResult>((resolve) => { resolveResult = resolve; });
  socket.once("close", () => {
    ended = true;
    wakeReader();
    wakeWriter();
    void (async () => {
      let exitCode: number | null = null;
      try {
        const response = await new Promise<IncomingMessage>((resolve, reject) => {
          const outgoing = httpRequest({ socketPath, method: "GET", path: `/${version}/exec/${encodeURIComponent(execId)}/json`, timeout: timeoutMs }, resolve);
          outgoing.once("error", reject);
          outgoing.end();
        });
        const body = await readResponse(response, 1024 * 1024);
        if (response.statusCode === 200) {
          const inspected = record(decodeDockerJson(body));
          if (typeof inspected.ExitCode === "number") exitCode = inspected.ExitCode;
        }
      } catch { /* The terminal is already closed; retain the unknown exit code. */ }
      resolveResult({ exitCode, cancelled: terminating });
    })();
  });

  let terminating = false;
  socket.resume();
  return {
    output,
    result,
    async write(data) {
      if (ended || socket.destroyed) throw new DockerEngineClientError(undefined, "Interactive process has ended");
      if (!socket.write(data)) await new Promise<void>((resolve, reject) => {
        socket.once("drain", resolve);
        socket.once("error", reject);
      });
    },
    async resize(columns, rows) { await resize(execId, columns, rows); },
    async terminate() {
      if (ended || terminating) return;
      terminating = true;
      await terminateSupervisor(containerId, request.controlToken);
      await result;
    },
  };
}

function decodeDockerJson(body: Uint8Array): unknown {
  try { return JSON.parse(Buffer.from(body).toString("utf8")); }
  catch (cause) { throw new DockerEngineClientError(undefined, "Docker Engine returned invalid JSON", { cause }); }
}

/**
 * Docker Engine lifecycle client for a dedicated manager process. Do not
 * construct this inside the T3 gateway; possession of the socket is root-like.
 */
export function createDockerEngineClient(options: DockerEngineClientOptions): DockerClient {
  if (!options.transport && (!options.socketPath || !options.socketPath.startsWith("/"))) throw new Error("Docker socket path must be absolute");
  const version = options.apiVersion ?? "v1.44";
  if (!/^v\d+\.\d+$/.test(version)) throw new Error("Docker Engine API version is invalid");
  const timeoutMs = options.timeoutMs ?? 15_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 120_000) throw new Error("Docker Engine timeout is invalid");
  const dockerBinary = options.dockerBinary ?? "docker";
  const devContainerCliBinary = options.devContainerCliBinary ?? "devcontainer";
  const workerCommand = options.workerCommand ?? ["node", "/usr/local/lib/subpolar/worker.mjs"];
  const terminalSupervisorCommand = options.terminalSupervisorCommand ?? ["node", "/usr/local/lib/subpolar/terminal-supervisor.mjs"];
  if (!dockerBinary || dockerBinary.includes("\0") || !devContainerCliBinary || devContainerCliBinary.includes("\0") || workerCommand.length === 0 || workerCommand.some((part) => !part || part.includes("\0")) || terminalSupervisorCommand.length === 0 || terminalSupervisorCommand.some((part) => !part || part.includes("\0"))) {
    throw new Error("Docker worker command configuration is invalid");
  }
  const processRunner = options.processRunner ?? ((containerId, request) => runDockerWorker(dockerBinary, workerCommand, containerId, request));
  const imageBuildRunner = options.imageBuildRunner ?? ((request) => request.kind === "devcontainer"
    ? runDevContainerCliBuild(devContainerCliBinary, request)
    : runDockerImageBuild(dockerBinary, request));
  const terminateSupervisor = async (containerId: string, controlToken: string) => {
    const created = await request("POST", `/containers/${encodeURIComponent(containerId)}/exec`, {
      Cmd: [...terminalSupervisorCommand, "--terminate", controlToken],
      AttachStdin: false,
      AttachStdout: false,
      AttachStderr: false,
      Tty: false,
    }, [201]);
    const execId = text(record(decodeJson(created.body)).Id);
    if (!execId) throw new DockerEngineClientError(undefined, "Docker Engine did not return a terminal cleanup process ID");
    await request("POST", `/exec/${encodeURIComponent(execId)}/start`, { Detach: true, Tty: false }, [200]);
  };
  const interactiveRunner: DockerContainerInteractiveRunner = options.interactiveRunner ?? ((containerId, request, resize, terminate) => {
    if (options.transport) throw new DockerEngineClientError(undefined, "Interactive TTY requires the Docker Engine socket transport");
    return runDockerTty(options.socketPath, version, timeoutMs, containerId, request, resize, terminate);
  });
  const managedSessionRunner: DockerContainerManagedSessionRunner = options.managedSessionRunner ?? ((containerId, request, terminate) =>
    runDockerManagedSession(dockerBinary, containerId, request, terminate));

  const request = async (
    method: string,
    route: string,
    body?: unknown,
    expected: readonly number[] = [200],
  ): Promise<EngineResponse> => {
    const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    const requestPath = `/${version}${route}`;
    const headers = payload ? { "content-type": "application/json", "content-length": payload.byteLength } : undefined;
    try {
      const result = options.transport
        ? await options.transport({
            method,
            path: requestPath,
            ...(headers === undefined ? {} : { headers }),
            ...(payload === undefined ? {} : { body: payload }),
          })
        : await (async () => {
            const requestOptions: RequestOptions = { socketPath: options.socketPath, method, path: requestPath, headers, timeout: timeoutMs };
            const response = await new Promise<IncomingMessage>((resolve, reject) => {
              const outgoing = httpRequest(requestOptions, resolve);
              outgoing.setTimeout(timeoutMs, () => outgoing.destroy(new Error("Docker Engine request timed out")));
              outgoing.once("error", reject);
              if (payload) outgoing.write(payload);
              outgoing.end();
            });
            return { statusCode: response.statusCode ?? 0, body: await readResponse(response, 4 * 1024 * 1024) };
          })();
      if (result.body.byteLength > 4 * 1024 * 1024) throw new Error("Docker Engine response exceeded the size limit");
      const statusCode = result.statusCode;
      if (!expected.includes(statusCode)) {
        throw new DockerEngineClientError(statusCode, `Docker Engine request failed with HTTP ${statusCode}`);
      }
      return { statusCode, body: result.body };
    } catch (error) {
      if (error instanceof DockerEngineClientError) throw error;
      throw new DockerEngineClientError(undefined, "Docker Engine request failed", { cause: error });
    }
  };

  const decodeJson = (body: Uint8Array): unknown => {
    try {
      return JSON.parse(Buffer.from(body).toString("utf8"));
    } catch (cause) {
      throw new DockerEngineClientError(undefined, "Docker Engine returned invalid JSON", { cause });
    }
  };
  const idPath = (id: string): string => `/containers/${encodeURIComponent(id)}`;
  const volumePath = (name: string): string => `/volumes/${encodeURIComponent(name)}`;
  const networkPath = (name: string): string => `/networks/${encodeURIComponent(name)}`;

  return {
    async inspectContainer(name) {
      try {
        const response = await request("GET", `${idPath(name)}/json`);
        return normalizeInspection(decodeJson(response.body));
      } catch (error) {
        if (error instanceof DockerEngineClientError && error.statusCode === 404) return null;
        throw error;
      }
    },
    async createContainer(createOptions) {
      const response = await request(
        "POST",
        `/containers/create?name=${encodeURIComponent(createOptions.name)}`,
        createPayload(createOptions),
        [201],
      );
      const created = record(decodeJson(response.body));
      if (typeof created.Id !== "string" || !created.Id) throw new DockerEngineClientError(undefined, "Docker Engine did not return a container ID");
      return { id: created.Id };
    },
    async buildImage(buildRequest) {
      return imageBuildRunner(buildRequest);
    },
    async startContainer(id) {
      await request("POST", `${idPath(id)}/start`, undefined, [204, 304]);
    },
    async stopContainer(id, stopOptions) {
      await request("POST", `${idPath(id)}/stop?t=${stopOptions.timeoutSeconds}`, undefined, [204, 304]);
    },
    async removeContainer(id, removeOptions) {
      await request("DELETE", `${idPath(id)}?force=${removeOptions.force}&v=${removeOptions.removeVolumes}`, undefined, [204]);
    },
    async inspectVolume(name) {
      try {
        const response = await request("GET", volumePath(name));
        return normalizeVolumeInspection(decodeJson(response.body));
      } catch (error) {
        if (error instanceof DockerEngineClientError && error.statusCode === 404) return null;
        throw error;
      }
    },
    async createVolume(createOptions) {
      const response = await request("POST", "/volumes/create", createVolumePayload(createOptions), [201]);
      return normalizeVolumeInspection(decodeJson(response.body));
    },
    async removeVolume(name) {
      await request("DELETE", volumePath(name), undefined, [204]);
    },
    async inspectNetwork(name) {
      try {
        const response = await request("GET", networkPath(name));
        return normalizeNetworkInspection(decodeJson(response.body));
      } catch (error) {
        if (error instanceof DockerEngineClientError && error.statusCode === 404) return null;
        throw error;
      }
    },
    async createNetwork(createOptions: DockerNetworkCreateOptions) {
      const response = await request("POST", "/networks/create", {
        Name: createOptions.name,
        Driver: createOptions.driver,
        Internal: createOptions.internal,
        CheckDuplicate: true,
        Labels: createOptions.labels,
      }, [201]);
      const created = record(decodeJson(response.body));
      const id = text(created.Id);
      if (!id) throw new DockerEngineClientError(undefined, "Docker Engine did not return a network ID");
      const inspected = await request("GET", networkPath(id));
      return normalizeNetworkInspection(decodeJson(inspected.body));
    },
    async removeNetwork(name) {
      await request("DELETE", networkPath(name), undefined, [204]);
    },
    async waitContainerHealthy(id, maxWaitMs) {
      const deadline = Date.now() + maxWaitMs;
      while (Date.now() < deadline) {
        const response = await request("GET", `${idPath(id)}/json`);
        const state = record(record(decodeJson(response.body)).State);
        if (state.Status !== "running") throw new DockerEngineClientError(undefined, "PostgreSQL sidecar stopped before becoming healthy");
        const health = record(state.Health);
        if (health.Status === "healthy") return;
        if (health.Status === "unhealthy") throw new DockerEngineClientError(undefined, "PostgreSQL sidecar health check failed");
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      throw new DockerEngineClientError(undefined, "PostgreSQL sidecar did not become healthy before the deadline");
    },
    async pullImage(image) {
      await runDockerImagePull(dockerBinary, image);
    },
    async executeContainer(id, processRequest) {
      return processRunner(id, processRequest);
    },
    async startInteractiveContainer(id, interactiveRequest) {
      const controlToken = randomUUID();
      const encodedRequest = Buffer.from(JSON.stringify({
        command: interactiveRequest.command,
        worktreeDirectory: interactiveRequest.worktreeDirectory,
        workingDirectory: interactiveRequest.workingDirectory,
        environment: interactiveRequest.environment ?? {},
      })).toString("base64url");
      const supervisedRequest: DockerContainerInteractiveRequest = {
        command: [...terminalSupervisorCommand, controlToken, encodedRequest],
        worktreeDirectory: interactiveRequest.worktreeDirectory,
        workingDirectory: interactiveRequest.worktreeDirectory,
        environment: {},
        controlToken,
      };
      return interactiveRunner(id, supervisedRequest, async (execId, columns, rows) => {
        await request("POST", `/exec/${encodeURIComponent(execId)}/resize?h=${rows}&w=${columns}`, undefined, [200]);
      }, terminateSupervisor);
    },
    async startManagedSessionContainer(id, managedRequest) {
      const controlToken = randomUUID();
      const encodedRequest = Buffer.from(JSON.stringify({
        command: managedRequest.command,
        worktreeDirectory: managedRequest.worktreeDirectory,
        workingDirectory: managedRequest.workingDirectory,
        environment: managedRequest.environment ?? {},
      })).toString("base64url");
      return managedSessionRunner(id, {
        command: [...terminalSupervisorCommand, "--stdio", controlToken, encodedRequest],
        worktreeDirectory: managedRequest.worktreeDirectory,
        workingDirectory: managedRequest.worktreeDirectory,
        environment: {},
        controlToken,
      }, terminateSupervisor);
    },
  };
}
