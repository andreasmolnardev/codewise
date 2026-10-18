export const OPERATIONS_MANIFEST_FORMAT = "operations-manifest/v1" as const;
export const OPERATIONS_MANIFEST_VERSION = 1 as const;

export type OperationId = string;
export type IsoDateTime = string;
export type Sha256Checksum = `sha256:${string}`;

export type MigrationStepKind = "schema" | "data" | "custom";

export interface MigrationStep {
  id: string;
  order: number;
  kind: MigrationStepKind;
  description: string;
  checksum: Sha256Checksum;
  reversible: boolean;
  requiresManualIntervention?: boolean;
  manualIntervention?: {
    reason: string;
    instructions: string;
  };
}

export interface MigrationPlan {
  fromFormat: string;
  toFormat: string;
  compatibility: "backward" | "forward" | "bidirectional" | "none";
  steps: readonly MigrationStep[];
}

export type BackupArtifactClass =
  | "configuration"
  | "database"
  | "filesystem"
  | "index"
  | "metadata"
  | "transcript";

export interface BackupArtifact {
  id: string;
  class: BackupArtifactClass;
  path: string;
  mediaType: string;
  sizeBytes: number;
  checksum: Sha256Checksum;
  createdAt: IsoDateTime;
  encrypted: boolean;
}

export interface BackupManifest {
  backupId: string;
  artifacts: readonly BackupArtifact[];
  createdAt: IsoDateTime;
}

export type RestoreMode = "merge" | "replace" | "rebuild";

export interface RestorePolicy {
  mode: RestoreMode;
  dryRun: boolean;
  overwrite: boolean;
  requiresApproval: boolean;
  approvalId?: string;
}

export type RetentionCategory = "active" | "archive" | "expired" | "tombstone";

export interface RetentionPolicy {
  category: RetentionCategory;
  retainForSeconds: number;
  tombstones: boolean;
  tombstoneAfterSeconds?: number;
}

export interface ResourceLimits {
  maxArtifacts: number;
  maxArtifactBytes: number;
  maxTotalBytes: number;
  maxMigrationSteps: number;
  maxDiagnosticEntries: number;
}

export interface TruncationPolicy {
  maxBytes: number;
  marker: string;
}

export interface TimeoutPolicy {
  migrationSeconds: number;
  backupSeconds: number;
  restoreSeconds: number;
}

export type DiagnosticDetail =
  | { kind: "code"; value: string }
  | { kind: "field"; name: string; value: string }
  | { kind: "count"; name: string; value: number }
  | { kind: "redacted"; reason: string };

export interface OperationDiagnostic {
  level: "info" | "warning" | "error";
  code: string;
  message: string;
  correlationId: string;
  details?: readonly DiagnosticDetail[];
  redacted: boolean;
}

export interface OperationsManifest {
  format: typeof OPERATIONS_MANIFEST_FORMAT;
  version: typeof OPERATIONS_MANIFEST_VERSION;
  operationId: OperationId;
  generatedAt: IsoDateTime;
  migration: MigrationPlan;
  backup: BackupManifest;
  restore: RestorePolicy;
  retention: RetentionPolicy;
  limits: ResourceLimits;
  truncation: TruncationPolicy;
  timeouts: TimeoutPolicy;
  diagnostics: readonly OperationDiagnostic[];
}

export interface ManifestValidationResult {
  valid: boolean;
  errors: readonly string[];
}

const SECRET_WORD = /(secret|token|password|private[ _-]?key|credential|cookie|session[ _-]?key)/i;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const CHECKSUM = /^sha256:[0-9a-f]{64}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function positiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function add(errors: string[], condition: boolean, message: string): void {
  if (!condition) errors.push(message);
}

function validateDiagnostic(diagnostic: unknown, index: number, errors: string[]): void {
  if (!isRecord(diagnostic)) {
    errors.push(`diagnostics[${index}] must be an object`);
    return;
  }
  add(errors, ["info", "warning", "error"].includes(String(diagnostic.level)), `diagnostics[${index}].level is invalid`);
  add(errors, typeof diagnostic.code === "string" && ID.test(diagnostic.code), `diagnostics[${index}].code is invalid`);
  add(errors, typeof diagnostic.message === "string" && diagnostic.message.length <= 500, `diagnostics[${index}].message is invalid`);
  add(errors, typeof diagnostic.correlationId === "string" && ID.test(diagnostic.correlationId), `diagnostics[${index}].correlationId is invalid`);
  add(errors, diagnostic.redacted === true, `diagnostics[${index}] must be redacted`);
  if (Array.isArray(diagnostic.details)) {
    diagnostic.details.forEach((detail, detailIndex) => {
      add(errors, isRecord(detail) && typeof detail.kind === "string", `diagnostics[${index}].details[${detailIndex}] is invalid`);
      if (isRecord(detail)) add(errors, ["code", "field", "count", "redacted"].includes(String(detail.kind)), `diagnostics[${index}].details[${detailIndex}].kind is invalid`);
      if (isRecord(detail) && typeof detail.name === "string") add(errors, !SECRET_WORD.test(detail.name), `diagnostics[${index}].details[${detailIndex}] names a secret`);
      if (isRecord(detail) && typeof detail.value === "string") add(errors, !SECRET_WORD.test(detail.value), `diagnostics[${index}].details[${detailIndex}] contains a secret`);
    });
  } else if (diagnostic.details !== undefined) {
    errors.push(`diagnostics[${index}].details must be an array`);
  }
}

export function validateOperationsManifest(value: unknown): ManifestValidationResult {
  const errors: string[] = [];
  if (!isRecord(value)) return { valid: false, errors: ["manifest must be an object"] };
  add(errors, value.format === OPERATIONS_MANIFEST_FORMAT, "format is unsupported");
  add(errors, value.version === OPERATIONS_MANIFEST_VERSION, "version is unsupported");
  add(errors, typeof value.operationId === "string" && ID.test(value.operationId), "operationId is invalid");
  add(errors, typeof value.generatedAt === "string" && !Number.isNaN(Date.parse(value.generatedAt)), "generatedAt is invalid");

  const migration = value.migration;
  if (!isRecord(migration)) errors.push("migration is required");
  else {
    add(errors, typeof migration.fromFormat === "string" && migration.fromFormat.length > 0, "migration.fromFormat is invalid");
    add(errors, typeof migration.toFormat === "string" && migration.toFormat.length > 0, "migration.toFormat is invalid");
    add(errors, ["backward", "forward", "bidirectional", "none"].includes(String(migration.compatibility)), "migration.compatibility is invalid");
    if (!Array.isArray(migration.steps)) errors.push("migration.steps must be an array");
    else {
      let previous = 0;
      migration.steps.forEach((step, index) => {
        if (!isRecord(step)) { errors.push(`migration.steps[${index}] must be an object`); return; }
        add(errors, typeof step.id === "string" && ID.test(step.id), `migration.steps[${index}].id is invalid`);
        add(errors, positiveInteger(step.order) && step.order > previous, `migration.steps[${index}].order is not increasing`);
        if (typeof step.order === "number") previous = step.order;
        add(errors, ["schema", "data", "custom"].includes(String(step.kind)), `migration.steps[${index}].kind is invalid`);
        add(errors, typeof step.description === "string" && step.description.length > 0, `migration.steps[${index}].description is invalid`);
        add(errors, typeof step.checksum === "string" && CHECKSUM.test(step.checksum), `migration.steps[${index}].checksum is invalid`);
        add(errors, typeof step.reversible === "boolean", `migration.steps[${index}].reversible is invalid`);
        if (step.requiresManualIntervention === true) add(errors, isRecord(step.manualIntervention), `migration.steps[${index}] requires manual intervention details`);
        if (isRecord(step.manualIntervention)) {
          add(errors, typeof step.manualIntervention.reason === "string" && step.manualIntervention.reason.length > 0, `migration.steps[${index}].manualIntervention.reason is invalid`);
          add(errors, typeof step.manualIntervention.instructions === "string" && step.manualIntervention.instructions.length > 0, `migration.steps[${index}].manualIntervention.instructions is invalid`);
        }
      });
    }
  }

  const backup = value.backup;
  if (!isRecord(backup) || !Array.isArray(backup.artifacts)) errors.push("backup.artifacts must be an array");
  else backup.artifacts.forEach((artifact, index) => {
    if (!isRecord(artifact)) { errors.push(`backup.artifacts[${index}] must be an object`); return; }
    add(errors, typeof artifact.id === "string" && ID.test(artifact.id), `backup.artifacts[${index}].id is invalid`);
    add(errors, ["configuration", "database", "filesystem", "index", "metadata", "transcript"].includes(String(artifact.class)), `backup.artifacts[${index}].class is invalid`);
    add(errors, typeof artifact.path === "string" && !SECRET_WORD.test(artifact.path), `backup.artifacts[${index}] may not contain secrets`);
    add(errors, typeof artifact.mediaType === "string" && !SECRET_WORD.test(artifact.mediaType), `backup.artifacts[${index}].mediaType is invalid`);
    add(errors, typeof artifact.sizeBytes === "number" && Number.isSafeInteger(artifact.sizeBytes) && artifact.sizeBytes >= 0, `backup.artifacts[${index}].sizeBytes is invalid`);
    add(errors, typeof artifact.checksum === "string" && CHECKSUM.test(artifact.checksum), `backup.artifacts[${index}].checksum is invalid`);
    add(errors, artifact.encrypted === true, `backup.artifacts[${index}] must be encrypted`);
  });

  const restore = value.restore;
  if (!isRecord(restore)) errors.push("restore is required");
  else {
    add(errors, ["merge", "replace", "rebuild"].includes(String(restore.mode)), "restore.mode is invalid");
    add(errors, typeof restore.dryRun === "boolean", "restore.dryRun is invalid");
    add(errors, typeof restore.overwrite === "boolean", "restore.overwrite is invalid");
    add(errors, typeof restore.requiresApproval === "boolean", "restore.requiresApproval is invalid");
    if (restore.requiresApproval) add(errors, typeof restore.approvalId === "string" && ID.test(restore.approvalId), "restore.approvalId is required");
  }

  const retention = value.retention;
  if (!isRecord(retention)) errors.push("retention is required");
  else {
    add(errors, ["active", "archive", "expired", "tombstone"].includes(String(retention.category)), "retention.category is invalid");
    add(errors, positiveInteger(retention.retainForSeconds), "retention.retainForSeconds is invalid");
    add(errors, typeof retention.tombstones === "boolean", "retention.tombstones is invalid");
    if (retention.tombstoneAfterSeconds !== undefined) add(errors, positiveInteger(retention.tombstoneAfterSeconds), "retention.tombstoneAfterSeconds is invalid");
  }

  const limits = value.limits;
  if (!isRecord(limits)) errors.push("limits are required");
  else for (const field of ["maxArtifacts", "maxArtifactBytes", "maxTotalBytes", "maxMigrationSteps", "maxDiagnosticEntries"]) add(errors, positiveInteger(limits[field]), `limits.${field} is invalid`);
  if (isRecord(limits) && isRecord(backup) && Array.isArray(backup.artifacts)) {
    add(errors, backup.artifacts.length <= Number(limits.maxArtifacts), "backup artifacts exceed maxArtifacts");
    add(errors, backup.artifacts.every((artifact) => isRecord(artifact) && Number(artifact.sizeBytes) <= Number(limits.maxArtifactBytes)), "an artifact exceeds maxArtifactBytes");
    const totalBytes = backup.artifacts.reduce((total, artifact) => total + (isRecord(artifact) && typeof artifact.sizeBytes === "number" ? artifact.sizeBytes : 0), 0);
    add(errors, totalBytes <= Number(limits.maxTotalBytes), "artifacts exceed maxTotalBytes");
  }
  if (isRecord(limits) && isRecord(migration) && Array.isArray(migration.steps)) add(errors, migration.steps.length <= Number(limits.maxMigrationSteps), "migration steps exceed maxMigrationSteps");
  const truncation = value.truncation;
  if (!isRecord(truncation)) errors.push("truncation is required");
  else { add(errors, positiveInteger(truncation.maxBytes), "truncation.maxBytes is invalid"); add(errors, typeof truncation.marker === "string" && truncation.marker.length > 0, "truncation.marker is invalid"); }
  const timeouts = value.timeouts;
  if (!isRecord(timeouts)) errors.push("timeouts are required");
  else for (const field of ["migrationSeconds", "backupSeconds", "restoreSeconds"]) add(errors, positiveInteger(timeouts[field]), `timeouts.${field} is invalid`);
  if (!Array.isArray(value.diagnostics)) errors.push("diagnostics must be an array");
  else value.diagnostics.forEach((diagnostic, index) => validateDiagnostic(diagnostic, index, errors));
  if (isRecord(limits) && Array.isArray(value.diagnostics)) add(errors, value.diagnostics.length <= Number(limits.maxDiagnosticEntries), "diagnostics exceed maxDiagnosticEntries");
  return { valid: errors.length === 0, errors };
}

export function stableSerialize(value: unknown): string {
  const seen = new Set<object>();
  const encode = (item: unknown): string => {
    if (item === null || typeof item === "string" || typeof item === "boolean") return JSON.stringify(item);
    if (typeof item === "number") { if (!Number.isFinite(item)) throw new TypeError("stable serialization requires finite numbers"); return JSON.stringify(item); }
    if (typeof item !== "object") throw new TypeError("stable serialization only supports JSON values");
    if (seen.has(item)) throw new TypeError("stable serialization does not support cycles");
    seen.add(item);
    let result: string;
    if (Array.isArray(item)) result = `[${item.map(encode).join(",")}]`;
    else result = `{${Object.keys(item).sort().map((key) => `${JSON.stringify(key)}:${encode((item as Record<string, unknown>)[key])}`).join(",")}}`;
    seen.delete(item);
    return result;
  };
  return encode(value);
}

export function serializeOperationsManifest(manifest: OperationsManifest): string {
  const result = validateOperationsManifest(manifest);
  if (!result.valid) throw new TypeError(`invalid operations manifest: ${result.errors.join("; ")}`);
  return stableSerialize(manifest);
}
