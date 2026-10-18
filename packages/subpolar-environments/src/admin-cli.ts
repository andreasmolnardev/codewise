#!/usr/bin/env bun

import { createHash } from "node:crypto";
import path from "node:path";
import { createEnvironmentManagerHttpClient } from "./manager-client.ts";
import type { EnvironmentRegistration, EnvironmentRequest } from "./index.ts";

export interface AdminCliIo {
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
}

export interface AdminCliDependencies {
  readonly environment?: NodeJS.ProcessEnv;
  readonly fetch?: typeof fetch;
  readonly io?: AdminCliIo;
}

const defaultIo: AdminCliIo = {
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
};

const usage = `Usage:
  subpolar status [--json]
  subpolar environments list [--owner-id ID] [--json]
  subpolar environments inspect WORKTREE [--json]
  subpolar environments start|stop|restart|remove|rebuild WORKTREE [--json]
  subpolar environments reconcile [--json]

Configuration comes from SUBPOLAR_MANAGER_URL, SUBPOLAR_MANAGER_TOKEN,
SUBPOLAR_STORAGE_ROOT, and optionally SUBPOLAR_OWNER_ID.
`;

class CliUsageError extends Error {}

function splitFlags(argv: readonly string[]): { args: string[]; json: boolean; ownerId?: string } {
  const args: string[] = [];
  let json = false;
  let ownerId: string | undefined;
  for (let index = 0; index < argv.length; index++) {
    const value = argv[index]!;
    if (value === "--json") json = true;
    else if (value === "--owner-id") {
      const next = argv[++index];
      if (!next?.trim()) throw new CliUsageError("--owner-id requires a value");
      ownerId = next;
    } else if (value.startsWith("--owner-id=")) {
      ownerId = value.slice("--owner-id=".length);
      if (!ownerId.trim()) throw new CliUsageError("--owner-id requires a value");
    } else if (value.startsWith("-")) throw new CliUsageError(`Unknown option: ${value}`);
    else args.push(value);
  }
  return { args, json, ...(ownerId === undefined ? {} : { ownerId }) };
}

function requiredEnvironment(environment: NodeJS.ProcessEnv, key: string): string {
  const value = environment[key]?.trim();
  if (!value) throw new CliUsageError(`${key} is required`);
  return value;
}

function requestFor(worktree: string, environment: NodeJS.ProcessEnv, ownerId?: string): EnvironmentRequest {
  const storageRoot = requiredEnvironment(environment, "SUBPOLAR_STORAGE_ROOT");
  const resolvedRoot = path.resolve(storageRoot);
  const resolvedWorktree = path.resolve(worktree);
  const workspaceId = `ws_${createHash("sha256").update(resolvedWorktree).digest("hex").slice(0, 24)}`;
  return {
    ownerId: ownerId ?? environment.SUBPOLAR_OWNER_ID?.trim() ?? "t3-installation",
    workspaceId,
    storageRoot: resolvedRoot,
    worktreePath: resolvedWorktree,
  };
}

function environmentClient(environment: NodeJS.ProcessEnv, fetcher?: typeof fetch) {
  return createEnvironmentManagerHttpClient({
    baseUrl: requiredEnvironment(environment, "SUBPOLAR_MANAGER_URL"),
    token: requiredEnvironment(environment, "SUBPOLAR_MANAGER_TOKEN"),
    allowPrivateHttp: environment.SUBPOLAR_MANAGER_ALLOW_PRIVATE_HTTP === "true",
    ...(fetcher === undefined ? {} : { fetch: fetcher }),
  });
}

function print(io: AdminCliIo, json: boolean, value: unknown, text: string): void {
  io.stdout(json ? `${JSON.stringify(value, null, 2)}\n` : `${text}\n`);
}

function renderEnvironment(environment: EnvironmentRegistration["environment"]): string {
  return `${environment.status}\t${environment.worktreePath}\t${environment.id}`;
}

function validatePathArgument(args: readonly string[]): string {
  if (args.length !== 1 || !args[0]?.trim()) throw new CliUsageError("Provide exactly one worktree path");
  return args[0];
}

export async function runAdminCli(argv: readonly string[], dependencies: AdminCliDependencies = {}): Promise<number> {
  const environment = dependencies.environment ?? process.env;
  const io = dependencies.io ?? defaultIo;
  try {
    const parsed = splitFlags(argv);
    const [group, command, ...rest] = parsed.args;
    if (group === "--help" || group === "help" || group === undefined) {
      io.stdout(usage);
      return 0;
    }
    const client = environmentClient(environment, dependencies.fetch);
    if (group === "status" && command === undefined) {
      const status = await client.status!();
      print(io, parsed.json, status, `Environment manager ready; ${status.registeredEnvironmentCount} registered environment(s)`);
      return 0;
    }
    if (group !== "environments" || command === undefined) throw new CliUsageError("Unknown command");

    if (command === "list") {
      if (rest.length > 0) throw new CliUsageError("environments list does not accept positional arguments");
      const entries = await client.list!(parsed.ownerId ?? environment.SUBPOLAR_OWNER_ID?.trim());
      const value = { environments: entries };
      print(io, parsed.json, value, entries.length ? entries.map((entry) => renderEnvironment(entry.environment)).join("\n") : "No registered environments");
      return 0;
    }
    if (command === "reconcile") {
      if (rest.length > 0) throw new CliUsageError("environments reconcile does not accept positional arguments");
      const results = await client.reconcile();
      const failed = results.filter((result) => result.error !== undefined).length;
      print(io, parsed.json, { results, failed }, `${results.length} environment(s) reconciled; ${failed} failed`);
      return failed === 0 ? 0 : 1;
    }

    const worktree = validatePathArgument(rest);
    const request = requestFor(worktree, environment, parsed.ownerId);
    if (command === "inspect") {
      const result = await client.inspect!(request);
      if (!result) {
        io.stderr(`No environment exists for ${request.worktreePath}\n`);
        return 4;
      }
      print(io, parsed.json, result, renderEnvironment(result));
      return 0;
    }
    if (command === "start") {
      const result = await client.start(request);
      print(io, parsed.json, result, renderEnvironment(result));
      return 0;
    }
    if (command === "stop") {
      const result = await client.stop(request);
      print(io, parsed.json, result, renderEnvironment(result));
      return 0;
    }
    if (command === "restart") {
      const result = await client.restart!(request);
      print(io, parsed.json, result, renderEnvironment(result));
      return 0;
    }
    if (command === "remove") {
      await client.remove(request);
      print(io, parsed.json, { removed: true, worktreePath: request.worktreePath }, `Removed environment for ${request.worktreePath}`);
      return 0;
    }
    if (command === "rebuild") {
      const result = await client.rebuild!(request);
      print(io, parsed.json, result, renderEnvironment(result));
      return 0;
    }
    throw new CliUsageError(`Unknown environment command: ${command}`);
  } catch (error) {
    if (error instanceof CliUsageError) {
      io.stderr(`${error.message}\n${usage}`);
      return 2;
    }
    io.stderr(`Subpolar environment command failed: ${error instanceof Error ? error.message : "unknown error"}\n`);
    return 1;
  }
}

if (import.meta.main) {
  process.exitCode = await runAdminCli(process.argv.slice(2));
}
