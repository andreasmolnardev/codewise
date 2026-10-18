import { createHash } from "node:crypto";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { parse as parseYaml } from "yaml";

import type {
  EnvironmentIdentity,
  EnvironmentProcessBackend,
  EnvironmentProcessRequest,
  EnvironmentProcessResult,
  EnvironmentInteractiveProcessRequest,
  EnvironmentInteractiveSession,
  EnvironmentManagedProcessSession,
  EnvironmentManagedSessionRequest,
  EnvironmentStatus,
  ManagedEnvironment,
} from "./index.ts";

const MANAGED_BY = "io.subpolar.environment-manager";
const ID_LABEL = "io.subpolar.environment-id";
const OWNER_LABEL = "io.subpolar.owner-sha256";
const WORKSPACE_LABEL = "io.subpolar.workspace-sha256";
const WORKTREE_LABEL = "io.subpolar.worktree-sha256";
const LABELS = [MANAGED_BY, ID_LABEL, OWNER_LABEL, WORKSPACE_LABEL, WORKTREE_LABEL] as const;

export class DockerEnvironmentError extends Error {
  constructor(
    readonly code:
      | "INVALID_DOCKER_CONFIG"
      | "WORKSPACE_MAPPING_INVALID"
      | "WORKTREE_MAPPING_INVALID"
      | "GIT_METADATA_MAPPING_INVALID"
      | "UNSUPPORTED_GIT_LAYOUT"
      | "DOCKER_IDENTITY_MISMATCH"
      | "DOCKER_CONFIGURATION_MISMATCH"
      | "DEV_CONTAINER_CONFIGURATION_INVALID"
      | "DEV_CONTAINER_CONFIGURATION_UNSUPPORTED"
      | "DEV_CONTAINER_CONFIGURATION_SELECTION_REQUIRED"
      | "DEV_CONTAINER_BUILD_UNAVAILABLE"
      | "DEV_CONTAINER_BUILD_FAILED"
      | "DEV_CONTAINER_SETUP_FAILED"
      | "PROCESS_EXECUTION_UNAVAILABLE"
      | "PROCESS_REQUEST_INVALID"
      | "EGRESS_UNAVAILABLE",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "DockerEnvironmentError";
  }
}

export interface DockerEnvironmentConfig {
  /** Path visible to the gateway process and recorded in EnvironmentIdentity. */
  readonly gatewayStorageRoot: string;
  /** Absolute path resolved by the Docker daemon, supplied by the operator. */
  readonly hostStorageRoot: string;
  /** Absolute path inside every worker container. */
  readonly containerStorageRoot: string;
  /** Optional paired roots used to map T3's shared Git metadata directory. */
  readonly gatewayGitRoot?: string;
  readonly hostGitRoot?: string;
  /** Image reference selected by the operator. */
  readonly image: string;
  /** Exact feature references the operator has authorized for execution during image builds. */
  readonly allowedDevContainerFeatures?: readonly string[];
  /** Compose can reach Docker-host services through bridge gateways, so enabling it is an explicit operator decision. */
  readonly allowDevContainerCompose?: boolean;
  /** Relative config path, such as `.devcontainer/node/devcontainer.json`, for multi-config worktrees. */
  readonly defaultDevContainerConfiguration?: string;
  readonly memoryBytes?: number;
  readonly nanoCpus?: number;
  readonly pidsLimit?: number;
  /** Reserved for manager-owned provider egress; currently rejected fail-closed. */
  readonly egress?: { readonly allowHosts: readonly string[] };
}

export interface DockerBindMount {
  readonly type: "bind";
  readonly source: string;
  readonly target: string;
  readonly readOnly: false;
}

export interface DockerVolumeMount {
  readonly type: "volume";
  readonly source: string;
  readonly target: string;
  readonly readOnly: false;
}

export type DockerMount = DockerBindMount | DockerVolumeMount;

export interface DockerVolumeInspection {
  readonly name: string;
  readonly driver: string;
  readonly labels: Readonly<Record<string, string | undefined>>;
}

export interface DockerVolumeCreateOptions {
  readonly name: string;
  readonly driver: "local";
  readonly labels: Readonly<Record<string, string>>;
}

export interface DockerNetworkInspection {
  readonly id: string;
  readonly name: string;
  readonly driver: string;
  readonly internal: boolean;
  readonly labels: Readonly<Record<string, string | undefined>>;
  readonly containerIds: readonly string[];
  readonly containerAliases: Readonly<Record<string, readonly string[]>>;
}

export interface DockerNetworkCreateOptions {
  readonly name: string;
  readonly driver: "bridge";
  readonly internal: true;
  readonly labels: Readonly<Record<string, string>>;
}

export interface DockerContainerCreateOptions {
  readonly name: string;
  readonly image: string;
  readonly labels: Readonly<Record<string, string>>;
  readonly user: string;
  readonly privileged: false;
  readonly readOnlyRootfs: true;
  readonly networkMode: string;
  readonly networkAliases?: readonly string[];
  readonly capDrop: readonly ["ALL"];
  readonly securityOpt: readonly ["no-new-privileges:true"];
  readonly memoryBytes: number;
  readonly nanoCpus: number;
  readonly pidsLimit: number;
  readonly mounts: readonly DockerMount[];
  readonly tmpfs: Readonly<Record<string, string>>;
  readonly environment: Readonly<Record<string, string>>;
  readonly healthcheck?: {
    readonly test: readonly ["CMD", "pg_isready"];
    readonly intervalMs: number;
    readonly timeoutMs: number;
    readonly retries: number;
    readonly startPeriodMs: number;
  };
}

export type DockerImageBuildRequest =
  | {
    readonly kind: "dockerfile";
    readonly contextPath: string;
    readonly dockerfilePath: string;
    readonly image: string;
  }
  | {
    readonly kind: "devcontainer";
    readonly workspaceFolder: string;
    readonly configurationPath: string;
    readonly image: string;
  };

export interface DockerContainerProcessRequest {
  readonly command: readonly string[];
  readonly worktreeDirectory: string;
  readonly workingDirectory: string;
  readonly environment: Readonly<Record<string, string>>;
  readonly signal?: AbortSignal;
  readonly onOutput?: EnvironmentProcessRequest["onOutput"];
}

export interface DockerContainerInteractiveRequest extends EnvironmentInteractiveProcessRequest {
  readonly command: readonly string[];
  readonly worktreeDirectory: string;
  readonly workingDirectory: string;
  /** Manager generated token used only by the Docker Engine adapter for cleanup. */
  readonly controlToken?: string;
}

export interface DockerContainerManagedSessionRequest extends EnvironmentManagedSessionRequest {
  readonly command: readonly string[];
  readonly worktreeDirectory: string;
  readonly workingDirectory: string;
  readonly controlToken?: string;
}

export type DockerContainerState = "created" | "running" | "paused" | "restarting" | "exited" | "dead";

/** Normalized, read-only information the adapter requires from a Docker client. */
export interface DockerContainerInspection {
  readonly id: string;
  readonly name: string;
  readonly state: DockerContainerState;
  readonly labels: Readonly<Record<string, string | undefined>>;
  readonly config: {
    readonly image: string;
    readonly user: string;
    readonly privileged: boolean;
    readonly readOnlyRootfs: boolean;
    readonly networkMode: string;
    readonly networkAliases?: Readonly<Record<string, readonly string[]>>;
    readonly capDrop: readonly string[];
    readonly securityOpt: readonly string[];
    readonly memoryBytes: number;
    readonly nanoCpus: number;
    readonly pidsLimit: number;
    readonly mounts: readonly DockerMount[];
    readonly tmpfs: Readonly<Record<string, string>>;
    readonly environment: Readonly<Record<string, string>>;
  };
}

/**
 * Inject a narrowly scoped Docker client from a manager process. This adapter
 * never imports an SDK and must not be wired to an unrestricted daemon socket
 * in the T3 gateway. Implementations should expose only the methods below.
 */
export interface DockerClient {
  inspectContainer(name: string): Promise<DockerContainerInspection | null>;
  createContainer(options: DockerContainerCreateOptions): Promise<{ readonly id: string }>;
  startContainer(id: string): Promise<void>;
  stopContainer(id: string, options: { readonly timeoutSeconds: 10 }): Promise<void>;
  removeContainer(id: string, options: { readonly force: false; readonly removeVolumes: false }): Promise<void>;
  inspectVolume(name: string): Promise<DockerVolumeInspection | null>;
  createVolume(options: DockerVolumeCreateOptions): Promise<DockerVolumeInspection>;
  removeVolume(name: string): Promise<void>;
  inspectNetwork?(name: string): Promise<DockerNetworkInspection | null>;
  createNetwork?(options: DockerNetworkCreateOptions): Promise<DockerNetworkInspection>;
  removeNetwork?(name: string): Promise<void>;
  waitContainerHealthy?(id: string, timeoutMs: number): Promise<void>;
  pullImage?(image: string): Promise<void>;
  /** Must preserve argv boundaries, stream both output channels, and terminate the owned process on abort. */
  executeContainer?(id: string, request: DockerContainerProcessRequest): Promise<EnvironmentProcessResult>;
  startInteractiveContainer?(id: string, request: DockerContainerInteractiveRequest): Promise<EnvironmentInteractiveSession>;
  startManagedSessionContainer?(id: string, request: DockerContainerManagedSessionRequest): Promise<EnvironmentManagedProcessSession>;
  /** Build repository supplied Dockerfiles in the manager process, never in the gateway. */
  buildImage?(request: DockerImageBuildRequest): Promise<void>;
}

export const DOCKER_RESOURCE_DEFAULTS = Object.freeze({
  memoryBytes: 1024 * 1024 * 1024,
  nanoCpus: 1_000_000_000,
  pidsLimit: 256,
});

const TMPFS = Object.freeze({
  "/tmp": "rw,nosuid,nodev,size=64m",
  "/run": "rw,nosuid,nodev,size=16m",
});
const LEGACY_ENVIRONMENT = Object.freeze({ HOME: "/tmp/home", TMPDIR: "/tmp" });
const ENVIRONMENT = Object.freeze({ ...LEGACY_ENVIRONMENT, SUBPOLAR_RUNTIME_DATA_DIR: "/var/lib/subpolar" });

interface ResolvedDevContainerConfiguration {
  readonly image: string;
  readonly build?: DockerImageBuildRequest;
  readonly containerEnvironment: Readonly<Record<string, string>>;
  readonly workspaceMountTarget?: string;
  readonly workspaceFolder?: string;
  readonly postCreateCommand?: DevContainerLifecycleCommand;
  readonly postStartCommand?: DevContainerLifecycleCommand;
  readonly compose?: ResolvedComposeConfiguration;
}

interface ResolvedComposeConfiguration {
  readonly service: string;
  readonly databaseService: string;
  readonly databaseImage: string;
  readonly databaseEnvironment: Readonly<Record<string, string>>;
  readonly networkName: string;
  readonly databaseName: string;
  readonly databaseVolumeName: string;
}

function workspaceMount(value: unknown, configuration: string, containerStorageRoot: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length > 4096 || value.includes("\0")) {
    throw new DockerEnvironmentError("DEV_CONTAINER_CONFIGURATION_INVALID", `${configuration} workspaceMount must be a short mount string`);
  }
  const fields = new Map<string, string>();
  for (const part of value.split(",")) {
    const separator = part.indexOf("=");
    if (separator <= 0) {
      throw new DockerEnvironmentError("DEV_CONTAINER_CONFIGURATION_UNSUPPORTED", `${configuration} workspaceMount must use key=value fields`);
    }
    const key = part.slice(0, separator).trim();
    const fieldValue = part.slice(separator + 1).trim();
    if (!key || !fieldValue || fields.has(key)) {
      throw new DockerEnvironmentError("DEV_CONTAINER_CONFIGURATION_INVALID", `${configuration} workspaceMount has an empty or duplicate field`);
    }
    fields.set(key, fieldValue);
  }
  const source = fields.get("source");
  const target = fields.get("target");
  const type = fields.get("type");
  if (source !== "${localWorkspaceFolder}" || type !== "bind" || !target ||
      [...fields.keys()].some((key) => !["source", "target", "type", "consistency"].includes(key)) ||
      (fields.has("consistency") && !["consistent", "cached", "delegated"].includes(fields.get("consistency")!))) {
    throw new DockerEnvironmentError(
      "DEV_CONTAINER_CONFIGURATION_UNSUPPORTED",
      `${configuration} workspaceMount only supports the current worktree as a bind source and optional consistency hints`,
    );
  }
  if (!path.posix.isAbsolute(target) || path.posix.normalize(target) !== target ||
      target === containerStorageRoot || !within(containerStorageRoot, target) ||
      within(target, "/var/lib/subpolar") || within("/var/lib/subpolar", target)) {
    throw new DockerEnvironmentError(
      "DEV_CONTAINER_CONFIGURATION_INVALID",
      `${configuration} workspaceMount target must be a dedicated path below ${containerStorageRoot}`,
    );
  }
  return target;
}

function workspaceFolder(value: unknown, configuration: string, mountTarget: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length > 4096 || value.includes("\0") || !path.posix.isAbsolute(value) ||
      path.posix.normalize(value) !== value || !mountTarget || !within(mountTarget, value)) {
    throw new DockerEnvironmentError(
      "DEV_CONTAINER_CONFIGURATION_INVALID",
      `${configuration} workspaceFolder must be a normalized absolute path inside its workspaceMount`,
    );
  }
  return value;
}

type DevContainerLifecycleCommand =
  | { readonly kind: "shell"; readonly value: string }
  | { readonly kind: "argv"; readonly value: readonly string[] };

function lifecycleCommand(value: unknown, name: string, configuration: string): DevContainerLifecycleCommand | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "string") {
    if (!value.trim() || value.includes("\0") || Buffer.byteLength(value) > 16 * 1024) {
      throw new DockerEnvironmentError("DEV_CONTAINER_CONFIGURATION_INVALID", `${configuration} ${name} must be a non-empty command under 16 KiB`);
    }
    return { kind: "shell", value };
  }
  if (Array.isArray(value) && value.length > 0 && value.length <= 128 && value.every((part) =>
    typeof part === "string" && part.length > 0 && !part.includes("\0") && Buffer.byteLength(part) <= 8192)) {
    return { kind: "argv", value: [...value] as string[] };
  }
  throw new DockerEnvironmentError(
    "DEV_CONTAINER_CONFIGURATION_UNSUPPORTED",
    `${configuration} ${name} must be a shell string or a non-empty argv array`,
  );
}

function parseJsonc(source: string): unknown {
  // Dev Container files are JSONC. Remove comments and trailing commas while
  // respecting quoted strings, then let JSON.parse validate the structure.
  let withoutComments = "";
  let inString = false;
  let escaped = false;
  for (let index = 0; index < source.length; index += 1) {
    const current = source[index]!;
    const next = source[index + 1];
    if (inString) {
      withoutComments += current;
      if (escaped) escaped = false;
      else if (current === "\\") escaped = true;
      else if (current === '"') inString = false;
      continue;
    }
    if (current === '"') {
      inString = true;
      withoutComments += current;
    } else if (current === "/" && next === "/") {
      while (index < source.length && source[index] !== "\n") index += 1;
      withoutComments += "\n";
    } else if (current === "/" && next === "*") {
      index += 2;
      while (index < source.length && !(source[index] === "*" && source[index + 1] === "/")) index += 1;
      if (index >= source.length) throw new Error("Unterminated comment");
      index += 1;
      withoutComments += " ";
    } else {
      withoutComments += current;
    }
  }
  let normalized = "";
  inString = false;
  escaped = false;
  for (let index = 0; index < withoutComments.length; index += 1) {
    const current = withoutComments[index]!;
    if (inString) {
      normalized += current;
      if (escaped) escaped = false;
      else if (current === "\\") escaped = true;
      else if (current === '"') inString = false;
    } else if (current === '"') {
      inString = true;
      normalized += current;
    } else if (current === ",") {
      let lookahead = index + 1;
      while (/\s/.test(withoutComments[lookahead] ?? "")) lookahead += 1;
      if (withoutComments[lookahead] !== "}" && withoutComments[lookahead] !== "]") normalized += current;
    } else {
      normalized += current;
    }
  }
  return JSON.parse(normalized) as unknown;
}

function objectRecord(value: unknown, detail: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new DockerEnvironmentError("DEV_CONTAINER_CONFIGURATION_INVALID", `${detail} must be an object`);
  }
  return value as Record<string, unknown>;
}

async function hashLocalFeatureDirectory(directory: string, configuration: string): Promise<string> {
  const digest = createHash("sha256");
  const pending = [directory];
  let fileCount = 0;
  let totalBytes = 0;
  while (pending.length > 0) {
    const current = pending.pop()!;
    const entries = (await readdir(current, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const entryPath = path.join(current, entry.name);
      if (entry.isSymbolicLink()) {
        throw new DockerEnvironmentError("DEV_CONTAINER_CONFIGURATION_INVALID", `${configuration} local Features cannot contain symlinks`);
      }
      if (entry.isDirectory()) {
        pending.push(entryPath);
        continue;
      }
      if (!entry.isFile() || ++fileCount > 512) {
        throw new DockerEnvironmentError("DEV_CONTAINER_CONFIGURATION_INVALID", `${configuration} local Feature exceeds the supported file limit`);
      }
      const stat = await lstat(entryPath);
      totalBytes += stat.size;
      if (totalBytes > 8 * 1024 * 1024) {
        throw new DockerEnvironmentError("DEV_CONTAINER_CONFIGURATION_INVALID", `${configuration} local Feature exceeds the 8 MiB source limit`);
      }
      digest.update(path.relative(directory, entryPath)).update("\0").update(await readFile(entryPath)).update("\0");
    }
  }
  return digest.digest("hex");
}

function composeEnvironment(value: unknown, detail: string, allowedKeys?: readonly string[]): Record<string, string> {
  if (value === undefined) return {};
  const entries = objectRecord(value, `${detail} environment`);
  const result: Record<string, string> = {};
  for (const [key, item] of Object.entries(entries)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || ["HOME", "TMPDIR", "SUBPOLAR_RUNTIME_DATA_DIR"].includes(key) || typeof item !== "string" || item.includes("\0") ||
        item.includes("${") || Buffer.byteLength(item) > 8192 || (allowedKeys && !allowedKeys.includes(key))) {
      throw new DockerEnvironmentError("DEV_CONTAINER_CONFIGURATION_INVALID", `${detail} contains an unsupported environment entry: ${key}`);
    }
    result[key] = item;
  }
  return result;
}

async function resolveComposeConfiguration(
  identity: EnvironmentIdentity,
  config: DockerEnvironmentConfig,
  devcontainerPath: string,
  devcontainerValue: Record<string, unknown>,
  workspaceMountTarget: string | undefined,
): Promise<{ image: string; build?: DockerImageBuildRequest; environment: Record<string, string>; compose: ResolvedComposeConfiguration }> {
  const configuration = path.relative(identity.worktreePath, devcontainerPath);
  const composeFiles = Array.isArray(devcontainerValue.dockerComposeFile)
    ? devcontainerValue.dockerComposeFile
    : [devcontainerValue.dockerComposeFile];
  if (composeFiles.length !== 1 || typeof composeFiles[0] !== "string" || !composeFiles[0] ||
      composeFiles[0].length > 4096 || path.isAbsolute(composeFiles[0]) || composeFiles[0].includes("\0")) {
    throw new DockerEnvironmentError("DEV_CONTAINER_CONFIGURATION_UNSUPPORTED", `${configuration} must name one relative Docker Compose file`);
  }
  const composePath = path.resolve(path.dirname(devcontainerPath), composeFiles[0]);
  let realComposePath: string;
  try { realComposePath = await realpath(composePath); }
  catch (cause) { throw new DockerEnvironmentError("DEV_CONTAINER_CONFIGURATION_INVALID", `${configuration} Compose file cannot be resolved`, { cause }); }
  if (!within(identity.worktreePath, realComposePath) || !(await lstat(realComposePath)).isFile()) {
    throw new DockerEnvironmentError("DEV_CONTAINER_CONFIGURATION_INVALID", `${configuration} Compose file must be a regular file inside the worktree`);
  }
  let document: unknown;
  try {
    const source = await readFile(realComposePath, "utf8");
    if (Buffer.byteLength(source) > 128 * 1024) throw new Error("Compose file exceeds 128 KiB");
    document = parseYaml(source, { uniqueKeys: true, maxAliasCount: 0 });
  } catch (cause) {
    throw new DockerEnvironmentError("DEV_CONTAINER_CONFIGURATION_INVALID", `${configuration} Compose file is invalid YAML`, { cause });
  }
  const root = objectRecord(document, `${configuration} Compose document`);
  if (Object.keys(root).some((key) => key !== "services" && key !== "volumes" && key !== "name" && key !== "version")) {
    throw new DockerEnvironmentError("DEV_CONTAINER_CONFIGURATION_UNSUPPORTED", `${configuration} Compose file uses unsupported top-level options`);
  }
  if (root.name !== undefined && (typeof root.name !== "string" || root.name.includes("${") || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,62}$/.test(root.name))) {
    throw new DockerEnvironmentError("DEV_CONTAINER_CONFIGURATION_INVALID", `${configuration} Compose project name is invalid`);
  }
  const services = objectRecord(root.services, `${configuration} Compose services`);
  const topLevelVolumes = root.volumes === undefined ? {} : objectRecord(root.volumes, `${configuration} Compose volumes`);
  if (Object.keys(topLevelVolumes).some((name) => name !== "subpolar-data")) {
    throw new DockerEnvironmentError("DEV_CONTAINER_CONFIGURATION_UNSUPPORTED", `${configuration} Compose may only declare the manager-owned subpolar-data volume`);
  }
  if (topLevelVolumes["subpolar-data"] !== undefined &&
      Object.keys(objectRecord(topLevelVolumes["subpolar-data"], `${configuration} subpolar-data volume`)).length > 0) {
    throw new DockerEnvironmentError("DEV_CONTAINER_CONFIGURATION_UNSUPPORTED", `${configuration} manager-owned subpolar-data volume does not accept Compose volume options`);
  }
  const service = devcontainerValue.service;
  if (typeof service !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,62}$/.test(service)) {
    throw new DockerEnvironmentError("DEV_CONTAINER_CONFIGURATION_INVALID", `${configuration} Compose service must be a valid service name`);
  }
  const app = objectRecord(services[service], `${configuration} Compose service ${service}`);
  const runServices = devcontainerValue.runServices;
  if (runServices !== undefined && (!Array.isArray(runServices) || runServices.some((name) => typeof name !== "string"))) {
    throw new DockerEnvironmentError("DEV_CONTAINER_CONFIGURATION_INVALID", `${configuration} runServices must be a list of service names`);
  }
  const serviceNames = Object.keys(services);
  if (serviceNames.length < 1 || serviceNames.length > 2 || serviceNames.some((name) => !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,62}$/.test(name))) {
    throw new DockerEnvironmentError("DEV_CONTAINER_CONFIGURATION_UNSUPPORTED", `${configuration} supports one app service and at most one PostgreSQL service`);
  }
  const databaseService = serviceNames.find((name) => name !== service);
  let database: Omit<ResolvedComposeConfiguration, "service" | "networkName" | "databaseName" | "databaseVolumeName"> | undefined;
  if (databaseService !== undefined) {
    const candidate = objectRecord(services[databaseService], `${configuration} Compose service ${databaseService}`);
    const candidateKeys = Object.keys(candidate);
    if (candidateKeys.some((key) => !["image", "environment", "volumes", "healthcheck"].includes(key)) ||
        typeof candidate.image !== "string" || !/^postgres(?::[A-Za-z0-9._-]+)?(?:@sha256:[a-f0-9]{64})?$/.test(candidate.image)) {
      throw new DockerEnvironmentError("DEV_CONTAINER_CONFIGURATION_UNSUPPORTED", `${configuration} allows one PostgreSQL sidecar with a pinned or tagged postgres image`);
    }
    const databaseEnvironment = composeEnvironment(candidate.environment, `${configuration} PostgreSQL`, ["POSTGRES_DB", "POSTGRES_USER", "POSTGRES_PASSWORD"]);
    if (typeof databaseEnvironment.POSTGRES_PASSWORD !== "string" || !databaseEnvironment.POSTGRES_PASSWORD ||
        (databaseEnvironment.POSTGRES_DB !== undefined && !/^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/.test(databaseEnvironment.POSTGRES_DB)) ||
        (databaseEnvironment.POSTGRES_USER !== undefined && !/^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/.test(databaseEnvironment.POSTGRES_USER))) {
      throw new DockerEnvironmentError("DEV_CONTAINER_CONFIGURATION_INVALID", `${configuration} PostgreSQL service requires a literal POSTGRES_PASSWORD and valid optional database/user names`);
    }
    if (candidate.volumes !== undefined) {
      if (!Array.isArray(candidate.volumes) || candidate.volumes.length !== 1 || candidate.volumes[0] !== "subpolar-data:/var/lib/postgresql/data") {
        throw new DockerEnvironmentError("DEV_CONTAINER_CONFIGURATION_UNSUPPORTED", `${configuration} PostgreSQL may only use subpolar-data:/var/lib/postgresql/data`);
      }
      const declaredVolumes = topLevelVolumes;
      if (Object.keys(declaredVolumes).some((name) => name !== "subpolar-data") ||
          (declaredVolumes["subpolar-data"] !== undefined && Object.keys(objectRecord(declaredVolumes["subpolar-data"], `${configuration} subpolar-data volume`)).length > 0)) {
        throw new DockerEnvironmentError("DEV_CONTAINER_CONFIGURATION_UNSUPPORTED", `${configuration} supports only the manager-owned subpolar-data volume`);
      }
    }
    if (candidate.healthcheck !== undefined) {
      const healthcheck = objectRecord(candidate.healthcheck, `${configuration} PostgreSQL healthcheck`);
      if (Object.keys(healthcheck).some((key) => !["test", "interval", "timeout", "retries", "start_period"].includes(key)) ||
          !Array.isArray(healthcheck.test) || healthcheck.test.length !== 2 || healthcheck.test[0] !== "CMD" || healthcheck.test[1] !== "pg_isready") {
        throw new DockerEnvironmentError("DEV_CONTAINER_CONFIGURATION_UNSUPPORTED", `${configuration} PostgreSQL healthcheck must be [CMD, pg_isready]`);
      }
    }
    const dependsOn = app.depends_on;
    const dependsOnNames = Array.isArray(dependsOn) ? dependsOn : typeof dependsOn === "object" && dependsOn !== null ? Object.keys(dependsOn) : [];
    if (!dependsOnNames.includes(databaseService)) {
      throw new DockerEnvironmentError("DEV_CONTAINER_CONFIGURATION_INVALID", `${configuration} app service must depend on its PostgreSQL service`);
    }
    database = { databaseService, databaseImage: candidate.image, databaseEnvironment };
  }
  const allowedRunServices = databaseService === undefined ? [service] : [service, databaseService];
  if (Array.isArray(runServices) && (!runServices.includes(service) ||
      (databaseService !== undefined && !runServices.includes(databaseService)) ||
      runServices.some((name) => typeof name !== "string" || !allowedRunServices.includes(name)))) {
    throw new DockerEnvironmentError("DEV_CONTAINER_CONFIGURATION_UNSUPPORTED", `${configuration} runServices may include only the selected app and its PostgreSQL dependency`);
  }
  if (Object.keys(app).some((key) => !["image", "build", "environment", "depends_on", "volumes"].includes(key))) {
    throw new DockerEnvironmentError("DEV_CONTAINER_CONFIGURATION_UNSUPPORTED", `${configuration} selected Compose service has unsupported options`);
  }
  if (app.volumes !== undefined && (!Array.isArray(app.volumes) || app.volumes.length !== 0)) {
    throw new DockerEnvironmentError("DEV_CONTAINER_CONFIGURATION_UNSUPPORTED", `${configuration} selected Compose service volumes must be omitted; use workspaceMount for the worktree`);
  }
  const environment = composeEnvironment(app.environment, `${configuration} app`);
  const imageValid = typeof app.image === "string" && /^[A-Za-z0-9][A-Za-z0-9._/:@-]{0,254}$/.test(app.image) && !app.image.includes("${");
  let image: string;
  let build: DockerImageBuildRequest | undefined;
  if (app.build !== undefined) {
    if (app.image !== undefined || typeof app.build !== "object" || app.build === null || Array.isArray(app.build)) {
      throw new DockerEnvironmentError("DEV_CONTAINER_CONFIGURATION_INVALID", `${configuration} Compose app must specify either image or build, not both`);
    }
    const buildValue = app.build as Record<string, unknown>;
    if (Object.keys(buildValue).some((key) => key !== "context" && key !== "dockerfile") ||
        typeof buildValue.dockerfile !== "string" || (buildValue.context !== undefined && typeof buildValue.context !== "string")) {
      throw new DockerEnvironmentError("DEV_CONTAINER_CONFIGURATION_UNSUPPORTED", `${configuration} Compose app build supports only context and dockerfile`);
    }
    const composeDirectory = path.dirname(realComposePath);
    const contextValue = buildValue.context ?? ".";
    if (path.isAbsolute(contextValue) || contextValue.includes("\0")) throw new DockerEnvironmentError("DEV_CONTAINER_CONFIGURATION_INVALID", `${configuration} Compose build context must be relative`);
    let realGatewayContext: string;
    try { realGatewayContext = await realpath(path.resolve(composeDirectory, contextValue)); }
    catch (cause) { throw new DockerEnvironmentError("DEV_CONTAINER_CONFIGURATION_INVALID", `${configuration} Compose build context cannot be resolved`, { cause }); }
    if (!within(identity.worktreePath, realGatewayContext) || !(await lstat(realGatewayContext)).isDirectory()) {
      throw new DockerEnvironmentError("DEV_CONTAINER_CONFIGURATION_INVALID", `${configuration} Compose build context must be a directory inside the worktree`);
    }
    const dockerfileValue = buildValue.dockerfile;
    if (path.isAbsolute(dockerfileValue) || dockerfileValue.includes("\0")) throw new DockerEnvironmentError("DEV_CONTAINER_CONFIGURATION_INVALID", `${configuration} Compose Dockerfile path must be relative`);
    let realDockerfile: string;
    try { realDockerfile = await realpath(path.resolve(realGatewayContext, dockerfileValue)); }
    catch (cause) { throw new DockerEnvironmentError("DEV_CONTAINER_CONFIGURATION_INVALID", `${configuration} Compose Dockerfile cannot be resolved`, { cause }); }
    if (!within(realGatewayContext, realDockerfile) || !(await lstat(realDockerfile)).isFile()) {
      throw new DockerEnvironmentError("DEV_CONTAINER_CONFIGURATION_INVALID", `${configuration} Compose Dockerfile must be inside its build context`);
    }
    const hostWorktree = await mapGatewayPathToDockerHost(identity.worktreePath, identity.worktreePath, config);
    const hostContext = await realpath(path.resolve(hostWorktree, path.relative(identity.worktreePath, realGatewayContext)));
    const hostDockerfile = await realpath(path.resolve(hostWorktree, path.relative(identity.worktreePath, realDockerfile)));
    if (!within(hostWorktree, hostContext) || !within(hostContext, hostDockerfile)) {
      throw new DockerEnvironmentError("DEV_CONTAINER_CONFIGURATION_INVALID", `${configuration} Compose build does not map inside the Docker host worktree`);
    }
    image = typeof app.image === "string" ? app.image : `subpolar-devcontainer:${hash(`${identity.id}\0${configuration}\0${realDockerfile}\0${realGatewayContext}`).slice(0, 32)}`;
    build = { kind: "dockerfile", contextPath: hostContext, dockerfilePath: hostDockerfile, image };
  } else {
    if (!imageValid) throw new DockerEnvironmentError("DEV_CONTAINER_CONFIGURATION_INVALID", `${configuration} Compose app requires a literal image or build`);
    image = app.image as string;
  }
  const compose: ResolvedComposeConfiguration = {
    service,
    databaseService: database?.databaseService ?? "",
    databaseImage: database?.databaseImage ?? "",
    databaseEnvironment: database?.databaseEnvironment ?? {},
    networkName: `subpolar-net-${hash(identity.id).slice(0, 20)}`,
    databaseName: `${containerName(identity.id)}-db`,
    databaseVolumeName: `${containerName(identity.id)}-pgdata`,
  };
  void workspaceMountTarget;
  return { image, ...(build === undefined ? {} : { build }), environment, compose };
}

async function resolveDevContainerConfiguration(
  identity: EnvironmentIdentity,
  config: DockerEnvironmentConfig,
  containerStorageRoot: string,
): Promise<ResolvedDevContainerConfiguration> {
  const root = identity.worktreePath;
  const candidates: string[] = [];
  for (const relative of [".devcontainer.json", ".devcontainer/devcontainer.json"]) {
    try {
      if ((await lstat(path.join(root, relative))).isFile()) candidates.push(relative);
    } catch { /* Missing conventional config. */ }
  }
  try {
    const entries = await readdir(path.join(root, ".devcontainer"), { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const relative = path.posix.join(".devcontainer", entry.name, "devcontainer.json");
      try {
        if ((await lstat(path.join(root, relative))).isFile()) candidates.push(relative);
      } catch { /* This directory is not a configuration. */ }
    }
  } catch { /* No .devcontainer directory. */ }

  if (candidates.length === 0) return { image: config.image, containerEnvironment: {} };
  const selected = config.defaultDevContainerConfiguration
    ? candidates.find((candidate) => candidate === config.defaultDevContainerConfiguration)
    : candidates.length === 1 ? candidates[0] : undefined;
  if (!selected) {
    throw new DockerEnvironmentError(
      "DEV_CONTAINER_CONFIGURATION_SELECTION_REQUIRED",
      `Worktree has multiple Dev Container configurations; set defaultDevContainerConfiguration to one of: ${candidates.join(", ")}`,
    );
  }
  let realConfiguration: string;
  try {
    realConfiguration = await realpath(path.join(root, selected));
  } catch (cause) {
    throw new DockerEnvironmentError("DEV_CONTAINER_CONFIGURATION_INVALID", "Selected Dev Container configuration cannot be resolved", { cause });
  }
  if (!within(root, realConfiguration) || !(await lstat(realConfiguration)).isFile()) {
    throw new DockerEnvironmentError("DEV_CONTAINER_CONFIGURATION_INVALID", "Dev Container configuration must be a regular file inside the worktree");
  }

  let parsed: unknown;
  let source: string;
  try {
    source = await readFile(realConfiguration, "utf8");
    if (Buffer.byteLength(source) > 64 * 1024) throw new Error("Configuration exceeds 64 KiB");
    parsed = parseJsonc(source);
  } catch (cause) {
    throw new DockerEnvironmentError("DEV_CONTAINER_CONFIGURATION_INVALID", `Could not parse ${selected} as a Dev Container JSONC file`, { cause });
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new DockerEnvironmentError("DEV_CONTAINER_CONFIGURATION_INVALID", `${selected} must contain a JSON object`);
  }
  const value = parsed as Record<string, unknown>;
  const supportedOrChecked = [
    "$schema", "name", "image", "build", "containerEnv", "workspaceMount", "workspaceFolder",
    "postCreateCommand", "postStartCommand", "features", "dockerComposeFile", "service", "runServices",
    "overrideFeatureInstallOrder",
    "mounts", "forwardPorts", "appPort", "portsAttributes", "otherPortsAttributes", "privileged", "capAdd", "securityOpt", "runArgs",
  ];
  const unsupported = Object.keys(value).filter((key) => !supportedOrChecked.includes(key));
  if (unsupported.length > 0) {
    throw new DockerEnvironmentError(
      "DEV_CONTAINER_CONFIGURATION_UNSUPPORTED",
      `${selected} uses unsupported Dev Container options: ${unsupported.join(", ")}`,
    );
  }
  if (value.features !== undefined && (typeof value.features !== "object" || value.features === null || Array.isArray(value.features))) {
    throw new DockerEnvironmentError("DEV_CONTAINER_CONFIGURATION_INVALID", `${selected} features must be an object`);
  }
  if (value.image !== undefined && (typeof value.image !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._/:@-]{0,254}$/.test(value.image))) {
    throw new DockerEnvironmentError("DEV_CONTAINER_CONFIGURATION_INVALID", `${selected} must specify a literal Docker image reference`);
  }
  const workspaceMountTarget = workspaceMount(value.workspaceMount, selected, containerStorageRoot);
  const workspaceDirectory = workspaceFolder(
    value.workspaceFolder,
    selected,
    workspaceMountTarget ?? worktreeContainerPath(identity, containerStorageRoot),
  );
  const containerEnvironment: Record<string, string> = {};
  const postCreateCommand = lifecycleCommand(value.postCreateCommand, "postCreateCommand", selected);
  const postStartCommand = lifecycleCommand(value.postStartCommand, "postStartCommand", selected);
  if (value.containerEnv !== undefined) {
    if (typeof value.containerEnv !== "object" || value.containerEnv === null || Array.isArray(value.containerEnv)) {
      throw new DockerEnvironmentError("DEV_CONTAINER_CONFIGURATION_INVALID", `${selected} containerEnv must be an object of literal strings`);
    }
    for (const [key, entry] of Object.entries(value.containerEnv)) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || key === "HOME" || key === "TMPDIR" || key === "SUBPOLAR_RUNTIME_DATA_DIR" ||
          typeof entry !== "string" || entry.includes("\0") || entry.includes("${") || Buffer.byteLength(entry) > 8192) {
        throw new DockerEnvironmentError("DEV_CONTAINER_CONFIGURATION_INVALID", `${selected} containerEnv contains an invalid or unsupported entry: ${key}`);
      }
      containerEnvironment[key] = entry;
    }
  }
  const featureEntries = typeof value.features === "object" && value.features !== null
    ? Object.entries(value.features as Record<string, unknown>)
    : [];
  if (featureEntries.length > 32) {
    throw new DockerEnvironmentError("DEV_CONTAINER_CONFIGURATION_INVALID", `${selected} may request no more than 32 Dev Container Features`);
  }
  if (value.overrideFeatureInstallOrder !== undefined &&
      (!Array.isArray(value.overrideFeatureInstallOrder) || value.overrideFeatureInstallOrder.length > featureEntries.length ||
       !value.overrideFeatureInstallOrder.every((feature) => typeof feature === "string" && featureEntries.some(([id]) => id === feature)) ||
       new Set(value.overrideFeatureInstallOrder).size !== value.overrideFeatureInstallOrder.length)) {
    throw new DockerEnvironmentError("DEV_CONTAINER_CONFIGURATION_INVALID", `${selected} overrideFeatureInstallOrder must contain unique requested Feature references`);
  }
  const composeRequested = value.dockerComposeFile !== undefined || value.service !== undefined || value.runServices !== undefined;
  if (composeRequested && config.allowDevContainerCompose !== true) {
    throw new DockerEnvironmentError("DEV_CONTAINER_CONFIGURATION_UNSUPPORTED", "Dev Container Compose is disabled by the manager; set SUBPOLAR_ENABLE_DEVCONTAINER_COMPOSE=true to enable it");
  }
  const guardedRuntimeOptions = ["mounts", "forwardPorts", "appPort", "portsAttributes", "otherPortsAttributes", "privileged", "capAdd", "securityOpt", "runArgs"]
    .filter((key) => value[key] !== undefined);
  if (featureEntries.length > 0 && composeRequested) {
    throw new DockerEnvironmentError("DEV_CONTAINER_CONFIGURATION_UNSUPPORTED", `${selected} cannot combine Features with a Compose environment`);
  }
  if (featureEntries.length > 0 && guardedRuntimeOptions.length > 0) {
    throw new DockerEnvironmentError("DEV_CONTAINER_CONFIGURATION_UNSUPPORTED", `${selected} uses Dev Container options not supported by the isolated worker backend: ${guardedRuntimeOptions.join(", ")}`);
  }
  const allowedFeatures = new Set(config.allowedDevContainerFeatures ?? []);
  const localFeatureDigests: string[] = [];
  let buildSource = "";
  for (const [feature, options] of featureEntries) {
    const localFeature = feature.startsWith("./") || feature.startsWith("../");
    const validFeatureReference = localFeature
      ? !feature.includes("\\") && !feature.includes("\0") && Buffer.byteLength(feature) <= 512
      : /^(?:[a-z0-9][a-z0-9.-]*(?::[0-9]+)?\/)+[a-z0-9][a-z0-9._/-]*(?::[A-Za-z0-9_][A-Za-z0-9_.-]{0,127})?(?:@sha256:[a-f0-9]{64})?$/.test(feature);
    if (!validFeatureReference || !feature || Buffer.byteLength(feature) > 512 || feature.includes("..")) {
      throw new DockerEnvironmentError("DEV_CONTAINER_CONFIGURATION_INVALID", `${selected} contains an invalid Dev Container Feature reference`);
    }
    if (typeof options !== "object" || options === null || Array.isArray(options)) {
      throw new DockerEnvironmentError("DEV_CONTAINER_CONFIGURATION_INVALID", `${selected} Feature options must be objects`);
    }
    if (!allowedFeatures.has(feature)) {
      throw new DockerEnvironmentError(
        "DEV_CONTAINER_CONFIGURATION_UNSUPPORTED",
        `${selected} requests Feature ${feature}, which is not authorized by the manager's allowedDevContainerFeatures policy`,
      );
    }
    if (localFeature) {
      const gatewayFeaturePath = path.resolve(path.dirname(realConfiguration), feature);
      let realGatewayFeaturePath: string;
      try {
        realGatewayFeaturePath = await realpath(gatewayFeaturePath);
      } catch (cause) {
        throw new DockerEnvironmentError("DEV_CONTAINER_CONFIGURATION_INVALID", `${selected} local Feature does not exist: ${feature}`, { cause });
      }
      if (!within(root, realGatewayFeaturePath) || !(await lstat(realGatewayFeaturePath)).isDirectory()) {
        throw new DockerEnvironmentError("DEV_CONTAINER_CONFIGURATION_INVALID", `${selected} local Features must be directories inside the worktree`);
      }
      localFeatureDigests.push(await hashLocalFeatureDirectory(realGatewayFeaturePath, selected));
    }
  }
  if (featureEntries.length > 0) {
    if (value.image !== undefined && value.build !== undefined) {
      throw new DockerEnvironmentError("DEV_CONTAINER_CONFIGURATION_INVALID", `${selected} must specify either image or build, not both`);
    }
    if (value.build !== undefined) {
      if (typeof value.build !== "object" || value.build === null || Array.isArray(value.build)) {
        throw new DockerEnvironmentError("DEV_CONTAINER_CONFIGURATION_INVALID", `${selected} build must be an object`);
      }
      const build = value.build as Record<string, unknown>;
      const unsupportedBuildOptions = Object.keys(build).filter((key) => key !== "dockerfile" && key !== "context");
      if (unsupportedBuildOptions.length > 0 || typeof build.dockerfile !== "string" ||
          (build.context !== undefined && typeof build.context !== "string")) {
        throw new DockerEnvironmentError("DEV_CONTAINER_CONFIGURATION_UNSUPPORTED", `${selected} uses unsupported or invalid build options${unsupportedBuildOptions.length ? `: ${unsupportedBuildOptions.join(", ")}` : ""}`);
      }
      const configurationDirectory = path.dirname(realConfiguration);
      const contextValue = build.context ?? ".";
      if (path.isAbsolute(contextValue) || contextValue.includes("\0") || path.isAbsolute(build.dockerfile) || build.dockerfile.includes("\0")) {
        throw new DockerEnvironmentError("DEV_CONTAINER_CONFIGURATION_INVALID", `${selected} build paths must be relative`);
      }
      let realBuildContext: string;
      let realDockerfile: string;
      try {
        realBuildContext = await realpath(path.resolve(configurationDirectory, contextValue));
        realDockerfile = await realpath(path.resolve(configurationDirectory, build.dockerfile));
      } catch (cause) {
        throw new DockerEnvironmentError("DEV_CONTAINER_CONFIGURATION_INVALID", `${selected} build context or Dockerfile does not exist`, { cause });
      }
      if (!within(root, realBuildContext) || !(await lstat(realBuildContext)).isDirectory() ||
          !within(realBuildContext, realDockerfile) || !(await lstat(realDockerfile)).isFile()) {
        throw new DockerEnvironmentError("DEV_CONTAINER_CONFIGURATION_INVALID", `${selected} Dockerfile must be a file inside a build context contained by the worktree`);
      }
      const dockerfileStat = await lstat(realDockerfile);
      if (dockerfileStat.size > 1024 * 1024) {
        throw new DockerEnvironmentError("DEV_CONTAINER_CONFIGURATION_INVALID", `${selected} Dockerfile exceeds the 1 MiB supported size`);
      }
      buildSource = await readFile(realDockerfile, "utf8");
    }
    const lockfilePath = path.join(root, ".devcontainer-lock.json");
    let lockfile: string;
    try {
      const lockfileStat = await lstat(lockfilePath);
      if (!lockfileStat.isFile() || lockfileStat.isSymbolicLink() || lockfileStat.size > 1024 * 1024) throw new Error("Invalid Dev Container Feature lockfile");
      lockfile = await readFile(lockfilePath, "utf8");
      const lockfileValue = JSON.parse(lockfile) as unknown;
      if (typeof lockfileValue !== "object" || lockfileValue === null || Array.isArray(lockfileValue)) throw new Error("Invalid Dev Container Feature lockfile");
    } catch (cause) {
      throw new DockerEnvironmentError(
        "DEV_CONTAINER_CONFIGURATION_INVALID",
        `${selected} requests Features and requires a valid root .devcontainer-lock.json for reproducible builds`,
        { cause },
      );
    }
    const hostWorktree = await mapGatewayPathToDockerHost(root, root, config);
    const hostConfigurationPath = path.resolve(hostWorktree, path.relative(root, realConfiguration));
    const image = `subpolar-devcontainer:${hash(`${identity.id}\0${selected}\0${source}\0${lockfile}\0${buildSource}\0${localFeatureDigests.join("\0")}`).slice(0, 32)}`;
    const featureBuild: DockerImageBuildRequest = {
      kind: "devcontainer",
      workspaceFolder: hostWorktree,
      configurationPath: hostConfigurationPath,
      image,
    };
    return {
      image,
      build: featureBuild,
      containerEnvironment,
      ...(workspaceMountTarget === undefined ? {} : { workspaceMountTarget }),
      ...(workspaceDirectory === undefined ? {} : { workspaceFolder: workspaceDirectory }),
      ...(postCreateCommand === undefined ? {} : { postCreateCommand }),
      ...(postStartCommand === undefined ? {} : { postStartCommand }),
    };
  }
  if (composeRequested && (value.dockerComposeFile === undefined || value.service === undefined || value.image !== undefined || value.build !== undefined)) {
    throw new DockerEnvironmentError("DEV_CONTAINER_CONFIGURATION_INVALID", `${selected} Compose configuration requires dockerComposeFile and service and cannot also specify image or build`);
  }
  const unsupportedRuntimeOptions = ["mounts", "forwardPorts", "appPort", "portsAttributes", "otherPortsAttributes", "privileged", "capAdd", "securityOpt", "runArgs"]
    .filter((key) => value[key] !== undefined);
  if (unsupportedRuntimeOptions.length > 0) {
    throw new DockerEnvironmentError(
      "DEV_CONTAINER_CONFIGURATION_UNSUPPORTED",
      `${selected} uses Dev Container options not supported by the isolated worker backend: ${unsupportedRuntimeOptions.join(", ")}`,
    );
  }
  const composeResolved = composeRequested
    ? await resolveComposeConfiguration(identity, config, realConfiguration, value, workspaceMountTarget)
    : undefined;
  if (composeResolved) return {
    image: composeResolved.image,
    ...(composeResolved.build === undefined ? {} : { build: composeResolved.build }),
    containerEnvironment: { ...composeResolved.environment, ...containerEnvironment },
    compose: composeResolved.compose,
    ...(workspaceMountTarget === undefined ? {} : { workspaceMountTarget }),
    ...(workspaceDirectory === undefined ? {} : { workspaceFolder: workspaceDirectory }),
    ...(postCreateCommand === undefined ? {} : { postCreateCommand }),
    ...(postStartCommand === undefined ? {} : { postStartCommand }),
  };
  if (value.build === undefined) return {
    image: typeof value.image === "string" ? value.image : config.image,
    containerEnvironment,
    ...(workspaceMountTarget === undefined ? {} : { workspaceMountTarget }),
    ...(workspaceDirectory === undefined ? {} : { workspaceFolder: workspaceDirectory }),
    ...(postCreateCommand === undefined ? {} : { postCreateCommand }),
    ...(postStartCommand === undefined ? {} : { postStartCommand }),
  };
  if (value.image !== undefined || typeof value.build !== "object" || value.build === null || Array.isArray(value.build)) {
    throw new DockerEnvironmentError("DEV_CONTAINER_CONFIGURATION_INVALID", `${selected} must specify either image or build, not both`);
  }
  const build = value.build as Record<string, unknown>;
  const unsupportedBuildOptions = Object.keys(build).filter((key) => key !== "dockerfile" && key !== "context");
  if (unsupportedBuildOptions.length > 0 || typeof build.dockerfile !== "string" ||
      (build.context !== undefined && typeof build.context !== "string")) {
    throw new DockerEnvironmentError(
      "DEV_CONTAINER_CONFIGURATION_UNSUPPORTED",
      `${selected} uses unsupported or invalid build options${unsupportedBuildOptions.length ? `: ${unsupportedBuildOptions.join(", ")}` : ""}`,
    );
  }
  const configurationDirectory = path.dirname(realConfiguration);
  const hostWorktree = await mapGatewayPathToDockerHost(root, root, config);
  const hostConfigurationDirectory = path.resolve(hostWorktree, path.relative(root, configurationDirectory));
  const contextValue = build.context ?? ".";
  if (path.isAbsolute(contextValue) || contextValue.includes("\0")) {
    throw new DockerEnvironmentError("DEV_CONTAINER_CONFIGURATION_INVALID", `${selected} build context must be a relative path`);
  }
  const gatewayContext = path.resolve(configurationDirectory, contextValue);
  let realGatewayContext: string;
  try {
    realGatewayContext = await realpath(gatewayContext);
  } catch (cause) {
    throw new DockerEnvironmentError("DEV_CONTAINER_CONFIGURATION_INVALID", `${selected} build context does not exist`, { cause });
  }
  if (!within(root, realGatewayContext) || !(await lstat(realGatewayContext)).isDirectory()) {
    throw new DockerEnvironmentError("DEV_CONTAINER_CONFIGURATION_INVALID", `${selected} build context must be a directory inside the worktree`);
  }
  const contextRelativeToConfiguration = path.relative(configurationDirectory, realGatewayContext);
  const hostContext = await realpath(path.resolve(hostConfigurationDirectory, contextRelativeToConfiguration));
  if (!within(hostWorktree, hostContext)) {
    throw new DockerEnvironmentError("DEV_CONTAINER_CONFIGURATION_INVALID", `${selected} build context resolves outside the Docker host worktree`);
  }
  const gatewayDockerfile = path.resolve(configurationDirectory, build.dockerfile);
  let realGatewayDockerfile: string;
  try {
    realGatewayDockerfile = await realpath(gatewayDockerfile);
  } catch (cause) {
    throw new DockerEnvironmentError("DEV_CONTAINER_CONFIGURATION_INVALID", `${selected} Dockerfile does not exist`, { cause });
  }
  if (!within(realGatewayContext, realGatewayDockerfile) || !(await lstat(realGatewayDockerfile)).isFile()) {
    throw new DockerEnvironmentError("DEV_CONTAINER_CONFIGURATION_INVALID", `${selected} Dockerfile must be a file inside its build context`);
  }
  const dockerfileRelativeToConfiguration = path.relative(configurationDirectory, realGatewayDockerfile);
  const dockerfilePath = await realpath(path.resolve(hostConfigurationDirectory, dockerfileRelativeToConfiguration));
  if (!within(hostContext, dockerfilePath)) {
    throw new DockerEnvironmentError("DEV_CONTAINER_CONFIGURATION_INVALID", `${selected} Dockerfile resolves outside the Docker host build context`);
  }
  const image = `subpolar-devcontainer:${hash(`${identity.id}\0${selected}\0${realGatewayDockerfile}\0${realGatewayContext}`).slice(0, 32)}`;
  return {
    image, build: { kind: "dockerfile", contextPath: hostContext, dockerfilePath, image }, containerEnvironment,
    ...(workspaceMountTarget === undefined ? {} : { workspaceMountTarget }),
    ...(workspaceDirectory === undefined ? {} : { workspaceFolder: workspaceDirectory }),
    ...(postCreateCommand === undefined ? {} : { postCreateCommand }),
    ...(postStartCommand === undefined ? {} : { postStartCommand }),
  };
}

async function mapGatewayPathToDockerHost(
  gatewayWorktree: string,
  gatewayPath: string,
  config: DockerEnvironmentConfig,
): Promise<string> {
  const [gatewayRoot, hostRoot, realWorktree, realPath] = await Promise.all([
    realpath(config.gatewayStorageRoot),
    realpath(config.hostStorageRoot),
    realpath(gatewayWorktree),
    realpath(gatewayPath),
  ]);
  if (!within(gatewayRoot, realWorktree) || !within(realWorktree, realPath)) {
    throw new DockerEnvironmentError("DEV_CONTAINER_CONFIGURATION_INVALID", "Dev Container build paths must resolve inside the worktree");
  }
  const relativeWorktree = path.relative(gatewayRoot, realWorktree);
  if (!relativeWorktree || relativeWorktree === ".." || relativeWorktree.startsWith(`..${path.sep}`) || path.isAbsolute(relativeWorktree)) {
    throw new DockerEnvironmentError("DEV_CONTAINER_CONFIGURATION_INVALID", "Dev Container worktree cannot be mapped to the configured Docker host root");
  }
  const hostWorktree = await realpath(path.resolve(hostRoot, relativeWorktree));
  if (!within(hostRoot, hostWorktree)) {
    throw new DockerEnvironmentError("DEV_CONTAINER_CONFIGURATION_INVALID", "Dev Container worktree resolves outside the Docker host workspace root");
  }
  const relativePath = path.relative(realWorktree, realPath);
  const hostPath = await realpath(path.resolve(hostWorktree, relativePath));
  if (!within(hostWorktree, hostPath)) {
    throw new DockerEnvironmentError("DEV_CONTAINER_CONFIGURATION_INVALID", "Dev Container build path resolves outside the Docker host worktree");
  }
  return hostPath;
}

function sameRecord(left: Readonly<Record<string, string>>, right: Readonly<Record<string, string>>): boolean {
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return leftKeys.length === rightKeys.length && leftKeys.every((key, index) => key === rightKeys[index] && left[key] === right[key]);
}

function containsRecord(actual: Readonly<Record<string, string>>, expected: Readonly<Record<string, string>>): boolean {
  return Object.entries(expected).every(([key, value]) => actual[key] === value);
}

function within(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function lifecycleArgv(command: DevContainerLifecycleCommand): readonly string[] {
  return command.kind === "shell" ? ["/bin/sh", "-c", command.value] : command.value;
}

function postCreateArgv(command: DevContainerLifecycleCommand, containerId: string): readonly string[] {
  const generation = hash(`${containerId}\0${JSON.stringify(command)}`);
  const marker = `/var/lib/subpolar/lifecycle/post-create-${generation}.done`;
  const lock = `/tmp/subpolar-post-create-${generation}.lock`;
  const script = [
    'marker="$1"; lock="$2"; shift 2',
    'if [ -f "$marker" ]; then exit 0; fi',
    'mkdir -p "${marker%/*}" || exit 125',
    'attempt=0',
    'while ! mkdir "$lock" 2>/dev/null; do',
    '  [ -f "$marker" ] && exit 0',
    '  attempt=$((attempt + 1)); [ "$attempt" -lt 100 ] || exit 125',
    '  sleep 0.1',
    'done',
    'trap \'rmdir "$lock" 2>/dev/null || true\' EXIT HUP INT TERM',
    '[ -f "$marker" ] && exit 0',
    '"$@"; result=$?',
    '[ "$result" -eq 0 ] || exit "$result"',
    ': > "$marker"',
  ].join("\n");
  return ["/bin/sh", "-c", script, "subpolar-post-create", marker, lock, ...lifecycleArgv(command)];
}

function containerName(environmentId: string): string {
  return `subpolar-${environmentId.replace(/[^a-zA-Z0-9_.-]/g, "-")}`;
}

function dataVolumeName(environmentId: string): string {
  return `${containerName(environmentId)}-data`;
}

function containerPath(root: string, relative: string): string {
  const resolved = path.posix.resolve(root, relative.split(path.sep).join(path.posix.sep));
  if (resolved !== root && !resolved.startsWith(`${root.replace(/\/$/, "")}/`)) {
    throw new DockerEnvironmentError("WORKTREE_MAPPING_INVALID", "Mapped container worktree escapes its configured root");
  }
  return resolved;
}

function worktreeContainerPath(identity: EnvironmentIdentity, containerStorageRoot: string, workspaceMountTarget?: string): string {
  const relative = path.relative(identity.storageRoot, identity.worktreePath);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new DockerEnvironmentError("WORKTREE_MAPPING_INVALID", "Environment worktree cannot be mapped inside the container");
  }
  return workspaceMountTarget ?? containerPath(containerStorageRoot, relative);
}

function status(state: DockerContainerState): EnvironmentStatus {
  switch (state) {
    case "running": return "ready";
    case "created":
    case "exited": return "stopped";
    case "paused":
    case "restarting":
    case "dead": return "failed";
  }
}

function validateLimits(config: DockerEnvironmentConfig): Required<Pick<DockerEnvironmentConfig, "memoryBytes" | "nanoCpus" | "pidsLimit">> {
  const limits = {
    memoryBytes: config.memoryBytes ?? DOCKER_RESOURCE_DEFAULTS.memoryBytes,
    nanoCpus: config.nanoCpus ?? DOCKER_RESOURCE_DEFAULTS.nanoCpus,
    pidsLimit: config.pidsLimit ?? DOCKER_RESOURCE_DEFAULTS.pidsLimit,
  };
  if (!Number.isSafeInteger(limits.memoryBytes) || limits.memoryBytes < 64 * 1024 * 1024 || limits.memoryBytes > 16 * 1024 ** 3 ||
      !Number.isSafeInteger(limits.nanoCpus) || limits.nanoCpus < 100_000_000 || limits.nanoCpus > 16_000_000_000 ||
      !Number.isSafeInteger(limits.pidsLimit) || limits.pidsLimit < 16 || limits.pidsLimit > 4096) {
    throw new DockerEnvironmentError("INVALID_DOCKER_CONFIG", "Docker resource limits must be positive bounded integers");
  }
  return limits;
}

/**
 * Creates a Docker backend around an injected, restricted client contract.
 * A linked worktree gets a second bind mount for its canonical common Git
 * directory, but only when that directory is within a separately configured
 * gateway/host root pair. The mount target preserves Git's absolute gitdir
 * pointer, and no parent repository directory is mounted.
 */
export function createDockerEnvironmentBackend(
  client: DockerClient,
  config: DockerEnvironmentConfig,
): EnvironmentProcessBackend {
  if (!config.image.trim()) throw new DockerEnvironmentError("INVALID_DOCKER_CONFIG", "A Docker image is required");
  if (Boolean(config.gatewayGitRoot) !== Boolean(config.hostGitRoot)) {
    throw new DockerEnvironmentError("INVALID_DOCKER_CONFIG", "Gateway and Docker-host Git metadata roots must be configured together");
  }
  if (config.gatewayGitRoot && (!path.isAbsolute(config.gatewayGitRoot) || !path.isAbsolute(config.hostGitRoot!))) {
    throw new DockerEnvironmentError("INVALID_DOCKER_CONFIG", "Gateway and Docker-host Git metadata roots must be absolute paths");
  }
  if (config.egress !== undefined) {
    throw new DockerEnvironmentError(
      "EGRESS_UNAVAILABLE",
      "Provider egress is disabled: Docker internal networks can still reach host services, and this manager has no Docker-host firewall enforcement.",
    );
  }
  if (!path.isAbsolute(config.gatewayStorageRoot) || !path.isAbsolute(config.hostStorageRoot) || !path.posix.isAbsolute(config.containerStorageRoot)) {
    throw new DockerEnvironmentError("INVALID_DOCKER_CONFIG", "Gateway, host, and container storage roots must be absolute");
  }
  const containerStorageRoot = path.posix.resolve(config.containerStorageRoot);
  if (containerStorageRoot === "/") {
    throw new DockerEnvironmentError("INVALID_DOCKER_CONFIG", "Container storage root must be a dedicated subdirectory");
  }
  const limits = validateLimits(config);
  const backendId = "docker-manager-v1";

  const resolveMounts = async (identity: EnvironmentIdentity, workspaceMountTarget?: string): Promise<readonly DockerBindMount[]> => {
    let gatewayRoot: string;
    let gatewayWorktree: string;
    let hostRoot: string;
    try {
      [gatewayRoot, gatewayWorktree, hostRoot] = await Promise.all([
        realpath(config.gatewayStorageRoot),
        realpath(identity.worktreePath),
        realpath(config.hostStorageRoot),
      ]);
    } catch (cause) {
      throw new DockerEnvironmentError("WORKSPACE_MAPPING_INVALID", "Configured workspace roots and gateway worktree must exist", { cause });
    }
    if (gatewayRoot === "/" || hostRoot === "/") {
      throw new DockerEnvironmentError("INVALID_DOCKER_CONFIG", "Workspace storage roots must be dedicated directories, not filesystem roots");
    }
    if (identity.storageRoot !== gatewayRoot || !within(gatewayRoot, gatewayWorktree)) {
      throw new DockerEnvironmentError("WORKSPACE_MAPPING_INVALID", "Environment identity is outside the configured gateway storage root");
    }

    const relative = path.relative(gatewayRoot, gatewayWorktree);
    const expectedHostPath = path.resolve(hostRoot, relative);
    if (!within(hostRoot, expectedHostPath)) {
      throw new DockerEnvironmentError("WORKTREE_MAPPING_INVALID", "Mapped host worktree escapes the configured host storage root");
    }
    let hostWorktree: string;
    try {
      hostWorktree = await realpath(expectedHostPath);
    } catch (cause) {
      throw new DockerEnvironmentError("WORKTREE_MAPPING_INVALID", "Mapped host worktree does not exist on the Docker host", { cause });
    }
    if (!within(hostRoot, hostWorktree) || !(await lstat(hostWorktree)).isDirectory()) {
      throw new DockerEnvironmentError("WORKTREE_MAPPING_INVALID", "Mapped host worktree resolves outside the configured host storage root");
    }

    const gatewayGitPath = path.join(gatewayWorktree, ".git");
    const hostGitPath = path.join(hostWorktree, ".git");
    let gitMetadataMount: DockerBindMount | undefined;
    try {
      const [gatewayGitStat, hostGitStat] = await Promise.all([lstat(gatewayGitPath), lstat(hostGitPath)]);
      if (gatewayGitStat.isDirectory() && hostGitStat.isDirectory()) {
        const [gatewayGitReal, hostGitReal] = await Promise.all([realpath(gatewayGitPath), realpath(hostGitPath)]);
        if (!within(gatewayWorktree, gatewayGitReal) || !within(hostWorktree, hostGitReal)) {
          throw new DockerEnvironmentError("UNSUPPORTED_GIT_LAYOUT", ".git metadata resolves outside the worktree");
        }
      } else if (gatewayGitStat.isFile() && hostGitStat.isFile()) {
        if (!config.gatewayGitRoot || !config.hostGitRoot) {
          throw new DockerEnvironmentError("UNSUPPORTED_GIT_LAYOUT", "Linked worktrees require explicit gateway and Docker-host Git metadata roots");
        }
        const [gatewayRoot, hostGitRoot] = await Promise.all([
          realpath(config.gatewayGitRoot),
          realpath(config.hostGitRoot),
        ]);
        if (gatewayRoot === "/" || hostGitRoot === "/" ||
            !(await lstat(gatewayRoot)).isDirectory() || !(await lstat(hostGitRoot)).isDirectory()) {
          throw new DockerEnvironmentError("GIT_METADATA_MAPPING_INVALID", "Git metadata roots must be dedicated directories");
        }
        const [gatewayPointer, hostPointer] = await Promise.all([
          readFile(gatewayGitPath, "utf8"),
          readFile(hostGitPath, "utf8"),
        ]);
        const parseGitDir = (pointer: string, worktree: string): string => {
          const match = /^gitdir:\s*(.+)\s*$/m.exec(pointer);
          if (!match?.[1]) throw new DockerEnvironmentError("UNSUPPORTED_GIT_LAYOUT", "Linked worktree has an invalid .git pointer");
          return path.resolve(worktree, match[1]);
        };
        const gatewayGitDir = await realpath(parseGitDir(gatewayPointer, gatewayWorktree));
        const hostGitDir = await realpath(parseGitDir(hostPointer, hostWorktree));
        if (!within(gatewayRoot, gatewayGitDir) || !within(hostGitRoot, hostGitDir) ||
            !(await lstat(gatewayGitDir)).isDirectory() || !(await lstat(hostGitDir)).isDirectory()) {
          throw new DockerEnvironmentError("GIT_METADATA_MAPPING_INVALID", "Linked worktree metadata is outside the configured Git roots");
        }
        const gitDirRelative = path.relative(gatewayRoot, gatewayGitDir);
        const expectedHostGitDir = path.resolve(hostGitRoot, gitDirRelative);
        if (await realpath(expectedHostGitDir) !== hostGitDir) {
          throw new DockerEnvironmentError("GIT_METADATA_MAPPING_INVALID", "Gateway and Docker-host linked Git metadata do not map to the same relative path");
        }
        const [gatewayCommonPointer, hostCommonPointer] = await Promise.all([
          readFile(path.join(gatewayGitDir, "commondir"), "utf8"),
          readFile(path.join(hostGitDir, "commondir"), "utf8"),
        ]);
        const gatewayCommonPath = path.resolve(gatewayGitDir, gatewayCommonPointer.trim());
        const hostCommonPath = path.resolve(hostGitDir, hostCommonPointer.trim());
        const [gatewayCommonDir, hostCommonDir] = await Promise.all([
          realpath(gatewayCommonPath),
          realpath(hostCommonPath),
        ]);
        if (!within(gatewayRoot, gatewayCommonDir) || !within(hostGitRoot, hostCommonDir) ||
            !(await lstat(gatewayCommonDir)).isDirectory() || !(await lstat(hostCommonDir)).isDirectory()) {
          throw new DockerEnvironmentError("GIT_METADATA_MAPPING_INVALID", "Shared Git metadata is outside the configured Git roots");
        }
        const commonRelative = path.relative(gatewayRoot, gatewayCommonDir);
        const expectedHostCommonDir = path.resolve(hostGitRoot, commonRelative);
        if (await realpath(expectedHostCommonDir) !== hostCommonDir || gatewayCommonPath !== gatewayCommonDir) {
          throw new DockerEnvironmentError("GIT_METADATA_MAPPING_INVALID", "Gateway and Docker-host common Git directories do not map canonically");
        }
        gitMetadataMount = {
          type: "bind",
          source: hostCommonDir,
          // Preserve the absolute path referenced by the worktree's .git file.
          target: gatewayCommonDir,
          readOnly: false,
        };
      } else {
        throw new DockerEnvironmentError("UNSUPPORTED_GIT_LAYOUT", "Gateway and Docker-host worktrees must use matching .git layouts");
      }
    } catch (cause) {
      if (cause instanceof DockerEnvironmentError) throw cause;
      throw new DockerEnvironmentError("UNSUPPORTED_GIT_LAYOUT", "The worktree Git metadata could not be resolved safely", { cause });
    }

    if (workspaceMountTarget && gitMetadataMount) {
      throw new DockerEnvironmentError(
        "DEV_CONTAINER_CONFIGURATION_UNSUPPORTED",
        "A custom workspaceMount cannot be used with a linked Git worktree because the worktree Git pointer is tied to its default container path",
      );
    }
    const target = workspaceMountTarget ?? containerPath(containerStorageRoot, relative);
    return [
      { type: "bind", source: hostWorktree, target, readOnly: false },
      ...(gitMetadataMount ? [gitMetadataMount] : []),
    ];
  };

  const labelsFor = (identity: EnvironmentIdentity): Readonly<Record<string, string>> => ({
    [MANAGED_BY]: "subpolar",
    [ID_LABEL]: identity.id,
    [OWNER_LABEL]: hash(identity.ownerId),
    [WORKSPACE_LABEL]: hash(identity.workspaceId),
    [WORKTREE_LABEL]: hash(identity.worktreePath),
  });

  const createOptions = async (identity: EnvironmentIdentity, resolved: ResolvedDevContainerConfiguration): Promise<DockerContainerCreateOptions> => ({
    name: containerName(identity.id),
    image: resolved.image,
    labels: labelsFor(identity),
    user: "1000:1000",
    privileged: false,
    readOnlyRootfs: true,
    // The single-container path has no network. Compose uses its private,
    // manager-created internal network for the selected app and database only.
    networkMode: resolved.compose?.networkName ?? "none",
    ...(resolved.compose === undefined ? {} : { networkAliases: [resolved.compose.service] }),
    capDrop: ["ALL"],
    securityOpt: ["no-new-privileges:true"],
    ...limits,
    mounts: [
      ...(await resolveMounts(identity, resolved.workspaceMountTarget)),
      { type: "volume", source: dataVolumeName(identity.id), target: "/var/lib/subpolar", readOnly: false },
    ],
    tmpfs: TMPFS,
    environment: { ...ENVIRONMENT, ...resolved.containerEnvironment },
  });

  const composeLabelsFor = (identity: EnvironmentIdentity, purpose: string): Readonly<Record<string, string>> => ({
    ...labelsFor(identity),
    "io.subpolar.resource-purpose": purpose,
  });

  const composeDatabaseOptions = (identity: EnvironmentIdentity, resolved: ResolvedDevContainerConfiguration): DockerContainerCreateOptions => {
    const compose = resolved.compose;
    if (!compose || !compose.databaseService) throw new DockerEnvironmentError("DEV_CONTAINER_CONFIGURATION_INVALID", "Compose PostgreSQL service is missing");
    return {
      name: compose.databaseName,
      image: compose.databaseImage,
      labels: composeLabelsFor(identity, "compose-postgres"),
      user: "999:999",
      privileged: false,
      readOnlyRootfs: true,
      networkMode: compose.networkName,
      networkAliases: [compose.databaseService],
      capDrop: ["ALL"],
      securityOpt: ["no-new-privileges:true"],
      ...limits,
      mounts: [{ type: "volume", source: compose.databaseVolumeName, target: "/var/lib/postgresql/data", readOnly: false }],
      tmpfs: {
        "/tmp": "rw,nosuid,nodev,size=64m",
        "/run": "rw,nosuid,nodev,size=16m",
        "/var/run/postgresql": "rw,nosuid,nodev,size=16m,uid=999,gid=999",
      },
      environment: compose.databaseEnvironment,
      healthcheck: { test: ["CMD", "pg_isready"], intervalMs: 1000, timeoutMs: 3000, retries: 60, startPeriodMs: 1000 },
    };
  };

  const verifyComposeNetwork = async (
    identity: EnvironmentIdentity,
    compose: ResolvedComposeConfiguration,
    expectedContainers?: ReadonlyArray<{ readonly inspection: DockerContainerInspection; readonly alias: string }>,
  ): Promise<DockerNetworkInspection> => {
    if (!client.inspectNetwork) throw new DockerEnvironmentError("DEV_CONTAINER_CONFIGURATION_UNSUPPORTED", "Docker client does not support isolated Compose networks");
    const network = await client.inspectNetwork(compose.networkName);
    const expectedLabels = composeLabelsFor(identity, "compose-network");
    if (!network || network.name !== compose.networkName || network.driver !== "bridge" || !network.internal ||
        !sameRecord(Object.fromEntries(Object.entries(network.labels).filter((entry): entry is [string, string] => typeof entry[1] === "string")), expectedLabels) ||
        expectedContainers?.some(({ inspection, alias }) => !inspection.config.networkAliases?.[compose.networkName]?.includes(alias))) {
      throw new DockerEnvironmentError("DOCKER_IDENTITY_MISMATCH", "Compose network is missing or does not match the managed internal network");
    }
    return network;
  };

  const verifyComposeDatabase = async (identity: EnvironmentIdentity, resolved: ResolvedDevContainerConfiguration): Promise<DockerContainerInspection | null> => {
    const compose = resolved.compose;
    if (!compose?.databaseService) return null;
    const inspection = await client.inspectContainer(compose.databaseName);
    if (!inspection) return null;
    const expectedLabels = composeLabelsFor(identity, "compose-postgres");
    const expectedOptions = composeDatabaseOptions(identity, resolved);
    const observed = inspection.config;
    const labelsMatch = sameRecord(Object.fromEntries(Object.entries(inspection.labels).filter((entry): entry is [string, string] => typeof entry[1] === "string")), expectedLabels);
    const mountsMatch = observed.mounts.length === 1 && observed.mounts[0]?.type === "volume" &&
      observed.mounts[0].source === compose.databaseVolumeName && observed.mounts[0].target === "/var/lib/postgresql/data" &&
      observed.mounts[0].readOnly === false;
    if (inspection.name !== compose.databaseName || inspection.id.length === 0 || !labelsMatch ||
        observed.image !== compose.databaseImage || observed.user !== expectedOptions.user || observed.privileged ||
        !observed.readOnlyRootfs || observed.networkMode !== compose.networkName ||
        observed.capDrop.length !== 1 || observed.capDrop[0] !== "ALL" ||
        observed.securityOpt.length !== 1 || observed.securityOpt[0] !== "no-new-privileges:true" ||
        observed.memoryBytes !== limits.memoryBytes || observed.nanoCpus !== limits.nanoCpus || observed.pidsLimit !== limits.pidsLimit ||
        !mountsMatch || !sameRecord(observed.tmpfs, expectedOptions.tmpfs) || !containsRecord(observed.environment, compose.databaseEnvironment)) {
      throw new DockerEnvironmentError("DOCKER_CONFIGURATION_MISMATCH", "PostgreSQL sidecar does not match the isolated managed configuration");
    }
    const volume = await client.inspectVolume(compose.databaseVolumeName);
    const expectedVolumeLabels = composeLabelsFor(identity, "compose-postgres-data");
    if (!volume || volume.name !== compose.databaseVolumeName || volume.driver !== "local" ||
        !sameRecord(Object.fromEntries(Object.entries(volume.labels).filter((entry): entry is [string, string] => typeof entry[1] === "string")), expectedVolumeLabels)) {
      throw new DockerEnvironmentError("DOCKER_IDENTITY_MISMATCH", "PostgreSQL data volume is missing or has a different owner");
    }
    return inspection;
  };

  const ensureComposeResources = async (identity: EnvironmentIdentity, resolved: ResolvedDevContainerConfiguration): Promise<void> => {
    const compose = resolved.compose;
    if (!compose) return;
    if (!client.inspectNetwork || !client.createNetwork || !client.inspectVolume || !client.createVolume) {
      throw new DockerEnvironmentError("DEV_CONTAINER_CONFIGURATION_UNSUPPORTED", "Docker client does not support managed Compose dependencies");
    }
    const expectedNetworkLabels = composeLabelsFor(identity, "compose-network");
    const existingNetwork = await client.inspectNetwork(compose.networkName);
    if (existingNetwork) await verifyComposeNetwork(identity, compose);
    else {
      const created = await client.createNetwork({ name: compose.networkName, driver: "bridge", internal: true, labels: expectedNetworkLabels });
      if (created.name !== compose.networkName || created.driver !== "bridge" || !created.internal ||
          !sameRecord(Object.fromEntries(Object.entries(created.labels).filter((entry): entry is [string, string] => typeof entry[1] === "string")), expectedNetworkLabels)) {
        throw new DockerEnvironmentError("DOCKER_IDENTITY_MISMATCH", "Created Compose network could not be verified");
      }
    }
    if (!compose.databaseService) return;
    const volume = await client.inspectVolume(compose.databaseVolumeName);
    const expectedVolumeLabels = composeLabelsFor(identity, "compose-postgres-data");
    if (volume) {
      if (volume.name !== compose.databaseVolumeName || volume.driver !== "local" ||
          !sameRecord(Object.fromEntries(Object.entries(volume.labels).filter((entry): entry is [string, string] => typeof entry[1] === "string")), expectedVolumeLabels)) {
        throw new DockerEnvironmentError("DOCKER_IDENTITY_MISMATCH", "PostgreSQL data volume name is already owned by another environment");
      }
    } else {
      await client.createVolume({ name: compose.databaseVolumeName, driver: "local", labels: expectedVolumeLabels });
    }
    const database = await verifyComposeDatabase(identity, resolved);
    if (database) return;
    if (!client.pullImage) throw new DockerEnvironmentError("DEV_CONTAINER_CONFIGURATION_UNSUPPORTED", "Docker client does not support pulling the Compose PostgreSQL image");
    await client.pullImage(compose.databaseImage);
    const created = await client.createContainer(composeDatabaseOptions(identity, resolved));
    const inspected = await verifyComposeDatabase(identity, resolved);
    if (!inspected || inspected.id !== created.id) {
      throw new DockerEnvironmentError("DOCKER_IDENTITY_MISMATCH", "Created PostgreSQL sidecar could not be verified by its stable identity");
    }
  };

  const recordFor = (identity: EnvironmentIdentity, inspection: DockerContainerInspection, mounts: readonly DockerMount[], resolved: ResolvedDevContainerConfiguration): ManagedEnvironment => {
    const expectedLabels = labelsFor(identity);
    if (inspection.name !== containerName(identity.id) || LABELS.some((label) => inspection.labels[label] !== expectedLabels[label])) {
      throw new DockerEnvironmentError("DOCKER_IDENTITY_MISMATCH", "Docker container identity or owner labels do not match the requested environment");
    }
    const observed = inspection.config;
    const observedMounts = observed.mounts;
    const safeConfiguration =
      observed.image === resolved.image && observed.user === "1000:1000" && observed.privileged === false &&
      observed.readOnlyRootfs === true && observed.networkMode === (resolved.compose?.networkName ?? "none") &&
      observed.capDrop.length === 1 && observed.capDrop[0] === "ALL" &&
      observed.securityOpt.length === 1 && observed.securityOpt[0] === "no-new-privileges:true" &&
      observed.memoryBytes === limits.memoryBytes && observed.nanoCpus === limits.nanoCpus && observed.pidsLimit === limits.pidsLimit &&
      observedMounts.length === mounts.length && mounts.every((mount, index) => {
        const observedMount = observedMounts[index];
        return observedMount?.type === mount.type && observedMount.source === mount.source &&
          observedMount.target === mount.target && observedMount.readOnly === false;
      }) &&
      sameRecord(observed.tmpfs, TMPFS) && containsRecord(observed.environment, { ...ENVIRONMENT, ...resolved.containerEnvironment }) && inspection.id.length > 0;
    if (!safeConfiguration) {
      throw new DockerEnvironmentError("DOCKER_CONFIGURATION_MISMATCH", "Docker container configuration does not match the required isolation settings");
    }
    return { ...identity, backendId, resourceId: inspection.id, status: status(inspection.state) };
  };

  const legacyRecordFor = (
    identity: EnvironmentIdentity,
    inspection: DockerContainerInspection,
    mounts: readonly DockerBindMount[],
    image: string,
  ): ManagedEnvironment | null => {
    const expectedLabels = labelsFor(identity);
    const actualLabels = Object.fromEntries(Object.entries(inspection.labels).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
    if (inspection.name !== containerName(identity.id) || !sameRecord(actualLabels, expectedLabels)) return null;
    const observed = inspection.config;
    const safeLegacyConfiguration =
      observed.image === image && observed.user === "1000:1000" && observed.privileged === false &&
      observed.readOnlyRootfs === true && observed.networkMode === "none" &&
      observed.capDrop.length === 1 && observed.capDrop[0] === "ALL" &&
      observed.securityOpt.length === 1 && observed.securityOpt[0] === "no-new-privileges:true" &&
      observed.memoryBytes === limits.memoryBytes && observed.nanoCpus === limits.nanoCpus && observed.pidsLimit === limits.pidsLimit &&
      observed.mounts.length === mounts.length && mounts.every((mount, index) => {
        const observedMount = observed.mounts[index];
        return observedMount?.type === "bind" && observedMount.source === mount.source &&
          observedMount.target === mount.target && observedMount.readOnly === false;
      }) && sameRecord(observed.tmpfs, TMPFS) && sameRecord(observed.environment, LEGACY_ENVIRONMENT) && inspection.id.length > 0;
    return safeLegacyConfiguration
      ? { ...identity, backendId, resourceId: inspection.id, status: status(inspection.state) }
      : null;
  };

  const inspectVerified = async (identity: EnvironmentIdentity): Promise<{ record: ManagedEnvironment; inspection: DockerContainerInspection } | null> => {
    const lifecycle = await inspectLifecycleVerified(identity);
    if (!lifecycle || lifecycle.compatibility === "legacy") return null;
    if (lifecycle.compatibility === "missing-runtime-data") {
      throw new DockerEnvironmentError("DOCKER_CONFIGURATION_MISMATCH", "Docker runtime data volume is missing from an existing environment");
    }
    return lifecycle;
  };

  const inspectLegacyVerified = async (identity: EnvironmentIdentity): Promise<{ record: ManagedEnvironment; inspection: DockerContainerInspection } | null> => {
    const resolved = await resolveDevContainerConfiguration(identity, config, containerStorageRoot);
    const mounts = await resolveMounts(identity, resolved.workspaceMountTarget);
    const inspection = await client.inspectContainer(containerName(identity.id));
    if (!inspection) return null;
    const record = legacyRecordFor(identity, inspection, mounts, resolved.image);
    return record ? { record, inspection } : null;
  };

  const inspectLifecycleVerified = async (identity: EnvironmentIdentity) => {
    const resolved = await resolveDevContainerConfiguration(identity, config, containerStorageRoot);
    const bindMounts = await resolveMounts(identity, resolved.workspaceMountTarget);
    const inspection = await client.inspectContainer(containerName(identity.id));
    if (!inspection) return null;
    const mounts: DockerMount[] = [...bindMounts, { type: "volume", source: dataVolumeName(identity.id), target: "/var/lib/subpolar", readOnly: false }];
    let current: ManagedEnvironment;
    try {
      current = recordFor(identity, inspection, mounts, resolved);
    } catch (cause) {
      const legacy = legacyRecordFor(identity, inspection, bindMounts, resolved.image);
      if (legacy) return { record: legacy, inspection, compatibility: "legacy" as const };
      throw cause;
    }
    const volume = await client.inspectVolume(dataVolumeName(identity.id));
    if (!volume) return { record: current, inspection, compatibility: "missing-runtime-data" as const };
    verifyDataVolume(identity, volume);
    if (resolved.compose) {
      const database = await verifyComposeDatabase(identity, resolved);
      if (resolved.compose.databaseService && !database) throw new DockerEnvironmentError("DOCKER_CONFIGURATION_MISMATCH", "Compose PostgreSQL sidecar is missing");
      await verifyComposeNetwork(identity, resolved.compose, inspection.state === "running" ? [
        { inspection, alias: resolved.compose.service },
        ...(database ? [{ inspection: database, alias: resolved.compose.databaseService }] : []),
      ] : undefined);
    }
    return { record: current, inspection, compatibility: "current" as const };
  };

  const volumeLabelsFor = (identity: EnvironmentIdentity): Readonly<Record<string, string>> => ({
    ...labelsFor(identity),
    "io.subpolar.volume-purpose": "runtime-data",
  });

  const verifyDataVolume = (identity: EnvironmentIdentity, volume: DockerVolumeInspection): void => {
    const expected = volumeLabelsFor(identity);
    if (volume.name !== dataVolumeName(identity.id) || volume.driver !== "local" ||
        Object.entries(expected).some(([key, value]) => volume.labels[key] !== value)) {
      throw new DockerEnvironmentError("DOCKER_IDENTITY_MISMATCH", "Docker data volume identity or owner labels do not match the requested environment");
    }
  };

  const ensureDataVolume = async (identity: EnvironmentIdentity): Promise<void> => {
    const name = dataVolumeName(identity.id);
    const existing = await client.inspectVolume(name);
    if (existing) {
      verifyDataVolume(identity, existing);
      return;
    }
    try {
      const created = await client.createVolume({ name, driver: "local", labels: volumeLabelsFor(identity) });
      verifyDataVolume(identity, created);
    } catch (cause) {
      // Docker's volume create is idempotent by name. If another manager won
      // the race, adopt only after validating its full ownership metadata.
      const raced = await client.inspectVolume(name);
      if (raced) {
        verifyDataVolume(identity, raced);
        return;
      }
      throw cause;
    }
  };

  const inspectLifecycle = async (identity: EnvironmentIdentity) => {
    return inspectLifecycleVerified(identity);
  };

  const runLifecycleCommand = async (
    identity: EnvironmentIdentity,
    inspection: DockerContainerInspection,
    command: readonly string[],
  ): Promise<EnvironmentProcessResult> => {
    if (!client.executeContainer) {
      throw new DockerEnvironmentError("DEV_CONTAINER_CONFIGURATION_UNSUPPORTED", "Docker client does not support Dev Container lifecycle commands");
    }
    const worktreeRelativePath = path.relative(identity.storageRoot, identity.worktreePath);
    if (!worktreeRelativePath || worktreeRelativePath === ".." || worktreeRelativePath.startsWith(`..${path.sep}`) || path.isAbsolute(worktreeRelativePath)) {
      throw new DockerEnvironmentError("WORKTREE_MAPPING_INVALID", "Environment worktree cannot be mapped inside the container");
    }
    const resolved = await resolveDevContainerConfiguration(identity, config, containerStorageRoot);
    const worktreeDirectory = resolved.workspaceFolder ?? worktreeContainerPath(identity, containerStorageRoot, resolved.workspaceMountTarget);
    return client.executeContainer(inspection.id, {
      command,
      worktreeDirectory,
      workingDirectory: worktreeDirectory,
      environment: {},
    });
  };

  const failLifecycleCommand = async (environment: ManagedEnvironment, inspection: DockerContainerInspection, hook: string, cause?: unknown): Promise<never> => {
    try {
      await client.stopContainer(inspection.id, { timeoutSeconds: 10 });
      const stopped = await inspectLifecycle(environment);
      if (!stopped || stopped.record.resourceId !== environment.resourceId || stopped.record.status !== "stopped") {
        throw new DockerEnvironmentError("DOCKER_IDENTITY_MISMATCH", "Docker container did not reach the verified stopped state after lifecycle failure");
      }
    } catch (stopCause) {
      throw new DockerEnvironmentError("DEV_CONTAINER_SETUP_FAILED", `Dev Container ${hook} failed and its worker could not be verified stopped`, {
        cause: stopCause,
      });
    }
    throw new DockerEnvironmentError("DEV_CONTAINER_SETUP_FAILED", `Dev Container ${hook} failed; the worker was stopped`, { cause });
  };

  const stopComposeDatabaseAfterFailedStart = async (environment: EnvironmentIdentity, resolved: ResolvedDevContainerConfiguration): Promise<void> => {
    if (!resolved.compose?.databaseService) return;
    const database = await verifyComposeDatabase(environment, resolved);
    if (database?.state === "running") await client.stopContainer(database.id, { timeoutSeconds: 10 });
  };

  return {
    id: backendId,
    async inspect(identity) {
      return (await inspectVerified(identity))?.record ?? null;
    },
    async inspectForLifecycle(identity) {
      const found = await inspectLifecycleVerified(identity);
      return found ? { environment: found.record, compatibility: found.compatibility } : null;
    },
    async create(identity) {
      const existing = await inspectVerified(identity);
      if (existing) return existing.record;
      const legacy = await inspectLegacyVerified(identity);
      if (legacy) {
        if (legacy.record.status !== "stopped") {
          await client.stopContainer(legacy.inspection.id, { timeoutSeconds: 10 });
          const stopped = await inspectLegacyVerified(identity);
          if (!stopped || stopped.record.resourceId !== legacy.record.resourceId || stopped.record.status !== "stopped") {
            throw new DockerEnvironmentError("DOCKER_IDENTITY_MISMATCH", "Legacy Docker container could not be verified stopped before migration");
          }
        }
        const stopped = await inspectLegacyVerified(identity);
        if (!stopped || stopped.record.resourceId !== legacy.record.resourceId || stopped.record.status !== "stopped") {
          throw new DockerEnvironmentError("DOCKER_IDENTITY_MISMATCH", "Legacy Docker container changed identity before migration");
        }
        await client.removeContainer(stopped.inspection.id, { force: false, removeVolumes: false });
      }
      const resolved = await resolveDevContainerConfiguration(identity, config, containerStorageRoot);
      if ((resolved.postCreateCommand || resolved.postStartCommand) && !client.executeContainer) {
        throw new DockerEnvironmentError("DEV_CONTAINER_CONFIGURATION_UNSUPPORTED", "Docker client does not support Dev Container lifecycle commands");
      }
      if (resolved.build) {
        if (!client.buildImage) {
          throw new DockerEnvironmentError("DEV_CONTAINER_BUILD_UNAVAILABLE", "Docker client does not support manager-owned Dev Container image builds");
        }
        try {
          await client.buildImage(resolved.build);
        } catch (cause) {
          throw new DockerEnvironmentError("DEV_CONTAINER_BUILD_FAILED", "Dev Container Dockerfile build failed", { cause });
        }
      }
      await ensureDataVolume(identity);
      await ensureComposeResources(identity, resolved);
      const options = await createOptions(identity, resolved);
      let createdId: string;
      try {
        ({ id: createdId } = await client.createContainer(options));
      } catch (cause) {
        // Another manager may have won the stable-name race. Adopt only after
        // re-reading and verifying every ownership and isolation field.
        const raced = await inspectVerified(identity);
        if (raced) return raced.record;
        throw cause;
      }
      const created = await inspectVerified(identity);
      if (!created || created.record.resourceId !== createdId) {
        throw new DockerEnvironmentError("DOCKER_IDENTITY_MISMATCH", "Created Docker container could not be verified by its stable identity");
      }
      return created.record;
    },
    async start(environment) {
      const current = await inspectVerified(environment);
      if (!current || current.record.resourceId !== environment.resourceId) {
        throw new DockerEnvironmentError("DOCKER_IDENTITY_MISMATCH", "Docker container disappeared or changed identity before start");
      }
      const resolved = await resolveDevContainerConfiguration(environment, config, containerStorageRoot);
      let database: DockerContainerInspection | null = null;
      if (resolved.compose?.databaseService) {
        database = await verifyComposeDatabase(environment, resolved);
        if (!database) throw new DockerEnvironmentError("DOCKER_CONFIGURATION_MISMATCH", "Compose PostgreSQL sidecar is missing before worker start");
        if (database.state !== "running") await client.startContainer(database.id);
        if (!client.waitContainerHealthy) {
          throw new DockerEnvironmentError("DEV_CONTAINER_CONFIGURATION_UNSUPPORTED", "Docker client cannot verify PostgreSQL readiness");
        }
        await client.waitContainerHealthy(database.id, 60_000);
      }
      if (current.record.status !== "ready") {
        try {
          await client.startContainer(current.inspection.id);
        } catch (cause) {
          await stopComposeDatabaseAfterFailedStart(environment, resolved);
          throw cause;
        }
      }
      const started = await inspectVerified(environment);
      if (!started || started.record.resourceId !== environment.resourceId || started.record.status !== "ready") {
        throw new DockerEnvironmentError("DOCKER_IDENTITY_MISMATCH", "Docker container did not reach the verified running state");
      }
      if (resolved.postCreateCommand) {
        let result: EnvironmentProcessResult;
        try {
          result = await runLifecycleCommand(environment, started.inspection, postCreateArgv(resolved.postCreateCommand, started.record.resourceId));
        } catch (cause) {
          await stopComposeDatabaseAfterFailedStart(environment, resolved);
          return failLifecycleCommand(started.record, started.inspection, "postCreateCommand", cause);
        }
        if (result.exitCode !== 0 || result.cancelled) {
          await stopComposeDatabaseAfterFailedStart(environment, resolved);
          return failLifecycleCommand(started.record, started.inspection, "postCreateCommand", result);
        }
      }
      if (current.record.status !== "ready" && resolved.postStartCommand) {
        let result: EnvironmentProcessResult;
        try {
          result = await runLifecycleCommand(environment, started.inspection, lifecycleArgv(resolved.postStartCommand));
        } catch (cause) {
          await stopComposeDatabaseAfterFailedStart(environment, resolved);
          return failLifecycleCommand(started.record, started.inspection, "postStartCommand", cause);
        }
        if (result.exitCode !== 0 || result.cancelled) {
          await stopComposeDatabaseAfterFailedStart(environment, resolved);
          return failLifecycleCommand(started.record, started.inspection, "postStartCommand", result);
        }
      }
      return started.record;
    },
    async stop(environment) {
      const current = await inspectLifecycle(environment);
      if (!current || current.record.resourceId !== environment.resourceId) {
        throw new DockerEnvironmentError("DOCKER_IDENTITY_MISMATCH", "Docker container disappeared or changed identity before stop");
      }
      if (current.record.status !== "stopped") await client.stopContainer(current.inspection.id, { timeoutSeconds: 10 });
      const resolved = await resolveDevContainerConfiguration(environment, config, containerStorageRoot);
      if (resolved.compose?.databaseService) {
        const database = await verifyComposeDatabase(environment, resolved);
        if (!database) throw new DockerEnvironmentError("DOCKER_CONFIGURATION_MISMATCH", "Compose PostgreSQL sidecar disappeared before stop");
        if (database.state !== "exited") await client.stopContainer(database.id, { timeoutSeconds: 10 });
      }
      const stopped = await inspectLifecycle(environment);
      if (!stopped || stopped.record.resourceId !== environment.resourceId || stopped.record.status !== "stopped") {
        throw new DockerEnvironmentError("DOCKER_IDENTITY_MISMATCH", "Docker container did not reach the verified stopped state");
      }
      return stopped.record;
    },
    async remove(environment) {
      const current = await inspectLifecycle(environment);
      if (!current || current.record.resourceId !== environment.resourceId) {
        throw new DockerEnvironmentError("DOCKER_IDENTITY_MISMATCH", "Docker container disappeared or changed identity before removal");
      }
      if (current.record.status !== "stopped") {
        await client.stopContainer(current.inspection.id, { timeoutSeconds: 10 });
        const afterStop = await inspectLifecycle(environment);
        if (!afterStop || afterStop.record.resourceId !== environment.resourceId || afterStop.record.status !== "stopped") {
          throw new DockerEnvironmentError("DOCKER_IDENTITY_MISMATCH", "Docker container could not be verified stopped before removal");
        }
      }
      const resolved = await resolveDevContainerConfiguration(environment, config, containerStorageRoot);
      let database: DockerContainerInspection | null = null;
      if (resolved.compose?.databaseService) {
        database = await verifyComposeDatabase(environment, resolved);
        if (!database) throw new DockerEnvironmentError("DOCKER_CONFIGURATION_MISMATCH", "Compose PostgreSQL sidecar disappeared before removal");
        if (database.state !== "exited") {
          await client.stopContainer(database.id, { timeoutSeconds: 10 });
          database = await verifyComposeDatabase(environment, resolved);
          if (!database || database.state !== "exited") throw new DockerEnvironmentError("DOCKER_IDENTITY_MISMATCH", "PostgreSQL sidecar could not be verified stopped before removal");
        }
      }
      await client.removeContainer(current.inspection.id, { force: false, removeVolumes: false });
      if (database) await client.removeContainer(database.id, { force: false, removeVolumes: false });
      if (resolved.compose) {
        if (!client.removeNetwork) throw new DockerEnvironmentError("DEV_CONTAINER_CONFIGURATION_UNSUPPORTED", "Docker client cannot remove managed Compose networks");
        await client.removeNetwork(resolved.compose.networkName);
      }
    },
    async removePersistentData(identity) {
      const volume = await client.inspectVolume(dataVolumeName(identity.id));
      if (volume) {
        verifyDataVolume(identity, volume);
        await client.removeVolume(volume.name);
      }
      const resolved = await resolveDevContainerConfiguration(identity, config, containerStorageRoot);
      if (resolved.compose?.databaseService) {
        const databaseVolume = await client.inspectVolume(resolved.compose.databaseVolumeName);
        if (databaseVolume) {
          const expectedLabels = composeLabelsFor(identity, "compose-postgres-data");
          if (databaseVolume.name !== resolved.compose.databaseVolumeName || databaseVolume.driver !== "local" ||
        !sameRecord(Object.fromEntries(Object.entries(databaseVolume.labels).filter((entry): entry is [string, string] => typeof entry[1] === "string")), expectedLabels)) {
            throw new DockerEnvironmentError("DOCKER_IDENTITY_MISMATCH", "PostgreSQL volume cannot be removed because its ownership differs");
          }
          await client.removeVolume(databaseVolume.name);
        }
      }
    },
    async execute(environment, command, request) {
      if (!client.executeContainer) {
        throw new DockerEnvironmentError("PROCESS_EXECUTION_UNAVAILABLE", "Docker client does not support managed process execution");
      }
      if (!command.length || command.some((part) => !part || part.includes("\0"))) {
        throw new DockerEnvironmentError("PROCESS_REQUEST_INVALID", "Process command must be a non-empty argv array without NUL bytes");
      }
      const relativeCwd = request.cwd ?? ".";
      if (path.posix.isAbsolute(relativeCwd) || relativeCwd.includes("\0")) {
        throw new DockerEnvironmentError("PROCESS_REQUEST_INVALID", "Process cwd must be relative to the worktree");
      }
      const worktreeRelativePath = path.relative(environment.storageRoot, environment.worktreePath);
      if (!worktreeRelativePath || worktreeRelativePath === ".." || worktreeRelativePath.startsWith(`..${path.sep}`) || path.isAbsolute(worktreeRelativePath)) {
        throw new DockerEnvironmentError("PROCESS_REQUEST_INVALID", "Environment worktree cannot be mapped inside the container");
      }
      const resolved = await resolveDevContainerConfiguration(environment, config, containerStorageRoot);
      const worktreeTarget = worktreeContainerPath(environment, containerStorageRoot, resolved.workspaceMountTarget);
      const workingDirectory = path.posix.resolve(resolved.workspaceFolder ?? worktreeTarget, relativeCwd);
      if (workingDirectory !== worktreeTarget && !workingDirectory.startsWith(`${worktreeTarget}/`)) {
        throw new DockerEnvironmentError("PROCESS_REQUEST_INVALID", "Process cwd escapes the mounted worktree");
      }
      const environmentVariables = request.environment ?? {};
      for (const [key, value] of Object.entries(environmentVariables)) {
        if (!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(key) || value.includes("\0") || value.length > 16_384) {
          throw new DockerEnvironmentError("PROCESS_REQUEST_INVALID", "Process environment contains an invalid key or value");
        }
      }
      const current = await inspectVerified(environment);
      if (!current || current.record.resourceId !== environment.resourceId || current.record.status !== "ready") {
        throw new DockerEnvironmentError("DOCKER_IDENTITY_MISMATCH", "Docker environment is unavailable or changed identity before process execution");
      }
      if (request.signal?.aborted) return { exitCode: null, cancelled: true };
      return client.executeContainer(current.inspection.id, {
        command: [...command],
        worktreeDirectory: worktreeTarget,
        workingDirectory,
        environment: { ...environmentVariables },
        ...(request.signal === undefined ? {} : { signal: request.signal }),
        ...(request.onOutput === undefined ? {} : { onOutput: request.onOutput }),
      });
    },
    async startInteractive(environment, command, request) {
      if (!client.startInteractiveContainer) {
        throw new DockerEnvironmentError("PROCESS_EXECUTION_UNAVAILABLE", "Docker client does not support interactive process execution");
      }
      if (!command.length || command.some((part) => !part || part.includes("\0"))) {
        throw new DockerEnvironmentError("PROCESS_REQUEST_INVALID", "Process command must be a non-empty argv array without NUL bytes");
      }
      const relativeCwd = request.cwd ?? ".";
      if (path.posix.isAbsolute(relativeCwd) || relativeCwd.includes("\0")) {
        throw new DockerEnvironmentError("PROCESS_REQUEST_INVALID", "Process cwd must be relative to the worktree");
      }
      const worktreeRelativePath = path.relative(environment.storageRoot, environment.worktreePath);
      if (!worktreeRelativePath || worktreeRelativePath === ".." || worktreeRelativePath.startsWith(`..${path.sep}`) || path.isAbsolute(worktreeRelativePath)) {
        throw new DockerEnvironmentError("PROCESS_REQUEST_INVALID", "Environment worktree cannot be mapped inside the container");
      }
      const resolved = await resolveDevContainerConfiguration(environment, config, containerStorageRoot);
      const worktreeTarget = worktreeContainerPath(environment, containerStorageRoot, resolved.workspaceMountTarget);
      const workingDirectory = path.posix.resolve(resolved.workspaceFolder ?? worktreeTarget, relativeCwd);
      if (workingDirectory !== worktreeTarget && !workingDirectory.startsWith(`${worktreeTarget}/`)) {
        throw new DockerEnvironmentError("PROCESS_REQUEST_INVALID", "Process cwd escapes the mounted worktree");
      }
      const environmentVariables = request.environment ?? {};
      for (const [key, value] of Object.entries(environmentVariables)) {
        if (!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(key) || value.includes("\0") || value.length > 16_384) {
          throw new DockerEnvironmentError("PROCESS_REQUEST_INVALID", "Process environment contains an invalid key or value");
        }
      }
      const current = await inspectVerified(environment);
      if (!current || current.record.resourceId !== environment.resourceId || current.record.status !== "ready") {
        throw new DockerEnvironmentError("DOCKER_IDENTITY_MISMATCH", "Docker environment is unavailable or changed identity before interactive process start");
      }
      return client.startInteractiveContainer(current.inspection.id, {
        command: [...command], worktreeDirectory: worktreeTarget, workingDirectory,
        ...(request.environment === undefined ? {} : { environment: { ...request.environment } }),
      });
    },
    async startManagedSession(environment, command, request) {
      if (!client.startManagedSessionContainer) {
        throw new DockerEnvironmentError("PROCESS_EXECUTION_UNAVAILABLE", "Docker client does not support managed process sessions");
      }
      if (!command.length || command.some((part) => !part || part.includes("\0"))) {
        throw new DockerEnvironmentError("PROCESS_REQUEST_INVALID", "Process command must be a non-empty argv array without NUL bytes");
      }
      const relativeCwd = request.cwd ?? ".";
      if (path.posix.isAbsolute(relativeCwd) || relativeCwd.includes("\0")) throw new DockerEnvironmentError("PROCESS_REQUEST_INVALID", "Process cwd must be relative to the worktree");
      const worktreeRelativePath = path.relative(environment.storageRoot, environment.worktreePath);
      if (!worktreeRelativePath || worktreeRelativePath === ".." || worktreeRelativePath.startsWith(`..${path.sep}`) || path.isAbsolute(worktreeRelativePath)) {
        throw new DockerEnvironmentError("PROCESS_REQUEST_INVALID", "Environment worktree cannot be mapped inside the container");
      }
      const resolved = await resolveDevContainerConfiguration(environment, config, containerStorageRoot);
      const worktreeTarget = worktreeContainerPath(environment, containerStorageRoot, resolved.workspaceMountTarget);
      const workingDirectory = path.posix.resolve(resolved.workspaceFolder ?? worktreeTarget, relativeCwd);
      if (workingDirectory !== worktreeTarget && !workingDirectory.startsWith(`${worktreeTarget}/`)) throw new DockerEnvironmentError("PROCESS_REQUEST_INVALID", "Process cwd escapes the mounted worktree");
      const environmentVariables = request.environment ?? {};
      for (const [key, value] of Object.entries(environmentVariables)) {
        if (!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(key) || value.includes("\0") || value.length > 16_384) {
          throw new DockerEnvironmentError("PROCESS_REQUEST_INVALID", "Process environment contains an invalid key or value");
        }
      }
      const current = await inspectVerified(environment);
      if (!current || current.record.resourceId !== environment.resourceId || current.record.status !== "ready") {
        throw new DockerEnvironmentError("DOCKER_IDENTITY_MISMATCH", "Docker environment is unavailable or changed identity before process session start");
      }
      return client.startManagedSessionContainer(current.inspection.id, {
        command: [...command], worktreeDirectory: worktreeTarget, workingDirectory,
        ...(request.environment === undefined ? {} : { environment: { ...request.environment } }),
      });
    },
  };
}
