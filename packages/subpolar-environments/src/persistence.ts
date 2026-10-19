// @effect-diagnostics nodeBuiltinImport:off globalTimers:off -- Persistence uses atomic native filesystem operations outside Effect.
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import type {
  EnvironmentRegistration,
  EnvironmentRegistrationStore,
  EnvironmentStatus,
  ManagedEnvironment,
} from "./index.ts";

const FORMAT_VERSION = 1;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const ENVIRONMENT_STATUSES = new Set<EnvironmentStatus>([
  "creating",
  "starting",
  "ready",
  "stopping",
  "stopped",
  "failed",
]);

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && !value.includes("\0");
}

function parseRegistration(value: unknown): EnvironmentRegistration | undefined {
  if (!isRecord(value) || !isRecord(value.environment)) return undefined;
  const environment = value.environment;
  const status = environment.status;
  if (
    !isNonEmptyString(environment.id) ||
    !isNonEmptyString(environment.ownerId) ||
    !isNonEmptyString(environment.workspaceId) ||
    !isNonEmptyString(environment.storageRoot) ||
    !path.isAbsolute(environment.storageRoot) ||
    !isNonEmptyString(environment.worktreePath) ||
    !path.isAbsolute(environment.worktreePath) ||
    !isNonEmptyString(environment.backendId) ||
    !isNonEmptyString(environment.resourceId) ||
    typeof status !== "string" ||
    !ENVIRONMENT_STATUSES.has(status as EnvironmentStatus) ||
    (environment.forwardedPorts !== undefined &&
      (!Array.isArray(environment.forwardedPorts) ||
        environment.forwardedPorts.some(
          (port) => !Number.isInteger(port) || (port as number) < 1 || (port as number) > 65535,
        ))) ||
    !isNonEmptyString(value.createdAt) ||
    !isNonEmptyString(value.updatedAt)
  )
    return undefined;
  const managedEnvironment: ManagedEnvironment = {
    id: environment.id,
    ownerId: environment.ownerId,
    workspaceId: environment.workspaceId,
    storageRoot: environment.storageRoot,
    worktreePath: environment.worktreePath,
    backendId: environment.backendId,
    resourceId: environment.resourceId,
    status: status as EnvironmentStatus,
    ...(environment.forwardedPorts === undefined
      ? {}
      : { forwardedPorts: [...environment.forwardedPorts] as number[] }),
  };
  return {
    environment: managedEnvironment,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  };
}

const LOCK_WAIT_MS = 30_000;

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !isRecord(error) || error.code !== "ESRCH";
  }
}

async function acquireFileLock(lockPath: string): Promise<() => Promise<void>> {
  const token = randomUUID();
  const ownerPath = path.join(lockPath, "owner.json");
  const deadline = performance.now() + LOCK_WAIT_MS;

  while (true) {
    const stagingPath = lockPath + ".pending-" + token;
    let ownsStagingPath = false;
    try {
      // Publish only after the complete owner marker exists. Creating the
      // lock directory directly leaves a crash window where waiters can see
      // a lock that has no owner to inspect or reclaim.
      await mkdir(stagingPath, { mode: 0o700 });
      ownsStagingPath = true;
      await writeFile(
        path.join(stagingPath, "owner.json"),
        JSON.stringify({ pid: process.pid, token }),
        {
          encoding: "utf8",
          mode: 0o600,
          flag: "wx",
        },
      );
      await rename(stagingPath, lockPath);
      return async () => {
        try {
          const owner: unknown = JSON.parse(await readFile(ownerPath, "utf8"));
          if (isRecord(owner) && owner.token === token) {
            await rm(lockPath, { recursive: true, force: true });
          }
        } catch (error) {
          if (!isRecord(error) || error.code !== "ENOENT") throw error;
        }
      };
    } catch (error) {
      if (ownsStagingPath) await rm(stagingPath, { recursive: true, force: true });
      if (!isRecord(error) || (error.code !== "EEXIST" && error.code !== "ENOTEMPTY")) throw error;
    }

    // Reclaim only a lock whose recorded owner is provably gone. Rename first
    // so two waiters cannot both remove a newly acquired lock at the same path.
    try {
      const ownerText = await readFile(ownerPath, "utf8");
      let owner: unknown;
      try {
        owner = JSON.parse(ownerText);
      } catch (error) {
        // The marker is written just after the lock directory is created, so
        // another process can observe it before its contents are complete.
        // Keep waiting; malformed markers are never safe to reclaim.
        if (!(error instanceof SyntaxError)) throw error;
      }
      if (
        isRecord(owner) &&
        Number.isInteger(owner.pid) &&
        (owner.pid as number) > 0 &&
        !isProcessAlive(owner.pid as number)
      ) {
        const abandonedPath = `${lockPath}.abandoned-${randomUUID()}`;
        try {
          await rename(lockPath, abandonedPath);
          await rm(abandonedPath, { recursive: true, force: true });
          continue;
        } catch (error) {
          if (!isRecord(error) || error.code !== "ENOENT") throw error;
        }
      }
    } catch (error) {
      // A lock directory may be visible before its owner marker is written.
      // Wait for that short window; malformed markers are not safe to reclaim.
      if (!isRecord(error) || error.code !== "ENOENT" || performance.now() >= deadline) {
        if (!isRecord(error) || error.code !== "ENOENT") throw error;
      }
    }

    if (performance.now() >= deadline)
      throw new Error("Timed out waiting for environment registration file lock");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/**
 * Small local registration store for a manager process. It persists only
 * environment metadata; worktree contents and credentials remain elsewhere.
 */
export function createFileEnvironmentRegistrationStore(
  filePath: string,
): EnvironmentRegistrationStore {
  if (!path.isAbsolute(filePath)) throw new Error("Environment registration path must be absolute");
  const target = path.resolve(filePath);
  let pendingWrite: Promise<void> = Promise.resolve();

  const loadDocument = async (): Promise<Map<string, EnvironmentRegistration>> => {
    try {
      const parsed: unknown = JSON.parse(await readFile(target, "utf8"));
      if (
        !isRecord(parsed) ||
        parsed.version !== FORMAT_VERSION ||
        !Array.isArray(parsed.registrations)
      ) {
        throw new Error("Environment registration file has an unsupported format");
      }
      const registrations = new Map<string, EnvironmentRegistration>();
      for (const entry of parsed.registrations) {
        const registration = parseRegistration(entry);
        if (!registration || registrations.has(registration.environment.id)) {
          throw new Error("Environment registration file contains an invalid or duplicate record");
        }
        registrations.set(registration.environment.id, registration);
      }
      return registrations;
    } catch (error) {
      if (isRecord(error) && error.code === "ENOENT") return new Map();
      throw error;
    }
  };

  const serializeWrite = (operation: () => Promise<void>): Promise<void> => {
    const next = pendingWrite.then(operation, operation);
    pendingWrite = next.catch(() => undefined);
    return next;
  };

  const withFileLock = async (operation: () => Promise<void>): Promise<void> => {
    await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    const release = await acquireFileLock(`${target}.lock`);
    try {
      await operation();
    } finally {
      await release();
    }
  };

  const flush = async (registrations: Map<string, EnvironmentRegistration>): Promise<void> => {
    await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    const temporary = `${target}.${randomUUID()}.tmp`;
    try {
      await writeFile(
        temporary,
        `${JSON.stringify({ version: FORMAT_VERSION, registrations: [...registrations.values()] }, null, 2)}\n`,
        {
          encoding: "utf8",
          mode: 0o600,
          flag: "wx",
        },
      );
      await rename(temporary, target);
    } finally {
      await rm(temporary, { force: true });
    }
  };

  return {
    async loadAll() {
      await pendingWrite;
      return [...(await loadDocument()).values()];
    },
    async save(environment, createdAt, updatedAt) {
      return serializeWrite(() =>
        withFileLock(async () => {
          const registrations = await loadDocument();
          const prior = registrations.get(environment.id);
          registrations.set(environment.id, {
            environment,
            createdAt: prior?.createdAt ?? createdAt,
            updatedAt,
          });
          await flush(registrations);
        }),
      );
    },
    async remove(environmentId) {
      return serializeWrite(() =>
        withFileLock(async () => {
          const registrations = await loadDocument();
          registrations.delete(environmentId);
          await flush(registrations);
        }),
      );
    },
  };
}
