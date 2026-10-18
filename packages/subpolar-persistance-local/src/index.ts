import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type {
  AdapterCapabilities,
  SessionRecord,
  SessionStore,
  SessionTranscriptEntry,
  MemoryRecord,
  MemoryStore,
  Skill,
  SkillRepository,
  CreateSkillInput,
  UpdateSkillInput,
  ListSkillsInput,
  GetSkillInput,
} from "@subpolar/shared";
import { UnsupportedCapabilityError, SkillConflictError, SkillNotFoundError, SkillValidationError, createSkill, updateSkill, listSkills, resolveEffectiveSkills, assertValidSkill, type JsonValue } from "@subpolar/shared";

const ephemeralCapabilities: AdapterCapabilities = {
  adapter: "local-ephemeral",
  durability: "ephemeral",
  supports: {
    "session.persistence": false,
    "event.replay": false,
    "multi-process-concurrency": false,
    "durable-approvals": false,
  },
};

const jsonFileCapabilities: AdapterCapabilities = {
  adapter: "local-json-file",
  durability: "json-file",
  supports: {
    "session.persistence": true,
    "event.replay": false,
    "multi-process-concurrency": false,
    "durable-approvals": false,
    "memory.persistence": false,
  },
};

const skillIdentity = (skill: Pick<Skill, "id" | "scope" | "agentId" | "projectId">): string =>
  JSON.stringify([skill.id, skill.scope, skill.agentId ?? null, skill.projectId ?? null]);

function validatePersistedSkill(value: unknown, location: string): Skill {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Invalid skill record at ${location}`);
  const record = value as Record<string, unknown>;
  const allowed = new Set(["id", "ownerId", "name", "scope", "mode", "version", "metadata", "body", "reference", "agentId", "projectId"]);
  if (Object.keys(record).some((key) => !allowed.has(key))) throw new Error(`Invalid skill record at ${location}`);
  for (const field of ["id", "ownerId", "name", "scope", "mode", "version", "metadata", "body"] as const) {
    if (!(field in record)) throw new Error(`Invalid skill record at ${location}: missing ${field}`);
  }
  try { return structuredClone(assertValidSkill(record as unknown as Skill)); }
  catch (error) { throw new Error(`Invalid skill record at ${location}: ${(error as Error).message}`); }
}

export class LocalSkillRepository implements SkillRepository {
  private readonly records: Skill[] = [];
  private operationQueue: Promise<void> = Promise.resolve();

  constructor(private readonly filePath?: string) {}

  async list(ownerId: string, input: ListSkillsInput = {}): Promise<readonly Skill[]> {
    return this.serialize(async () => {
      const records = await this.read();
      const latest = new Map<string, Skill>();
      for (const skill of records.filter((item) => item.ownerId === ownerId)) latest.set(skillIdentity(skill), skill);
      return listSkills([...latest.values()], input).map((skill) => structuredClone(skill));
    });
  }

  async get(ownerId: string, id: string, input: GetSkillInput = {}): Promise<Skill> {
    return this.serialize(async () => {
      const records = (await this.read()).filter((skill) => skill.ownerId === ownerId && skill.id === id &&
        (input.scope === undefined || skill.scope === input.scope) && (input.agentId === undefined || skill.agentId === input.agentId) && (input.projectId === undefined || skill.projectId === input.projectId));
      const scoped = input.scope === undefined && input.agentId === undefined && input.projectId === undefined ? records.filter((skill) => skill.scope === "global") : records;
      const selected = input.version === undefined ? scoped.at(-1) : scoped.find((skill) => skill.version === input.version);
      if (!selected) throw new SkillNotFoundError(`skill ${id} was not found for owner ${ownerId}`);
      return structuredClone(selected);
    });
  }

  async create(ownerId: string, input: CreateSkillInput): Promise<Skill> {
    return this.serialize(async () => {
      const skill = createSkill({ ...input, ownerId: input.ownerId ?? ownerId });
      if (skill.ownerId !== ownerId) throw new SkillValidationError(["ownerId is immutable"]);
      const records = await this.read();
      if (records.some((candidate) => candidate.ownerId === ownerId && skillIdentity(candidate) === skillIdentity(skill))) throw new SkillConflictError(`skill ${skill.id} already exists for this scope`);
      const next = [...records, skill];
      await this.write(next);
      this.replaceMemory(next);
      return structuredClone(skill);
    });
  }

  async update(ownerId: string, input: UpdateSkillInput): Promise<Skill> {
    return this.serialize(async () => {
      const records = await this.read();
      const candidates = records.filter((skill) => skill.ownerId === ownerId && skill.id === input.id &&
        (input.scope === undefined || skill.scope === input.scope) && (input.agentId === undefined || skill.agentId === input.agentId) && (input.projectId === undefined || skill.projectId === input.projectId));
      const current = candidates.at(-1) ?? records.filter((skill) => skill.ownerId === ownerId && skill.id === input.id).at(-1);
      if (!current) throw new SkillNotFoundError(`skill ${input.id} was not found for owner ${ownerId}`);
      if (input.version !== current.version + 1) throw new SkillConflictError("version must be exactly the next version");
      const nextSkill = updateSkill(current, input);
      const next = [...records, nextSkill];
      await this.write(next);
      this.replaceMemory(next);
      return structuredClone(nextSkill);
    });
  }

  async resolve(ownerId: string, input: Parameters<SkillRepository["resolve"]>[1]): Promise<readonly import("@subpolar/shared").EffectiveSkill[]> {
    return resolveEffectiveSkills({ ...input, skills: await this.list(ownerId, { includeDisabled: true }) });
  }

  private async read(): Promise<Skill[]> {
    if (!this.filePath) return this.records.map((skill) => structuredClone(skill));
    try {
      const parsed: unknown = JSON.parse(await readFile(this.filePath, "utf8"));
      if (!Array.isArray(parsed)) throw new Error("Skill file must contain an array");
      return parsed.map((value, index) => validatePersistedSkill(value, `skill[${index}]`));
    } catch (error) { if ((error as { code?: string }).code === "ENOENT") return []; throw error; }
  }

  private async write(records: Skill[]): Promise<void> {
    if (!this.filePath) return;
    await mkdir(dirname(this.filePath), { recursive: true });
    const temporaryPath = `${this.filePath}.tmp-${process.pid}-${randomUUID()}`;
    await writeFile(temporaryPath, `${JSON.stringify(records, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temporaryPath, this.filePath);
  }

  private replaceMemory(records: Skill[]): void { this.records.splice(0, this.records.length, ...records.map((skill) => structuredClone(skill))); }
  private serialize<T>(operation: () => Promise<T>): Promise<T> { const result = this.operationQueue.then(operation, operation); this.operationQueue = result.then(() => undefined, () => undefined); return result; }
}

const memoryCapabilities = (durable: boolean): AdapterCapabilities => ({
  adapter: durable ? "local-json-file" : "local-ephemeral",
  durability: durable ? "json-file" : "ephemeral",
  supports: { "memory.persistence": durable },
});

export class LocalMemoryStore implements MemoryStore {
  readonly capabilities: AdapterCapabilities;
  private readonly records = new Map<string, MemoryRecord>();
  private operationQueue: Promise<void> = Promise.resolve();
  constructor(private readonly filePath?: string) { this.capabilities = memoryCapabilities(Boolean(filePath)); }
  async list(ownerId: string, limit = 50): Promise<readonly MemoryRecord[]> {
    if (!this.filePath) return [...this.records.values()].filter((item) => item.ownerId === ownerId).slice(0, Math.min(limit, 50)).map((item) => structuredClone(item));
    return this.serialize(async () => {
      const records = await this.read();
      return records.filter((item) => item.ownerId === ownerId).slice(0, Math.min(limit, 50)).map((item) => structuredClone(item));
    });
  }
  async save(record: MemoryRecord): Promise<MemoryRecord> {
    const validated = validateMemoryRecord(record, "memory.save");
    if (!this.filePath) { this.records.set(validated.id, validated); return structuredClone(validated); }
    return this.serialize(async () => {
      const records = await this.read();
      const index = records.findIndex((item) => item.id === validated.id);
      if (index < 0) records.push(validated); else records[index] = validated;
      await mkdir(dirname(this.filePath!), { recursive: true });
      const temporaryPath = `${this.filePath}.tmp-${process.pid}-${randomUUID()}`;
      await writeFile(temporaryPath, `${JSON.stringify(records, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
      await rename(temporaryPath, this.filePath!);
      return structuredClone(validated);
    });
  }
  private async read(): Promise<MemoryRecord[]> {
    try {
      const parsed: unknown = JSON.parse(await readFile(this.filePath!, "utf8"));
      if (!Array.isArray(parsed)) throw new Error("Memory file must contain an array");
      return parsed.map((value, index) => validateMemoryRecord(value, `memory[${index}]`));
    }
    catch (error) { if ((error as { code?: string }).code === "ENOENT") return []; throw error; }
  }
  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationQueue.then(operation, operation);
    this.operationQueue = result.then(() => undefined, () => undefined);
    return result;
  }
}

type PersistedMemoryRecord = MemoryRecord & { idempotencyKey?: string };

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  if (!isPlainObject(value)) return false;
  return Object.values(value).every(isJsonValue);
}

function assertMemoryText(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`Invalid memory ${field}`);
}

function assertMemoryTimestamp(value: unknown, field: string): asserts value is string {
  assertMemoryText(value, field);
  if (new Date(value).toISOString() !== value) throw new Error(`Invalid memory ${field}`);
}

function validateMemoryRecord(value: unknown, location: string): PersistedMemoryRecord {
  if (!isPlainObject(value)) throw new Error(`Invalid memory record at ${location}`);
  const allowed = new Set(["id", "ownerId", "scope", "agentId", "projectId", "content", "metadata", "createdAt", "updatedAt", "version", "tombstone", "idempotencyKey"]);
  if (Object.keys(value).some((field) => !allowed.has(field))) throw new Error(`Invalid memory record at ${location}`);
  assertMemoryText(value.id, `${location}.id`);
  assertMemoryText(value.ownerId, `${location}.ownerId`);
  if (!(["user", "agent", "project"] as const).includes(value.scope as MemoryRecord["scope"])) throw new Error(`Invalid memory scope at ${location}`);
  if (value.agentId !== undefined) assertMemoryText(value.agentId, `${location}.agentId`);
  if (value.projectId !== undefined) assertMemoryText(value.projectId, `${location}.projectId`);
  assertMemoryText(value.content, `${location}.content`);
  if (!isJsonValue(value.metadata)) throw new Error(`Invalid memory metadata at ${location}`);
  assertMemoryTimestamp(value.createdAt, `${location}.createdAt`);
  assertMemoryTimestamp(value.updatedAt, `${location}.updatedAt`);
  if (typeof value.version !== "number" || !Number.isSafeInteger(value.version) || value.version < 1) throw new Error(`Invalid memory version at ${location}`);
  if (typeof value.tombstone !== "boolean") throw new Error(`Invalid memory tombstone at ${location}`);
  if (value.idempotencyKey !== undefined) assertMemoryText(value.idempotencyKey, `${location}.idempotencyKey`);
  return structuredClone(value) as unknown as PersistedMemoryRecord;
}

const forbiddenSessionIds = new Set([
  "__defineGetter__",
  "__defineSetter__",
  "__lookupGetter__",
  "__lookupSetter__",
  "__proto__",
  "constructor",
  "hasOwnProperty",
  "isPrototypeOf",
  "propertyIsEnumerable",
  "prototype",
  "toLocaleString",
  "toString",
  "valueOf",
]);

function assertSessionId(sessionId: unknown): asserts sessionId is string {
  if (
    typeof sessionId !== "string" ||
    sessionId.length === 0 ||
    sessionId.length > 128 ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(sessionId) ||
    forbiddenSessionIds.has(sessionId)
  ) {
    throw new Error("Session ID must be a safe non-empty identifier");
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertTimestamp(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || !value || Number.isNaN(Date.parse(value))) {
    throw new Error(`Invalid session ${field}`);
  }
}

function validateEntry(value: unknown, location: string): SessionTranscriptEntry {
  if (!isPlainObject(value) || !["user", "assistant", "tool"].includes(value.role as string)) {
    throw new Error(`Invalid transcript entry at ${location}`);
  }
  if (Object.keys(value).some((key) => !["role", "content", "occurredAt"].includes(key))) {
    throw new Error(`Invalid transcript entry at ${location}`);
  }
  if (typeof value.content !== "string") throw new Error(`Invalid transcript content at ${location}`);
  assertTimestamp(value.occurredAt, `${location}.occurredAt`);
  return { role: value.role as SessionTranscriptEntry["role"], content: value.content, occurredAt: value.occurredAt };
}

function validateRecord(key: string, value: unknown): SessionRecord {
  assertSessionId(key);
  if (!isPlainObject(value) || value.sessionId !== key || !Array.isArray(value.transcript)) {
    throw new Error(`Invalid session record for ${key}`);
  }
  if (Object.keys(value).some((field) => !["sessionId", "transcript", "updatedAt"].includes(field))) {
    throw new Error(`Invalid session record for ${key}`);
  }
  assertTimestamp(value.updatedAt, `${key}.updatedAt`);
  return {
    sessionId: key,
    transcript: value.transcript.map((entry, index) => validateEntry(entry, `${key}.transcript[${index}]`)),
    updatedAt: value.updatedAt,
  };
}

function copyRecord(record: SessionRecord): SessionRecord {
  return { sessionId: record.sessionId, updatedAt: record.updatedAt, transcript: record.transcript.map((entry) => ({ ...entry })) };
}

export class EphemeralSessionStore implements SessionStore {
  readonly capabilities = ephemeralCapabilities;
  private readonly records = new Map<string, SessionRecord>();

  async load(sessionId: string): Promise<SessionRecord | undefined> {
    assertSessionId(sessionId);
    const record = this.records.get(sessionId);
    return record ? copyRecord(record) : undefined;
  }

  async append(sessionId: string, entries: SessionTranscriptEntry[]): Promise<SessionRecord> {
    assertSessionId(sessionId);
    if (!Array.isArray(entries)) throw new Error("Transcript entries must be an array");
    const validatedEntries = entries.map((entry, index) => validateEntry(entry, `append.transcript[${index}]`));
    const existing = this.records.get(sessionId) ?? { sessionId, transcript: [], updatedAt: new Date().toISOString() };
    const record: SessionRecord = {
      sessionId,
      transcript: [...existing.transcript, ...validatedEntries],
      updatedAt: new Date().toISOString(),
    };
    this.records.set(sessionId, record);
    return copyRecord(record);
  }

  async persist(): Promise<never> {
    throw new UnsupportedCapabilityError("session.persistence", this.capabilities.adapter, "Ephemeral sessions are not persisted; configure a JSON file explicitly");
  }
}

export class JsonFileSessionStore implements SessionStore {
  readonly capabilities = jsonFileCapabilities;
  readonly filePath: string;
  private operationQueue: Promise<void> = Promise.resolve();

  constructor(filePath: string) {
    if (!filePath.trim()) throw new Error("A JSON session file path is required");
    this.filePath = filePath;
  }

  private async readRecords(): Promise<Record<string, SessionRecord>> {
    try {
      const text = await readFile(this.filePath, "utf8");
      const parsed: unknown = JSON.parse(text);
      if (!isPlainObject(parsed)) throw new Error("Session file must contain an object");
      const records = Object.create(null) as Record<string, SessionRecord>;
      for (const key of Object.keys(parsed)) records[key] = validateRecord(key, parsed[key]);
      return records;
    } catch (error) {
      if ((error as { code?: string }).code === "ENOENT") return Object.create(null) as Record<string, SessionRecord>;
      throw error;
    }
  }

  private async writeRecords(records: Record<string, SessionRecord>): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const temporaryPath = `${this.filePath}.tmp-${process.pid}-${randomUUID()}`;
    await writeFile(temporaryPath, `${JSON.stringify(records, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temporaryPath, this.filePath);
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationQueue.then(operation, operation);
    this.operationQueue = result.then(() => undefined, () => undefined);
    return result;
  }

  async load(sessionId: string): Promise<SessionRecord | undefined> {
    assertSessionId(sessionId);
    return this.serialize(async () => {
      const records = await this.readRecords();
      const record = records[sessionId];
      return record ? copyRecord(record) : undefined;
    });
  }

  async append(sessionId: string, entries: SessionTranscriptEntry[]): Promise<SessionRecord> {
    assertSessionId(sessionId);
    if (!Array.isArray(entries)) throw new Error("Transcript entries must be an array");
    const validatedEntries = entries.map((entry, index) => validateEntry(entry, `append.transcript[${index}]`));
    return this.serialize(async () => {
      const records = await this.readRecords();
      const existing = records[sessionId] ?? { sessionId, transcript: [], updatedAt: new Date().toISOString() };
      const record: SessionRecord = {
        sessionId,
        transcript: [...existing.transcript, ...validatedEntries],
        updatedAt: new Date().toISOString(),
      };
      records[sessionId] = record;
      await this.writeRecords(records);
      return copyRecord(record);
    });
  }
}

export interface LocalAdapterOptions {
  sessionFile?: string;
  memoryFile?: string;
  skillFile?: string;
}

export interface LocalAdapter {
  readonly sessions: SessionStore;
  readonly capabilities: AdapterCapabilities & { supports: AdapterCapabilities["supports"] & Record<string, boolean> };
  readonly memory: MemoryStore;
  readonly skills: SkillRepository;
}

export function createLocalAdapter(options: LocalAdapterOptions = {}): LocalAdapter {
  const sessions = options.sessionFile ? new JsonFileSessionStore(options.sessionFile) : new EphemeralSessionStore();
  const memory = new LocalMemoryStore(options.memoryFile);
  const skills = new LocalSkillRepository(options.skillFile);
  return { sessions, memory, skills, capabilities: { ...sessions.capabilities, supports: { ...sessions.capabilities.supports, "memory.persistence": Boolean(options.memoryFile), "skill.persistence": Boolean(options.skillFile) } as AdapterCapabilities["supports"] & Record<string, boolean> } };
}
