import {
  OPERATIONS_MANIFEST_FORMAT,
  OPERATIONS_MANIFEST_VERSION,
  serializeOperationsManifest,
  stableSerialize,
  validateOperationsManifest,
  type ManifestValidationResult,
  type OperationsManifest,
} from "@subpolar/shared";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { constants as fsConstants } from "node:fs";
import { lstat, mkdir, open, readdir, readFile, rename, rm, rmdir } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";

const SUPPORTED_MIGRATION_FORMATS = new Set(["backup/v1", "backup/v2"]);

export type ManifestInput = Omit<OperationsManifest, "format" | "version">;

export interface ManifestReport {
  valid: boolean;
  errors: readonly string[];
  manifest?: OperationsManifest;
  serialization?: string;
}

export type MigrationVerificationErrorCode =
  | "INVALID_MANIFEST"
  | "MISSING_PAYLOAD"
  | "UNEXPECTED_PAYLOAD"
  | "CHECKSUM_MISMATCH";

export interface MigrationVerificationError {
  code: MigrationVerificationErrorCode;
  id?: string;
}

export interface MigrationStepVerification {
  id: string;
  order: number;
  valid: boolean;
  code?: Exclude<MigrationVerificationErrorCode, "INVALID_MANIFEST" | "UNEXPECTED_PAYLOAD">;
}

export interface MigrationVerificationReport {
  valid: boolean;
  errors: readonly MigrationVerificationError[];
  results: readonly MigrationStepVerification[];
}

export interface DryRunRequest {
  operation: "migration" | "backup" | "restore";
  manifest: unknown;
  approved?: boolean;
}

export interface DryRunReport {
  operation: DryRunRequest["operation"];
  dryRun: true;
  performed: false;
  valid: boolean;
  errors: readonly string[];
  planned: {
    migrationSteps: number;
    backupArtifacts: number;
    totalBackupBytes: number;
  };
  refusal?: {
    code: "INVALID_MANIFEST" | "SECRET_BEARING_ARTIFACT" | "MIGRATION_VERSION_UNSUPPORTED" | "DESTRUCTIVE_RESTORE_APPROVAL_REQUIRED";
    message: string;
  };
}

function migrationErrors(manifest: unknown): string[] {
  if (!manifest || typeof manifest !== "object") return [];
  const migration = (manifest as { migration?: unknown }).migration;
  if (!migration || typeof migration !== "object") return [];
  const candidate = migration as { fromFormat?: unknown; toFormat?: unknown };
  const errors: string[] = [];
  if (typeof candidate.fromFormat === "string" && !SUPPORTED_MIGRATION_FORMATS.has(candidate.fromFormat)) {
    errors.push("migration.fromFormat is unsupported");
  }
  if (typeof candidate.toFormat === "string" && !SUPPORTED_MIGRATION_FORMATS.has(candidate.toFormat)) {
    errors.push("migration.toFormat is unsupported");
  }
  return errors;
}

function validationReport(value: unknown): ManifestReport {
  const result: ManifestValidationResult = validateOperationsManifest(value);
  const errors = [...result.errors, ...migrationErrors(value)];
  if (errors.length > 0) return { valid: false, errors };
  const manifest = value as OperationsManifest;
  return { valid: true, errors: [], manifest, serialization: serializeOperationsManifest(manifest) };
}

export function buildOperationsManifest(input: ManifestInput): OperationsManifest {
  const manifest = {
    format: OPERATIONS_MANIFEST_FORMAT,
    version: OPERATIONS_MANIFEST_VERSION,
    ...input,
  } as OperationsManifest;
  const report = validationReport(manifest);
  if (!report.valid) throw new TypeError(`invalid operations manifest: ${report.errors.join("; ")}`);
  return manifest;
}

export function createManifestReport(input: ManifestInput | unknown): ManifestReport {
  if (!input || typeof input !== "object") return validationReport(input);
  const candidate = input as Record<string, unknown>;
  const manifest = "format" in candidate || "version" in candidate
    ? input
    : { format: OPERATIONS_MANIFEST_FORMAT, version: OPERATIONS_MANIFEST_VERSION, ...candidate };
  return validationReport(manifest);
}

export function validateManifestReport(manifest: unknown): ManifestReport {
  return validationReport(manifest);
}

/** Verify migration payloads without executing or accessing them through I/O. */
export async function verifyMigrationSteps(
  manifest: unknown,
  payloads: Map<string, Uint8Array>,
): Promise<MigrationVerificationReport> {
  const report = validationReport(manifest);
  if (!report.valid || !report.manifest) {
    return { valid: false, errors: [{ code: "INVALID_MANIFEST" }], results: [] };
  }

  const results: MigrationStepVerification[] = [];
  const errors: MigrationVerificationError[] = [];
  const expectedIds = new Set<string>();

  for (const step of report.manifest.migration.steps) {
    expectedIds.add(step.id);
    if (!payloads.has(step.id)) {
      results.push({ id: step.id, order: step.order, valid: false, code: "MISSING_PAYLOAD" });
      errors.push({ code: "MISSING_PAYLOAD", id: step.id });
      continue;
    }

    const payload = payloads.get(step.id) as Uint8Array;
    const payloadBuffer = new ArrayBuffer(payload.byteLength);
    new Uint8Array(payloadBuffer).set(payload);
    const digest = await globalThis.crypto.subtle.digest("SHA-256", payloadBuffer);
    const checksum = `sha256:${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
    if (checksum !== step.checksum) {
      results.push({ id: step.id, order: step.order, valid: false, code: "CHECKSUM_MISMATCH" });
      errors.push({ code: "CHECKSUM_MISMATCH", id: step.id });
    } else {
      results.push({ id: step.id, order: step.order, valid: true });
    }
  }

  for (const id of Array.from(payloads.keys()).sort()) {
    if (!expectedIds.has(id)) errors.push({ code: "UNEXPECTED_PAYLOAD", id });
  }

  return { valid: errors.length === 0, errors, results };
}

export function createDryRunReport(request: DryRunRequest): DryRunReport {
  const report = createManifestReport(request.manifest);
  const manifest = report.manifest;
  const artifacts = manifest?.backup.artifacts ?? [];
  const planned = {
    migrationSteps: manifest?.migration.steps.length ?? 0,
    backupArtifacts: artifacts.length,
    totalBackupBytes: artifacts.reduce((total: number, artifact: OperationsManifest["backup"]["artifacts"][number]) => total + artifact.sizeBytes, 0),
  };
  if (!report.valid || !manifest) {
    const secret = report.errors.some((error) => error.includes("may not contain secrets"));
    const unsupported = report.errors.some((error) => error.includes("migration.") && error.includes("unsupported"));
    return {
      operation: request.operation, dryRun: true, performed: false, valid: false,
      errors: report.errors, planned,
      refusal: { code: secret ? "SECRET_BEARING_ARTIFACT" : unsupported ? "MIGRATION_VERSION_UNSUPPORTED" : "INVALID_MANIFEST", message: secret ? "Secret-bearing backup artifacts are refused" : unsupported ? "The migration version is unsupported" : "The operations manifest is invalid" },
    };
  }
  const destructiveRestore = request.operation === "restore" && (manifest.restore.mode !== "merge" || manifest.restore.overwrite);
  if (destructiveRestore && (!manifest.restore.requiresApproval || request.approved !== true)) {
    return {
      operation: request.operation, dryRun: true, performed: false, valid: false,
      errors: ["destructive restore requires explicit approval"], planned,
      refusal: { code: "DESTRUCTIVE_RESTORE_APPROVAL_REQUIRED", message: "Destructive restore is refused without explicit approval" },
    };
  }
  return { operation: request.operation, dryRun: true, performed: false, valid: true, errors: [], planned };
}

export function serializeManifestReport(manifest: OperationsManifest): string {
  return stableSerialize(manifest);
}

const SECRET_NAME = /(^|[._-])(env|secret|secrets|token|password|passwd|credential|credentials|cookie|private[._-]?key|session[._-]?key)([._-]|$)/i;
const SAFE_PART = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export interface ArtifactRoot {
  class: Extract<OperationsManifest["backup"]["artifacts"][number]["class"], "configuration" | "metadata" | "transcript">;
  root: string | ReadonlyMap<string, Uint8Array>;
}

export interface ArtifactLimits {
  maxArtifacts: number;
  maxArtifactBytes: number;
  maxTotalBytes: number;
}

export interface CreateBackupOptions {
  backupId: string;
  createdAt: string;
  operationId?: string;
  generatedAt?: string;
  limits: ArtifactLimits;
  /** Required for deterministic output. No current time is read by this API. */
  artifactCreatedAt?: string;
}

export interface BackupArchive {
  manifest: OperationsManifest;
  payloads: ReadonlyMap<string, Uint8Array>;
}

export interface ArtifactReport {
  id: string;
  path: string;
  class: string;
  sizeBytes: number;
  checksum: string;
}

export interface BackupReport {
  archive: BackupArchive;
  artifacts: readonly ArtifactReport[];
}

export type ArtifactFailureCode = "SECRET_PATH" | "PATH_TRAVERSAL" | "SYMLINK" | "LIMIT" | "CHECKSUM_MISMATCH" | "EXISTS" | "APPROVAL_REQUIRED" | "INVALID_PATH";

export interface RestoreOptions {
  targetRoot: string;
  dryRun?: boolean;
  overwrite?: boolean;
  approved?: boolean;
}

export interface RestoreReport {
  valid: boolean;
  dryRun: boolean;
  performed: boolean;
  restored: readonly ArtifactReport[];
  errors: readonly { code: ArtifactFailureCode; path?: string; message: string }[];
}

function sha256(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function safeRelativePath(value: string): string {
  if (!value || value.includes("\\") || value.startsWith("/") || value.split("/").some((part) => part === ".." || part === "" || !SAFE_PART.test(part))) {
    throw new Error("invalid artifact path");
  }
  if (value.split("/").some((part) => SECRET_NAME.test(part))) throw new Error("secret artifact path");
  return value;
}

function inside(root: string, candidate: string): boolean {
  const rootPath = resolve(root);
  const candidatePath = resolve(candidate);
  return candidatePath === rootPath || candidatePath.startsWith(`${rootPath}${sep}`);
}

async function readBoundedFile(path: string, limit: number): Promise<Uint8Array> {
  const stat = await lstat(path);
  if (stat.isSymbolicLink()) throw new Error("symlink artifact refused");
  if (!stat.isFile()) throw new Error("artifact is not a regular file");
  if (stat.size > limit) throw new Error("artifact exceeds byte limit");
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of createReadStream(path, { highWaterMark: 64 * 1024 })) {
    const bytes = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
    size += bytes.length;
    if (size > limit) throw new Error("artifact exceeds byte limit");
    chunks.push(bytes);
  }
  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
  return result;
}

async function collectRoot(root: string, limit: number, prefix = ""): Promise<{ path: string; bytes: Uint8Array }[]> {
  const entries = (await readdir(root, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
  const result: { path: string; bytes: Uint8Array }[] = [];
  for (const entry of entries) {
    const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
    safeRelativePath(relativePath);
    const fullPath = join(root, entry.name);
    const stat = await lstat(fullPath);
    if (stat.isSymbolicLink()) throw new Error(`symlink artifact refused: ${relativePath}`);
    if (entry.isDirectory()) result.push(...await collectRoot(fullPath, limit, relativePath));
    else result.push({ path: relativePath, bytes: await readBoundedFile(fullPath, limit) });
  }
  return result;
}

async function rejectSymlinkComponents(root: string, destination: string): Promise<void> {
  const rootPath = resolve(root);
  const parts = resolve(destination).slice(rootPath.length).split(sep).filter(Boolean);
  let current = rootPath;
  for (const part of parts) {
    current = join(current, part);
    try {
      if ((await lstat(current)).isSymbolicLink()) throw new Error("symlink restore path");
    } catch (error) {
      if ((error as { code?: string }).code === "ENOENT") break;
      throw error;
    }
  }
}

/** Create a deterministic, in-memory archive from only the supplied roots. */
export async function createBackupArtifacts(sources: readonly ArtifactRoot[], options: CreateBackupOptions): Promise<BackupReport> {
  if (!Number.isSafeInteger(options.limits.maxArtifacts) || options.limits.maxArtifacts <= 0) throw new TypeError("invalid maxArtifacts");
  const files: { class: ArtifactRoot["class"]; path: string; bytes: Uint8Array }[] = [];
  for (const source of sources) {
    if (typeof source.root === "string") {
      const rootStat = await lstat(resolve(source.root));
      if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) throw new Error("artifact root must be a real directory");
    }
    const entries = typeof source.root === "string"
      ? await collectRoot(resolve(source.root), options.limits.maxArtifactBytes)
      : Array.from(source.root.entries()).sort(([a], [b]) => a.localeCompare(b)).map(([path, bytes]) => ({ path: safeRelativePath(path), bytes }));
    for (const entry of entries) {
      if (entry.bytes.byteLength > options.limits.maxArtifactBytes) throw new RangeError("artifact exceeds byte limit");
      files.push({ class: source.class, path: `${source.class}/${entry.path}`, bytes: new Uint8Array(entry.bytes) });
    }
  }
  files.sort((a, b) => a.path.localeCompare(b.path));
  if (files.length > options.limits.maxArtifacts) throw new RangeError("artifact count exceeds limit");
  const total = files.reduce((sum, file) => sum + file.bytes.byteLength, 0);
  if (total > options.limits.maxTotalBytes) throw new RangeError("total artifact bytes exceed limit");
  const createdAt = options.artifactCreatedAt ?? options.createdAt;
  const artifacts = files.map((file, index) => ({
    id: `artifact-${String(index + 1).padStart(6, "0")}`,
    class: file.class,
    path: file.path,
    mediaType: "application/octet-stream",
    sizeBytes: file.bytes.byteLength,
    checksum: sha256(file.bytes) as `sha256:${string}`,
    createdAt,
    encrypted: true,
  }));
  const manifest = buildOperationsManifest({
    operationId: options.operationId ?? `backup:${options.backupId}`,
    generatedAt: options.generatedAt ?? options.createdAt,
    migration: { fromFormat: "backup/v1", toFormat: "backup/v1", compatibility: "bidirectional", steps: [] },
    backup: { backupId: options.backupId, createdAt: options.createdAt, artifacts },
    restore: { mode: "merge", dryRun: false, overwrite: false, requiresApproval: false },
    retention: { category: "archive", retainForSeconds: 1, tombstones: false },
    limits: { ...options.limits, maxMigrationSteps: 1, maxDiagnosticEntries: 1 },
    truncation: { maxBytes: options.limits.maxTotalBytes, marker: "[truncated]" },
    timeouts: { migrationSeconds: 1, backupSeconds: 1, restoreSeconds: 1 },
    diagnostics: [],
  });
  const payloads = new Map(artifacts.map((artifact, index) => [artifact.id, files[index].bytes]));
  return { archive: { manifest, payloads }, artifacts: artifacts.map(({ id, path, class: artifactClass, sizeBytes, checksum }) => ({ id, path, class: artifactClass, sizeBytes, checksum })) };
}

/** Verify and optionally restore an archive beneath the explicitly supplied target root. */
export async function restoreBackupArtifacts(archive: BackupArchive, options: RestoreOptions): Promise<RestoreReport> {
  const dryRun = options.dryRun === true;
  const manifestReport = validateManifestReport(archive.manifest);
  const errors: { code: ArtifactFailureCode; path?: string; message: string }[] = [];
  if (!manifestReport.valid) return { valid: false, dryRun, performed: false, restored: [], errors: [{ code: "INVALID_PATH", message: "invalid operations manifest" }] };
  const destructive = options.overwrite === true || archive.manifest.restore.mode !== "merge";
  if (destructive && options.approved !== true) return { valid: false, dryRun, performed: false, restored: [], errors: [{ code: "APPROVAL_REQUIRED", message: "destructive restore requires explicit approval" }] };
  const restored: ArtifactReport[] = [];
  const stagedRoot = join(dirname(resolve(options.targetRoot)), `.subpolar-restore-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const committed: { destination: string; backup?: string }[] = [];
  const createdDirectories: string[] = [];
  let stagingCreated = false;
  try {
    try {
      const targetStat = await lstat(options.targetRoot);
      if (targetStat.isSymbolicLink() || !targetStat.isDirectory()) return { valid: false, dryRun, performed: false, restored: [], errors: [{ code: "SYMLINK", message: "target root must be a real directory" }] };
    } catch (error) {
      if ((error as { code?: string }).code !== "ENOENT") throw error;
    }
  for (const artifact of archive.manifest.backup.artifacts) {
    let relativePath: string;
    try {
      relativePath = safeRelativePath(artifact.path);
    } catch (error) {
      errors.push({ code: error instanceof Error && error.message.includes("secret") ? "SECRET_PATH" : "PATH_TRAVERSAL", path: artifact.path, message: "unsafe artifact path" });
      continue;
    }
    const destination = join(options.targetRoot, relativePath);
    if (!inside(options.targetRoot, destination)) { errors.push({ code: "PATH_TRAVERSAL", path: artifact.path, message: "restore path escapes target root" }); continue; }
    try { await rejectSymlinkComponents(options.targetRoot, destination); }
    catch { errors.push({ code: "SYMLINK", path: artifact.path, message: "restore path contains a symlink" }); continue; }
    const bytes = archive.payloads.get(artifact.id);
    if (!bytes || sha256(bytes) !== artifact.checksum || bytes.byteLength !== artifact.sizeBytes) { errors.push({ code: "CHECKSUM_MISMATCH", path: artifact.path, message: "artifact checksum or size mismatch" }); continue; }
    try {
      const existing = await lstat(destination);
      if (existing.isSymbolicLink()) { errors.push({ code: "SYMLINK", path: artifact.path, message: "restore destination is a symlink" }); continue; }
      if (!options.overwrite) { errors.push({ code: "EXISTS", path: artifact.path, message: "restore destination exists" }); continue; }
    } catch (error) { if ((error as { code?: string }).code !== "ENOENT") throw error; }
    restored.push({ id: artifact.id, path: artifact.path, class: artifact.class, sizeBytes: artifact.sizeBytes, checksum: artifact.checksum });
  }
  if (errors.length === 0 && !dryRun) {
    // Stage outside the target first. The target is not changed until every payload is ready.
    await mkdir(stagedRoot, { recursive: false });
    stagingCreated = true;
    for (const artifact of archive.manifest.backup.artifacts) {
      const bytes = archive.payloads.get(artifact.id);
      if (!bytes || sha256(bytes) !== artifact.checksum || bytes.byteLength !== artifact.sizeBytes) throw new Error(`payload changed during restore: ${artifact.path}`);
      const staged = join(stagedRoot, safeRelativePath(artifact.path));
      await mkdir(dirname(staged), { recursive: true });
      const file = await open(staged, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600);
      try { await file.write(bytes); }
      finally { await file.close(); }
    }

    for (const artifact of archive.manifest.backup.artifacts) {
      const relativePath = safeRelativePath(artifact.path);
      const destination = join(options.targetRoot, relativePath);
      await rejectSymlinkComponents(options.targetRoot, destination);
      const parent = dirname(destination);
      let current = resolve(options.targetRoot);
      const parentParts = resolve(parent).slice(current.length).split(sep).filter(Boolean);
      for (const part of parentParts) {
        current = join(current, part);
        try {
          const stat = await lstat(current);
          if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("restore path parent is not a directory");
        } catch (error) {
          if ((error as { code?: string }).code !== "ENOENT") throw error;
          await mkdir(current);
          await lstat(current);
          createdDirectories.push(current);
        }
      }
      const backup = join(stagedRoot, ".backup", String(committed.length));
      let existing = false;
      try {
        const stat = await lstat(destination);
        if (stat.isSymbolicLink()) throw new Error("restore destination is a symlink");
        existing = true;
      } catch (error) {
        if ((error as { code?: string }).code !== "ENOENT") throw error;
      }
      // Recheck immediately before each rename. rename does not follow the final symlink.
      await rejectSymlinkComponents(options.targetRoot, destination);
      if (existing) {
        if (!options.overwrite) throw new Error(`restore destination exists: ${artifact.path}`);
        await mkdir(dirname(backup), { recursive: true });
        await rename(destination, backup);
      }
      try {
        await rename(join(stagedRoot, relativePath), destination);
      } catch (error) {
        if (existing) await rename(backup, destination);
        throw error;
      }
      committed.push({ destination, backup: existing ? backup : undefined });
    }
  }
  return { valid: errors.length === 0, dryRun, performed: !dryRun && errors.length === 0, restored, errors };
  } catch (error) {
    for (const entry of committed.reverse()) {
      try { await rm(entry.destination, { recursive: true, force: true }); } catch { /* best effort during rollback */ }
      if (entry.backup) {
        try { await rename(entry.backup, entry.destination); } catch { /* best effort during rollback */ }
      }
    }
    for (const directory of createdDirectories.reverse()) {
      try { await rmdir(directory); } catch { /* only empty directories are removed */ }
    }
    errors.push({ code: "INVALID_PATH", message: error instanceof Error ? error.message : "restore failed" });
    return { valid: false, dryRun, performed: false, restored: [], errors };
  } finally {
    if (stagingCreated) await rm(stagedRoot, { recursive: true, force: true });
  }
}
