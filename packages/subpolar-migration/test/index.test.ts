import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "bun:test";
import { createLegacyMigrationBundle, writeLegacyMigrationBundle } from "../src/index.ts";

async function fixture(files: Record<string, string>) {
  const root = await mkdtemp(join(tmpdir(), "subpolar-migration-"));
  for (const [name, contents] of Object.entries(files)) await writeFile(join(root, name), contents);
  return root;
}

describe("legacy migration staging", () => {
  it("normalizes known config, skips secrets and sessions, and is repeatable", async () => {
    const root = await fixture({
      "projects.json": JSON.stringify({ apps: "./apps" }),
      "tools.json": JSON.stringify({
        search: {
          baseUrl: "https://search.example",
          openapi: "./search.yaml",
          headers: { Authorization: { env: "SEARCH_KEY" }, "X-Literal": "secret-value" },
        },
        inline: { baseUrl: "https://inline.example", openapi: "openapi: 3.1.0\npaths: {}" },
      }),
      "settings.json": JSON.stringify({
        defaultModel: "provider/model",
        extensions: ["unsafe-path"],
        gitCredentials: [{ token: "do-not-copy" }],
      }),
      "agent-profiles.json": JSON.stringify([
        { id: "coder", name: "Coder", model: "provider/model", toolPolicies: { shell: "allow" } },
      ]),
      ".sessions.json": JSON.stringify([
        { id: "private-session-id", title: "private conversation" },
      ]),
    });
    try {
      const bundle = await createLegacyMigrationBundle(
        {
          files: {
            "projects.json": join(root, "projects.json"),
            "tools.json": join(root, "tools.json"),
            "settings.json": join(root, "settings.json"),
            "agent-profiles.json": join(root, "agent-profiles.json"),
            ".sessions.json": join(root, ".sessions.json"),
          },
        },
        () => new Date("2026-01-01T00:00:00.000Z"),
      );
      expect(bundle.imported.projects?.[0]?.path).toBe(join(root, "apps"));
      expect(bundle.imported.tools).toEqual([
        {
          name: "search",
          baseUrl: "https://search.example",
          openapi: "./search.yaml",
          headers: { Authorization: { env: "SEARCH_KEY" } },
        },
      ]);
      expect(bundle.imported.runtimeSettings).toEqual({ defaultModel: "provider/model" });
      expect(bundle.imported.profiles).toEqual([
        { id: "coder", name: "Coder", model: "provider/model" },
      ]);
      expect(bundle.skipped).toMatchObject({
        credentials: 1,
        conversations: 0,
        sessionReferences: 1,
        inlineOpenApi: 1,
        literalOrInvalidSecrets: 1,
      });
      const output = await writeLegacyMigrationBundle(bundle, join(root, "out"));
      expect(await writeLegacyMigrationBundle(bundle, join(root, "out"))).toBe(output);
      const saved = await readFile(output, "utf8");
      expect(saved).not.toContain("do-not-copy");
      expect(saved).not.toContain("private-session-id");
      expect(saved).not.toContain("private conversation");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects malformed input without writing a partial bundle", async () => {
    const root = await fixture({ "projects.json": "[]" });
    try {
      await expect(
        createLegacyMigrationBundle({ files: { "projects.json": join(root, "projects.json") } }),
      ).rejects.toThrow("projects.json must contain an object");
      expect(await readFile(join(root, "projects.json"), "utf8")).toBe("[]");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not overwrite a colliding migration destination", async () => {
    const root = await fixture({ "settings.json": JSON.stringify({ defaultModel: "model-a" }) });
    try {
      const first = await createLegacyMigrationBundle({
        files: { "settings.json": join(root, "settings.json") },
      });
      const path = await writeLegacyMigrationBundle(first, join(root, "out"));
      const modified = { ...first, imported: { runtimeSettings: { defaultModel: "different" } } };
      await expect(writeLegacyMigrationBundle(modified, join(root, "out"))).rejects.toThrow(
        "Migration destination exists with different content",
      );
      expect(await readFile(path, "utf8")).toContain('"createdAt"');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
