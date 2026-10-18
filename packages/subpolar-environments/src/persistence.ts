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

function parseRegistration(value: unknown): EnvironmentRegistration | undefined {
  if (!isRecord(value) || !isRecord(value.environment)) return undefined;
  const environment = value.environment;
  const status = environment.status;
  if (
    typeof environment.id !== "string" || typeof environment.ownerId !== "string" ||
    typeof environment.workspaceId !== "string" || typeof environment.storageRoot !== "string" ||
    typeof environment.worktreePath !== "string" || typeof environment.backendId !== "string" ||
    typeof environment.resourceId !== "string" ||
    !["creating", "starting", "ready", "stopping", "stopped", "failed"].includes(String(status)) ||
    typeof value.createdAt !== "string" || typeof value.updatedAt !== "string"
  ) return undefined;
  return {
    environment: environment as unknown as ManagedEnvironment & { status: EnvironmentStatus },
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  };
}

/**
 * Small local registration store for a manager process. It persists only
 * environment metadata; worktree contents and credentials remain elsewhere.
 */
export function createFileEnvironmentRegistrationStore(filePath: string): EnvironmentRegistrationStore {
  if (!path.isAbsolute(filePath)) throw new Error("Environment registration path must be absolute");
  const target = path.resolve(filePath);
  let pendingWrite: Promise<void> = Promise.resolve();

  const loadDocument = async (): Promise<Map<string, EnvironmentRegistration>> => {
    try {
      const parsed: unknown = JSON.parse(await readFile(target, "utf8"));
      if (!isRecord(parsed) || parsed.version !== FORMAT_VERSION || !Array.isArray(parsed.registrations)) {
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

  const flush = async (registrations: Map<string, EnvironmentRegistration>): Promise<void> => {
    await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    const temporary = `${target}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify({ version: FORMAT_VERSION, registrations: [...registrations.values()] }, null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o600,
        flag: "wx",
      });
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
      return serializeWrite(async () => {
        const registrations = await loadDocument();
        const prior = registrations.get(environment.id);
        registrations.set(environment.id, {
          environment,
          createdAt: prior?.createdAt ?? createdAt,
          updatedAt,
        });
        await flush(registrations);
      });
    },
    async remove(environmentId) {
      return serializeWrite(async () => {
        const registrations = await loadDocument();
        registrations.delete(environmentId);
        await flush(registrations);
      });
    },
  };
}
