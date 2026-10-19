import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

export type LegacyFileName =
  | "projects.json"
  | "tools.json"
  | "settings.json"
  | "agent-profiles.json"
  | ".sessions.json";

export interface LegacyMigrationInput {
  readonly files: Readonly<Partial<Record<LegacyFileName, string>>>;
}

export interface LegacyMigrationBundle {
  readonly format: "subpolar-migration-v1";
  readonly migrationId: string;
  readonly createdAt: string;
  readonly sourceHashes: Readonly<Partial<Record<LegacyFileName, string>>>;
  readonly imported: {
    readonly projects?: readonly { readonly name: string; readonly path: string }[];
    readonly tools?: readonly SafeToolDefinition[];
    readonly runtimeSettings?: Readonly<Record<string, string>>;
    readonly profiles?: readonly SafeProfile[];
  };
  readonly skipped: Readonly<Record<string, number>>;
  readonly warnings: readonly string[];
}

export interface SafeToolDefinition {
  readonly name: string;
  readonly baseUrl: string;
  readonly openapi?: string;
  readonly operations?: readonly string[];
  readonly headers?: Readonly<Record<string, { readonly env: string }>>;
}

export interface SafeProfile {
  readonly id: string;
  readonly name: string;
  readonly model?: string;
  readonly thinkingLevel?: string;
  readonly instructions?: string;
  readonly allowedToolIds?: readonly string[];
}

const safeSettingKeys = ["defaultModel", "sessionTitleGenModel"] as const;
const envName = /^[A-Za-z_][A-Za-z0-9_]*$/;

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function string(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function hash(bytes: string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function parseJson(file: LegacyFileName, bytes: string): unknown {
  try {
    return JSON.parse(bytes) as unknown;
  } catch {
    throw new Error(`Invalid JSON in ${file}`);
  }
}

function parseProjects(value: unknown, configPath: string): { name: string; path: string }[] {
  const root = object(value);
  if (!root) throw new Error("projects.json must contain an object");
  const entries = object(root.projects) ?? root;
  const projects: { name: string; path: string }[] = [];
  for (const [name, raw] of Object.entries(entries)) {
    const path = typeof raw === "string" ? raw : string(object(raw)?.path);
    if (!name.trim() || !path) throw new Error(`Invalid project entry: ${name}`);
    projects.push({ name, path: resolve(dirname(configPath), path) });
  }
  return projects;
}

function parseTools(value: unknown, skipped: Record<string, number>): SafeToolDefinition[] {
  const root = object(value);
  if (!root) throw new Error("tools.json must contain an object");
  const tools: SafeToolDefinition[] = [];
  for (const [name, raw] of Object.entries(root)) {
    const record = object(raw);
    const baseUrl = string(record?.baseUrl);
    if (!record || !baseUrl || !/^https?:\/\//i.test(baseUrl)) {
      throw new Error(`Invalid tool definition: ${name}`);
    }
    if (typeof record.openapi === "string" && record.openapi.includes("\n")) {
      skipped.inlineOpenApi = (skipped.inlineOpenApi ?? 0) + 1;
      continue;
    }
    const headers: Record<string, { env: string }> = {};
    const rawHeaders = object(record.headers);
    if (rawHeaders) {
      for (const [header, rawValue] of Object.entries(rawHeaders)) {
        const env = string(object(rawValue)?.env);
        if (env && envName.test(env)) headers[header] = { env };
        else skipped.literalOrInvalidSecrets = (skipped.literalOrInvalidSecrets ?? 0) + 1;
      }
    }
    const operations = Array.isArray(record.operations)
      ? record.operations.filter((item): item is string => typeof item === "string")
      : undefined;
    tools.push({
      name,
      baseUrl,
      ...(string(record.openapi) ? { openapi: string(record.openapi) } : {}),
      ...(operations ? { operations } : {}),
      ...(Object.keys(headers).length ? { headers } : {}),
    });
    if (record.skipTlsVerify === true)
      skipped.unsafeTlsOverrides = (skipped.unsafeTlsOverrides ?? 0) + 1;
  }
  return tools;
}

function parseProfiles(value: unknown): SafeProfile[] {
  if (!Array.isArray(value)) throw new Error("agent-profiles.json must contain an array");
  return value.map((raw, index) => {
    const profile = object(raw);
    const id = string(profile?.id);
    const name = string(profile?.name);
    if (!profile || !id || !name) throw new Error(`Invalid profile at index ${index}`);
    const allowedToolIds = Array.isArray(profile.allowedToolIds)
      ? profile.allowedToolIds.filter((item): item is string => typeof item === "string")
      : undefined;
    return {
      id,
      name,
      ...(string(profile.model) ? { model: string(profile.model) } : {}),
      ...(string(profile.thinkingLevel) ? { thinkingLevel: string(profile.thinkingLevel) } : {}),
      ...(string(profile.instructions) ? { instructions: string(profile.instructions) } : {}),
      ...(allowedToolIds ? { allowedToolIds } : {}),
    };
  });
}

/** Build a review bundle without changing any legacy source or target configuration. */
export async function createLegacyMigrationBundle(
  input: LegacyMigrationInput,
  now: () => Date = () => new Date(),
): Promise<LegacyMigrationBundle> {
  const sourceHashes: Partial<Record<LegacyFileName, string>> = {};
  const parsed = new Map<LegacyFileName, unknown>();
  for (const [file, path] of Object.entries(input.files) as [LegacyFileName, string][]) {
    if (!path) continue;
    const bytes = await readFile(path, "utf8");
    parsed.set(file, parseJson(file, bytes));
  }

  const skipped: Record<string, number> = {};
  const imported: LegacyMigrationBundle["imported"] = {
    ...(parsed.has("projects.json")
      ? { projects: parseProjects(parsed.get("projects.json"), input.files["projects.json"]!) }
      : {}),
    ...(parsed.has("tools.json") ? { tools: parseTools(parsed.get("tools.json"), skipped) } : {}),
    ...(parsed.has("settings.json")
      ? {
          runtimeSettings: Object.fromEntries(
            safeSettingKeys.flatMap((key) => {
              const value = string(object(parsed.get("settings.json"))?.[key]);
              return value ? [[key, value]] : [];
            }),
          ),
        }
      : {}),
    ...(parsed.has("agent-profiles.json")
      ? { profiles: parseProfiles(parsed.get("agent-profiles.json")) }
      : {}),
  };

  if (parsed.has(".sessions.json")) {
    const sessions = parsed.get(".sessions.json");
    if (!Array.isArray(sessions)) throw new Error(".sessions.json must contain an array");
    skipped.sessionReferences = sessions.length;
  }
  const legacySettings = object(parsed.get("settings.json"));
  const legacyGitCredentials = legacySettings?.gitCredentials;
  if (Array.isArray(legacyGitCredentials)) skipped.credentials = legacyGitCredentials.length;
  else if (legacyGitCredentials !== undefined) skipped.credentials = 1;
  skipped.conversations = 0;

  // Hash only the projected, import-safe data. Raw hashes can act as offline
  // guesses for low-entropy credentials embedded in old JSON files.
  if (imported.projects) sourceHashes["projects.json"] = hash(JSON.stringify(imported.projects));
  if (imported.tools) sourceHashes["tools.json"] = hash(JSON.stringify(imported.tools));
  if (imported.runtimeSettings)
    sourceHashes["settings.json"] = hash(JSON.stringify(imported.runtimeSettings));
  if (imported.profiles)
    sourceHashes["agent-profiles.json"] = hash(JSON.stringify(imported.profiles));
  if (parsed.has(".sessions.json"))
    sourceHashes[".sessions.json"] = hash(JSON.stringify({ count: skipped.sessionReferences }));

  const canonical = JSON.stringify({ sourceHashes, imported, skipped });
  return {
    format: "subpolar-migration-v1",
    migrationId: hash(canonical),
    createdAt: now().toISOString(),
    sourceHashes,
    imported,
    skipped,
    warnings: [
      "Credential stores and literal secrets are never migrated; reconnect providers and replace secrets manually.",
      "Conversation transcripts and session references are never imported into T3 threads.",
      "Inline OpenAPI documents require manual review and are omitted from this bundle.",
      "The bundle is a staging artifact; an operator must review and apply supported records explicitly.",
    ],
  };
}

/**
 * Persist a staging bundle under a deterministic new directory. Existing files
 * are never overwritten; an identical prior run is treated as success.
 */
export async function writeLegacyMigrationBundle(
  bundle: LegacyMigrationBundle,
  outputRoot: string,
): Promise<string> {
  const destination = join(resolve(outputRoot), `subpolar-import-${bundle.migrationId}`);
  const file = join(destination, "migration.json");
  const contents = `${JSON.stringify(bundle, null, 2)}\n`;
  try {
    const existing = await readFile(file, "utf8");
    const saved = JSON.parse(existing) as LegacyMigrationBundle;
    if (
      saved.format !== bundle.format ||
      saved.migrationId !== bundle.migrationId ||
      JSON.stringify({ ...saved, createdAt: undefined }) !==
        JSON.stringify({ ...bundle, createdAt: undefined })
    )
      throw new Error("Migration destination exists with different content");
    return file;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await mkdir(resolve(outputRoot), { recursive: true });
  await mkdir(destination, { recursive: false });
  try {
    await writeFile(file, contents, { encoding: "utf8", flag: "wx", mode: 0o600 });
  } catch (error) {
    throw new Error(
      `Could not write migration bundle ${basename(destination)}: ${(error as Error).message}`,
    );
  }
  return file;
}
