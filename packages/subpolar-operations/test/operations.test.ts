import { describe, expect, test } from "bun:test";
import { buildOperationsManifest, createBackupArtifacts, createDryRunReport, createManifestReport, restoreBackupArtifacts, serializeManifestReport, verifyMigrationSteps } from "../src/index.ts";
import type { OperationsManifest } from "@subpolar/shared";
import { mkdtemp, mkdir, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const input = {
  operationId: "backup:one", generatedAt: "2026-09-20T00:00:00.000Z",
  migration: { fromFormat: "backup/v1", toFormat: "backup/v2", compatibility: "backward", steps: [] },
  backup: { backupId: "b1", createdAt: "2026-09-20T00:00:00.000Z", artifacts: [{ id: "db", class: "database", path: "backup/db", mediaType: "application/octet-stream", sizeBytes: 10, checksum: `sha256:${"b".repeat(64)}`, createdAt: "2026-09-20T00:00:00.000Z", encrypted: true }] },
  restore: { mode: "merge", dryRun: true, overwrite: false, requiresApproval: false },
  retention: { category: "archive", retainForSeconds: 3600, tombstones: true },
  limits: { maxArtifacts: 10, maxArtifactBytes: 1000, maxTotalBytes: 2000, maxMigrationSteps: 10, maxDiagnosticEntries: 5 },
  truncation: { maxBytes: 500, marker: "[truncated]" }, timeouts: { migrationSeconds: 10, backupSeconds: 20, restoreSeconds: 30 }, diagnostics: [],
} satisfies Omit<OperationsManifest, "format" | "version">;

describe("operations consumer", () => {
  test("emits a validated manifest and stable serialization", () => {
    const manifest = buildOperationsManifest(input);
    expect(createManifestReport(input).valid).toBe(true);
    expect(serializeManifestReport(manifest)).toBe(serializeManifestReport({ ...manifest, limits: { ...manifest.limits } }));
  });

  test("refuses invalid limits and secret-bearing artifacts", () => {
    const invalid = { ...input, limits: { ...input.limits, maxArtifacts: 0 }, backup: { ...input.backup, artifacts: [{ ...input.backup.artifacts[0], path: "backup/token" }] } };
    const report = createManifestReport(invalid);
    expect(report.valid).toBe(false);
    expect(report.errors.join(" ")).not.toContain("token");
    expect(createDryRunReport({ operation: "backup", manifest: invalid }).refusal?.code).toBe("SECRET_BEARING_ARTIFACT");
  });

  test("refuses unsupported migration versions and destructive restore without approval", () => {
    const unsupported = { ...input, migration: { ...input.migration, toFormat: "backup/v9" } };
    expect(createDryRunReport({ operation: "migration", manifest: unsupported }).refusal?.code).toBe("MIGRATION_VERSION_UNSUPPORTED");
    const restore = { ...input, restore: { mode: "replace" as const, dryRun: true, overwrite: true, requiresApproval: true, approvalId: "approval-1" } };
    expect(createDryRunReport({ operation: "restore", manifest: restore }).refusal?.code).toBe("DESTRUCTIVE_RESTORE_APPROVAL_REQUIRED");
    expect(createDryRunReport({ operation: "restore", manifest: restore, approved: true }).performed).toBe(false);
  });

  test("verifies payloads in manifest order without changing the inputs", async () => {
    const manifest = buildOperationsManifest({
      ...input,
      migration: {
        ...input.migration,
        steps: [
          { id: "step-a", order: 1, kind: "data", description: "A", checksum: `sha256:${"ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"}`, reversible: true },
          { id: "step-b", order: 2, kind: "schema", description: "B", checksum: `sha256:${"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"}`, reversible: true },
        ],
      },
    });
    const payloads = new Map([
      ["step-b", new Uint8Array()],
      ["step-a", new TextEncoder().encode("abc")],
    ]);
    const before = Array.from(payloads.entries());

    await expect(verifyMigrationSteps(manifest, payloads)).resolves.toEqual({
      valid: true,
      errors: [],
      results: [
        { id: "step-a", order: 1, valid: true },
        { id: "step-b", order: 2, valid: true },
      ],
    });
    expect(Array.from(payloads.entries())).toEqual(before);
  });

  test("reports stable checksum, missing, and unexpected payload codes", async () => {
    const manifest = buildOperationsManifest({
      ...input,
      migration: {
        ...input.migration,
        steps: [{ id: "step-a", order: 1, kind: "data", description: "A", checksum: `sha256:${"ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"}`, reversible: true }],
      },
    });
    const result = await verifyMigrationSteps(manifest, new Map([
      ["step-a", new TextEncoder().encode("not abc")],
      ["extra", new Uint8Array([1])],
    ]));
    expect(result).toEqual({
      valid: false,
      errors: [
        { code: "CHECKSUM_MISMATCH", id: "step-a" },
        { code: "UNEXPECTED_PAYLOAD", id: "extra" },
      ],
      results: [{ id: "step-a", order: 1, valid: false, code: "CHECKSUM_MISMATCH" }],
    });

    const missing = await verifyMigrationSteps(manifest, new Map());
    expect(missing.errors).toEqual([{ code: "MISSING_PAYLOAD", id: "step-a" }]);
  });

  test("validates the manifest before inspecting payloads", async () => {
    const invalid = { ...input, limits: { ...input.limits, maxArtifacts: 0 } };
    const payloads = new Map([["unexpected", new Uint8Array([1])]]);
    expect(await verifyMigrationSteps(invalid, payloads)).toEqual({
      valid: false,
      errors: [{ code: "INVALID_MANIFEST" }],
      results: [],
    });
  });

  test("backs up and restores deterministic filesystem and memory roots", async () => {
    const root = await mkdtemp(join(tmpdir(), "subpolar-operations-"));
    await mkdir(join(root, "nested"));
    await writeFile(join(root, "nested", "a.txt"), "alpha");
    const backup = await createBackupArtifacts([
      { class: "metadata", root },
      { class: "configuration", root: new Map([["settings.json", new TextEncoder().encode('{"ok":true}')]]) },
    ], { backupId: "backup-1", createdAt: "2026-09-20T00:00:00.000Z", limits: { maxArtifacts: 5, maxArtifactBytes: 100, maxTotalBytes: 200 } });
    const second = await createBackupArtifacts([
      { class: "metadata", root },
      { class: "configuration", root: new Map([["settings.json", new TextEncoder().encode('{"ok":true}')]]) },
    ], { backupId: "backup-1", createdAt: "2026-09-20T00:00:00.000Z", limits: { maxArtifacts: 5, maxArtifactBytes: 100, maxTotalBytes: 200 } });
    expect(serializeManifestReport(backup.archive.manifest)).toBe(serializeManifestReport(second.archive.manifest));
    const target = await mkdtemp(join(tmpdir(), "subpolar-restore-"));
    const result = await restoreBackupArtifacts(backup.archive, { targetRoot: target });
    expect(result.performed).toBe(true);
    expect(await readFile(join(target, "metadata", "nested", "a.txt"), "utf8")).toBe("alpha");
  });

  test("refuses secrets, limits, checksum failures, unsafe paths, and symlinks", async () => {
    const root = await mkdtemp(join(tmpdir(), "subpolar-unsafe-"));
    await writeFile(join(root, "token.txt"), "no");
    await expect(createBackupArtifacts([{ class: "metadata", root }], { backupId: "b", createdAt: input.generatedAt, limits: { maxArtifacts: 2, maxArtifactBytes: 10, maxTotalBytes: 20 } })).rejects.toThrow("secret");
    await expect(createBackupArtifacts([{ class: "metadata", root: new Map([["../escape", new Uint8Array([1])]]) }], { backupId: "b", createdAt: input.generatedAt, limits: { maxArtifacts: 2, maxArtifactBytes: 10, maxTotalBytes: 20 } })).rejects.toThrow("invalid artifact path");
    await expect(createBackupArtifacts([{ class: "metadata", root: new Map([["large", new Uint8Array(11)]]) }], { backupId: "b", createdAt: input.generatedAt, limits: { maxArtifacts: 2, maxArtifactBytes: 10, maxTotalBytes: 20 } })).rejects.toThrow("byte limit");
    const link = join(root, "link.txt");
    await symlink(join(root, "missing"), link);
    await expect(createBackupArtifacts([{ class: "metadata", root }], { backupId: "b", createdAt: input.generatedAt, limits: { maxArtifacts: 10, maxArtifactBytes: 100, maxTotalBytes: 200 } })).rejects.toThrow("symlink");
  });

  test("requires approval for destructive restore and refuses checksum mismatch", async () => {
    const archive = await createBackupArtifacts([{ class: "metadata", root: new Map([["file", new Uint8Array([1, 2, 3])]]) }], { backupId: "b", createdAt: input.generatedAt, limits: { maxArtifacts: 2, maxArtifactBytes: 10, maxTotalBytes: 20 } });
    const target = await mkdtemp(join(tmpdir(), "subpolar-approval-"));
    const overwriteArchive = { ...archive.archive, manifest: { ...archive.archive.manifest, restore: { ...archive.archive.manifest.restore, mode: "replace" as const, overwrite: true, requiresApproval: true, approvalId: "a" } } };
    expect((await restoreBackupArtifacts(overwriteArchive, { targetRoot: target, overwrite: true, dryRun: true })).errors[0].code).toBe("APPROVAL_REQUIRED");
    const approved = await restoreBackupArtifacts(overwriteArchive, { targetRoot: target, overwrite: true, dryRun: true, approved: true });
    expect(approved.performed).toBe(false);
    const broken = new Map(archive.archive.payloads);
    broken.set("artifact-000001", new Uint8Array([9]));
    const checksum = await restoreBackupArtifacts({ ...archive.archive, payloads: broken }, { targetRoot: target });
    expect(checksum.errors[0].code).toBe("CHECKSUM_MISMATCH");
  });

  test("rolls back and cleans staging when a payload fails during restore", async () => {
    const archive = await createBackupArtifacts([{ class: "metadata", root: new Map([
      ["first", new Uint8Array([1])],
      ["second", new Uint8Array([2])],
    ]) }], { backupId: "b", createdAt: input.generatedAt, limits: { maxArtifacts: 3, maxArtifactBytes: 10, maxTotalBytes: 20 } });
    const target = await mkdtemp(join(tmpdir(), "subpolar-atomic-"));
    await writeFile(join(target, "sentinel"), "unchanged");
    let stagingReads = 0;
    const failingPayloads = new Map(archive.archive.payloads);
    const payloads = {
      get: (id: string) => {
        const value = failingPayloads.get(id);
        if (++stagingReads > archive.archive.manifest.backup.artifacts.length + 1) throw new Error("injected payload failure");
        return value;
      },
      has: (id: string) => failingPayloads.has(id),
      entries: () => failingPayloads.entries(),
      keys: () => failingPayloads.keys(),
      values: () => failingPayloads.values(),
      get size() { return failingPayloads.size; },
      [Symbol.iterator]: () => failingPayloads[Symbol.iterator](),
    } as ReadonlyMap<string, Uint8Array>;
    const result = await restoreBackupArtifacts({ ...archive.archive, payloads }, { targetRoot: target });
    expect(result.valid).toBe(false);
    expect(await readFile(join(target, "sentinel"), "utf8")).toBe("unchanged");
    expect(await readdir(target)).toEqual(["sentinel"]);
    expect((await readdir(dirname(target))).filter((name) => name.startsWith(".subpolar-restore-"))).toEqual([]);
  });
});
