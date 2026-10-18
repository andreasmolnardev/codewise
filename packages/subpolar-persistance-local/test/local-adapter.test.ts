import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLocalAdapter, EphemeralSessionStore } from "../src/index.ts";

const entry = { role: "user" as const, content: "hello", occurredAt: "2026-01-01T00:00:00.000Z" };

describe("local adapter", () => {
  test("ephemeral sessions do not persist across adapter instances", async () => {
    const first = createLocalAdapter();
    await first.sessions.append("session-1", [entry]);

    expect(first.capabilities.durability).toBe("ephemeral");
    expect(await first.sessions.load("session-1")).toBeDefined();
    expect(await createLocalAdapter().sessions.load("session-1")).toBeUndefined();
    await expect((first.sessions as EphemeralSessionStore).persist()).rejects.toMatchObject({ code: "UNSUPPORTED_CAPABILITY" });
  });

  test("does not claim durable memory without an explicit memory store", async () => {
    const ephemeral = createLocalAdapter();
    expect(ephemeral.capabilities.supports["memory.persistence"]).toBe(false);
    await ephemeral.memory.save({ id: "m-1", ownerId: "user-a", scope: "user", content: "x", metadata: null, createdAt: entry.occurredAt, updatedAt: entry.occurredAt, version: 1, tombstone: false });
    expect((await ephemeral.memory.list("user-a"))).toHaveLength(1);

    const directory = await mkdtemp(join(tmpdir(), "subpolar-memory-"));
    try {
      const durable = createLocalAdapter({ memoryFile: join(directory, "memory.json") });
      expect(durable.capabilities.supports["memory.persistence"]).toBe(true);
      await durable.memory.save({ id: "m-1", ownerId: "user-a", scope: "user", content: "x", metadata: null, createdAt: entry.occurredAt, updatedAt: entry.occurredAt, version: 1, tombstone: false });
      expect((await createLocalAdapter({ memoryFile: join(directory, "memory.json") }).memory.list("user-a"))).toHaveLength(1);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  test("explicit JSON persistence resumes transcripts without provider secrets", async () => {
    const directory = await mkdtemp(join(tmpdir(), "subpolar-local-"));
    const filePath = join(directory, "sessions.json");
    try {
      const first = createLocalAdapter({ sessionFile: filePath });
      await first.sessions.append("session-1", [entry]);
      const second = createLocalAdapter({ sessionFile: filePath });
      expect((await second.sessions.load("session-1"))?.transcript).toHaveLength(1);
      expect(second.capabilities.supports["session.persistence"]).toBe(true);
      expect(await readFile(filePath, "utf8")).not.toContain("providerSecret");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("rejects malformed records and prototype session keys", async () => {
    const directory = await mkdtemp(join(tmpdir(), "subpolar-local-"));
    const filePath = join(directory, "sessions.json");
    try {
      await writeFile(filePath, JSON.stringify({ broken: { sessionId: "broken", transcript: null, updatedAt: "2026-01-01T00:00:00.000Z" } }));
      const store = createLocalAdapter({ sessionFile: filePath }).sessions;
      await expect(store.load("broken")).rejects.toThrow("Invalid session record");

      await writeFile(filePath, '{"__proto__":{"sessionId":"__proto__","transcript":[],"updatedAt":"2026-01-01T00:00:00.000Z"}}');
      await expect(store.load("broken")).rejects.toThrow("safe non-empty identifier");
      await expect(store.load("__proto__")).rejects.toThrow("safe non-empty identifier");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("serializes concurrent appends on one JSON store instance", async () => {
    const directory = await mkdtemp(join(tmpdir(), "subpolar-local-"));
    const filePath = join(directory, "sessions.json");
    try {
      const store = createLocalAdapter({ sessionFile: filePath }).sessions;
      await Promise.all(
        Array.from({ length: 20 }, (_, index) => store.append("session-concurrent", [{ ...entry, content: `entry-${index}` }])),
      );

      const record = await store.load("session-concurrent");
      expect(record?.transcript).toHaveLength(20);
      expect(new Set(record?.transcript.map((item) => item.content)).size).toBe(20);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("serializes concurrent memory saves without losing records", async () => {
    const directory = await mkdtemp(join(tmpdir(), "subpolar-memory-"));
    const filePath = join(directory, "memory.json");
    try {
      const store = createLocalAdapter({ memoryFile: filePath }).memory;
      await Promise.all(Array.from({ length: 20 }, (_, index) => store.save({
        id: `memory-${index}`, ownerId: "user-a", scope: "user", content: `content-${index}`, metadata: null,
        createdAt: entry.occurredAt, updatedAt: entry.occurredAt, version: 1, tombstone: false,
      })));
      expect(await store.list("user-a")).toHaveLength(20);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  test("rejects malformed persisted memory records", async () => {
    const directory = await mkdtemp(join(tmpdir(), "subpolar-memory-"));
    const filePath = join(directory, "memory.json");
    try {
      await writeFile(filePath, JSON.stringify([{ id: "memory-1", ownerId: "user-a", scope: "user", content: 7, metadata: null, createdAt: entry.occurredAt, updatedAt: entry.occurredAt, version: 1, tombstone: false }]));
      await expect(createLocalAdapter({ memoryFile: filePath }).memory.list("user-a")).rejects.toThrow("Invalid memory memory[0].content");
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  test("persists owner-scoped skill versions and reloads them atomically", async () => {
    const directory = await mkdtemp(join(tmpdir(), "subpolar-skills-"));
    const filePath = join(directory, "skills.json");
    const input = { id: "skill-one", name: "skill-one", scope: "global" as const, mode: "discoverable" as const, body: "v1" };
    try {
      const first = createLocalAdapter({ skillFile: filePath });
      const created = await first.skills.create("owner-a", input);
      await first.skills.update("owner-a", { id: created.id, version: 2, body: "v2" });
      expect(await first.skills.get("owner-a", created.id, { version: 1 })).toMatchObject({ body: "v1", version: 1 });
      expect(await createLocalAdapter({ skillFile: filePath }).skills.get("owner-a", created.id)).toMatchObject({ body: "v2", version: 2 });
      expect(await createLocalAdapter({ skillFile: filePath }).skills.list("owner-b")).toEqual([]);
      expect(first.capabilities.supports["skill.persistence" as never]).toBe(true);
      await expect(first.skills.update("owner-a", { id: created.id, version: 2, body: "stale" })).rejects.toMatchObject({ code: "SKILL_CONFLICT" });
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  test("rejects malformed persisted skill files", async () => {
    const directory = await mkdtemp(join(tmpdir(), "subpolar-skills-"));
    const filePath = join(directory, "skills.json");
    try {
      await writeFile(filePath, JSON.stringify([{ id: "bad", ownerId: "owner-a", name: "Bad Name", scope: "global", mode: "disabled", version: 1, metadata: {}, body: "" }]));
      await expect(createLocalAdapter({ skillFile: filePath }).skills.list("owner-a")).rejects.toThrow("Invalid skill record");
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});
