#!/usr/bin/env bun

import {
  createLegacyMigrationBundle,
  writeLegacyMigrationBundle,
  type LegacyFileName,
} from "./index.ts";

const inputFlags: Readonly<Record<string, LegacyFileName>> = {
  "--projects": "projects.json",
  "--tools": "tools.json",
  "--settings": "settings.json",
  "--profiles": "agent-profiles.json",
  "--sessions": ".sessions.json",
};

export interface MigrationCliIo {
  readonly stdout?: (text: string) => void;
  readonly stderr?: (text: string) => void;
}

const usage = `Usage: bun packages/subpolar-migration/src/cli.ts --output-root DIR [inputs]

Inputs (at least one):
  --projects FILE  Legacy projects.json
  --tools FILE     Legacy tools.json
  --settings FILE  Legacy settings.json
  --profiles FILE  Operator-exported agent-profiles.json
  --sessions FILE  Legacy .sessions.json (counted, never imported)

The command writes a review bundle to a new deterministic subdirectory under
DIR. It never modifies the input files, imports credentials, or overwrites an
existing destination.
`;

export async function runMigrationCli(
  argv: readonly string[],
  io: MigrationCliIo = {},
): Promise<number> {
  const stdout = io.stdout ?? ((text: string) => process.stdout.write(text));
  const stderr = io.stderr ?? ((text: string) => process.stderr.write(text));
  const files: Partial<Record<LegacyFileName, string>> = {};
  let outputRoot: string | undefined;
  try {
    for (let index = 0; index < argv.length; index += 1) {
      const flag = argv[index]!;
      if (flag === "--help" || flag === "-h") {
        stdout(usage);
        return 0;
      }
      const file = inputFlags[flag];
      if (file) {
        const value = argv[++index]?.trim();
        if (!value) throw new Error(`${flag} requires a file path`);
        files[file] = value;
        continue;
      }
      if (flag === "--output-root") {
        outputRoot = argv[++index]?.trim();
        if (!outputRoot) throw new Error("--output-root requires a directory path");
        continue;
      }
      throw new Error(`Unknown option: ${flag}`);
    }
    if (!outputRoot) throw new Error("--output-root is required");
    if (Object.keys(files).length === 0)
      throw new Error("At least one legacy input file is required");

    const bundle = await createLegacyMigrationBundle({ files });
    const path = await writeLegacyMigrationBundle(bundle, outputRoot);
    stdout(
      `${JSON.stringify({
        ok: true,
        migrationId: bundle.migrationId,
        path,
        imported: {
          projects: bundle.imported.projects?.length ?? 0,
          tools: bundle.imported.tools?.length ?? 0,
          profiles: bundle.imported.profiles?.length ?? 0,
          runtimeSettings: Object.keys(bundle.imported.runtimeSettings ?? {}).length,
        },
        skipped: bundle.skipped,
        warnings: bundle.warnings,
      })}\n`,
    );
    return 0;
  } catch (error) {
    stderr(`${error instanceof Error ? error.message : "Migration staging failed"}\n`);
    return 2;
  }
}

if (import.meta.main) process.exitCode = await runMigrationCli(process.argv.slice(2));
