import { describe, expect, test } from "bun:test";
import { serializeOperationsManifest, stableSerialize, validateOperationsManifest, type OperationsManifest } from "../src/index.ts";

const manifest: OperationsManifest = {
  format: "operations-manifest/v1", version: 1, operationId: "restore:one", generatedAt: "2026-09-20T00:00:00.000Z",
  migration: { fromFormat: "backup/v1", toFormat: "backup/v2", compatibility: "backward", steps: [{ id: "schema-1", order: 1, kind: "schema", description: "Add index", checksum: `sha256:${"a".repeat(64)}`, reversible: true }] },
  backup: { backupId: "b1", createdAt: "2026-09-20T00:00:00.000Z", artifacts: [{ id: "db", class: "database", path: "backup/db", mediaType: "application/octet-stream", sizeBytes: 10, checksum: `sha256:${"b".repeat(64)}`, createdAt: "2026-09-20T00:00:00.000Z", encrypted: true }] },
  restore: { mode: "replace", dryRun: true, overwrite: false, requiresApproval: true, approvalId: "approval-1" },
  retention: { category: "archive", retainForSeconds: 3600, tombstones: true, tombstoneAfterSeconds: 7200 },
  limits: { maxArtifacts: 10, maxArtifactBytes: 1000, maxTotalBytes: 2000, maxMigrationSteps: 10, maxDiagnosticEntries: 5 },
  truncation: { maxBytes: 500, marker: "[truncated]" }, timeouts: { migrationSeconds: 10, backupSeconds: 20, restoreSeconds: 30 },
  diagnostics: [{ level: "warning", code: "PARTIAL", message: "One item skipped", correlationId: "corr-1", redacted: true, details: [{ kind: "count", name: "skipped", value: 1 }] }],
};

describe("operations manifest contract", () => {
  test("validates migration ordering, approval, limits, and diagnostics", () => {
    expect(validateOperationsManifest(manifest)).toEqual({ valid: true, errors: [] });
    const invalid = structuredClone(manifest);
    invalid.migration.steps = [{ ...invalid.migration.steps[0], order: 2 }, { ...invalid.migration.steps[0], id: "schema-2", order: 2 }];
    invalid.restore = { ...invalid.restore, requiresApproval: true, approvalId: undefined };
    expect(validateOperationsManifest(invalid).valid).toBe(false);
  });

  test("rejects secrets and unredacted diagnostic detail", () => {
    const invalid = structuredClone(manifest);
    invalid.backup.artifacts = [{ ...invalid.backup.artifacts[0], path: "backup/password" }];
    invalid.diagnostics = [{ ...invalid.diagnostics[0], redacted: false, details: [{ kind: "field", name: "token", value: "raw" }] }];
    const result = validateOperationsManifest(invalid);
    expect(result.errors.some((error) => error.includes("secrets"))).toBe(true);
    expect(result.errors.some((error) => error.includes("must be redacted"))).toBe(true);
  });

  test("enforces resource limits and the diagnostic detail allowlist", () => {
    const invalid = structuredClone(manifest);
    invalid.limits = { ...invalid.limits, maxArtifacts: 0, maxMigrationSteps: 1 };
    invalid.migration.steps = [invalid.migration.steps[0], { ...invalid.migration.steps[0], id: "schema-2", order: 2 }];
    invalid.diagnostics = [{ ...invalid.diagnostics[0], details: [{ kind: "raw", value: "data" } as never] }];
    const result = validateOperationsManifest(invalid);
    expect(result.errors.some((error) => error.includes("maxArtifacts"))).toBe(true);
    expect(result.errors.some((error) => error.includes("maxMigrationSteps"))).toBe(true);
    expect(result.errors.some((error) => error.includes("kind is invalid"))).toBe(true);
  });

  test("serializes deterministically and validates before serialization", () => {
    expect(stableSerialize({ z: 1, a: [true, null] })).toBe('{"a":[true,null],"z":1}');
    expect(serializeOperationsManifest({ ...manifest, diagnostics: [] })).toBe(serializeOperationsManifest({ ...manifest, diagnostics: [] }));
    expect(() => serializeOperationsManifest({ ...manifest, version: 2 } as unknown as OperationsManifest)).toThrow("unsupported");
  });
});
