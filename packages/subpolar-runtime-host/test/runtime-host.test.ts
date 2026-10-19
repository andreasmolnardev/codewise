import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { RuntimeContextPort } from "@subpolar/shared";
import { createPolicyGateway } from "@subpolar/runtime";
import { createSubpolarRuntimeHost } from "../src/index.ts";

function hostWith(execute: (input: { prompt: string; transcript: readonly unknown[]; signal?: AbortSignal }) => unknown | Promise<unknown>) {
  const context: RuntimeContextPort = {
    async load(request) {
      return {
        requestId: request.requestId,
        runId: request.runId,
        sessionId: request.sessionId,
        principal: request.principal ?? { id: "local-user", kind: "local" },
      };
    },
  };
  const gateway = createPolicyGateway({ execute: async () => ({ ok: false, status: "denied" }) });
  return createSubpolarRuntimeHost({
    context,
    gateway,
    piConfig: undefined,
    createId: (() => { let id = 0; return () => `id-${++id}`; })(),
    piFactory: () => ({
      async execute(request) {
        return execute({ prompt: request.prompt, transcript: request.transcript.entries, signal: request.signal });
      },
    }),
  });
}

describe("SubpolarRuntimeHost", () => {
  test("keeps completed transcript within its process session and reports no resume", async () => {
    const seen: unknown[][] = [];
    const host = hostWith(({ transcript, prompt }) => {
      seen.push([...transcript]);
      return `answer: ${prompt}`;
    });
    const first = host.createSession();
    const second = host.createSession();

    expect(first.capabilities.supports).toMatchObject({ "session.resume": false, "session.persistence": false, "run.outcome.persistence": false });
    expect((await host.prompt(first.sessionId, "one")).state).toBe("completed");
    expect((await host.prompt(first.sessionId, "two")).state).toBe("completed");
    expect((await host.prompt(second.sessionId, "other")).state).toBe("completed");
    expect(seen[0]).toEqual([]);
    expect(seen[1]).toHaveLength(2);
    expect(seen[2]).toEqual([]);
  });

  test("reports session persistence only when the selected executor supports it", () => {
    const runtimeDataDir = mkdtempSync(path.join(os.tmpdir(), "subpolar-capabilities-"));
    try {
      const context: RuntimeContextPort = { async load(request) {
        return { requestId: request.requestId, runId: request.runId, sessionId: request.sessionId, principal: request.principal ?? { id: "local-user", kind: "local" } };
      } };
      const gateway = createPolicyGateway({ execute: async () => ({ ok: false, status: "denied" }) });
      const executor = Object.assign(() => ({ async execute() { return "ok"; } }), { supportsPersistentSessions: true as const });
      const persistent = createSubpolarRuntimeHost({ context, gateway, piConfig: { runtimeDataDir }, piFactory: executor });
      const customExecutor = createSubpolarRuntimeHost({ context, gateway, piConfig: { runtimeDataDir }, piFactory: () => ({ async execute() { return "ok"; } }) });
      const relativeStorage = createSubpolarRuntimeHost({ context, gateway, piConfig: { runtimeDataDir: "relative/path" }, piFactory: executor });

      expect(persistent.createSession().capabilities.supports).toMatchObject({ "session.resume": true, "session.persistence": true, "run.outcome.persistence": true });
      expect(customExecutor.createSession().capabilities.supports).toMatchObject({ "session.resume": false, "session.persistence": false, "run.outcome.persistence": false });
      expect(relativeStorage.createSession().capabilities.supports).toMatchObject({ "session.resume": false, "session.persistence": false, "run.outcome.persistence": false });
    } finally {
      rmSync(runtimeDataDir, { recursive: true, force: true });
    }
  });

  test("persists session mappings and run outcomes, and marks abandoned reservations unknown on restart", async () => {
    const runtimeDataDir = mkdtempSync(path.join(os.tmpdir(), "subpolar-host-"));
    try {
      const context: RuntimeContextPort = { async load(request) {
        return { requestId: request.requestId, runId: request.runId, sessionId: request.sessionId, principal: request.principal ?? { id: "local-user", kind: "local" } };
      } };
      const gateway = createPolicyGateway({ execute: async () => ({ ok: false, status: "denied" }) });
      const factory = Object.assign(() => ({ async execute() { return "ok"; } }), { supportsPersistentSessions: true as const });
      const first = createSubpolarRuntimeHost({ context, gateway, piConfig: { runtimeDataDir }, piFactory: factory, createId: () => "run-done" });
      const session = first.createSession(undefined, "stable-session");
      expect((await first.prompt(session.sessionId, "hello")).state).toBe("completed");

      const sessionFile = path.join(runtimeDataDir, "subpolar-runtime-host", "sessions", `${Buffer.from("stable-session").toString("hex")}.json`);
      const runFile = path.join(runtimeDataDir, "subpolar-runtime-host", "runs", `${Buffer.from("run-done").toString("hex")}.json`);
      expect(JSON.parse(readFileSync(sessionFile, "utf8")).piSessionId).toBe("stable-session");
      expect(JSON.parse(readFileSync(runFile, "utf8")).state).toBe("completed");
      const abandonedFile = path.join(runtimeDataDir, "subpolar-runtime-host", "runs", `${Buffer.from("abandoned-run").toString("hex")}.json`);
      writeFileSync(abandonedFile, JSON.stringify({ version: 1, runId: "abandoned-run", sessionId: "stable-session", state: "running", updatedAt: "old", workerPid: 99999999 }));

      const restarted = createSubpolarRuntimeHost({ context, gateway, piConfig: { runtimeDataDir }, piFactory: factory });
      expect(restarted.createSession(undefined, "stable-session").capabilities.supports["session.resume"]).toBe(true);
      expect(JSON.parse(readFileSync(abandonedFile, "utf8")).state).toBe("unknown");
      expect(JSON.parse(readFileSync(runFile, "utf8")).state).toBe("completed");
    } finally {
      rmSync(runtimeDataDir, { recursive: true, force: true });
    }
  });

  test("rejects session principal changes, including absent-to-present principals", () => {
    const runtimeDataDir = mkdtempSync(path.join(os.tmpdir(), "subpolar-principal-"));
    try {
      const context: RuntimeContextPort = { async load(request) { return { requestId: request.requestId, runId: request.runId, sessionId: request.sessionId, principal: request.principal ?? { id: "local-user", kind: "local" } }; } };
      const gateway = createPolicyGateway({ execute: async () => ({ ok: false, status: "denied" }) });
      const factory = Object.assign(() => ({ async execute() { return "ok"; } }), { supportsPersistentSessions: true as const });
      const host = createSubpolarRuntimeHost({ context, gateway, piConfig: { runtimeDataDir }, piFactory: factory });
      const user = { id: "user-1", kind: "user" } as const;
      host.createSession(user, "owned");
      expect(() => host.createSession({ id: "user-2", kind: "user" }, "owned")).toThrow("different principal");
      expect(() => host.restoreSession("owned", { id: "user-2", kind: "user" })).toThrow("different principal");
      host.createSession(undefined, "anonymous");
      expect(() => host.createSession(user, "anonymous")).toThrow("different principal");
      expect(() => host.restoreSession("anonymous", user)).toThrow("different principal");
    } finally {
      rmSync(runtimeDataDir, { recursive: true, force: true });
    }
  });

  test("preserves corrupt persisted session records instead of replacing them", () => {
    const runtimeDataDir = mkdtempSync(path.join(os.tmpdir(), "subpolar-corrupt-"));
    try {
      const context: RuntimeContextPort = { async load(request) { return { requestId: request.requestId, runId: request.runId, sessionId: request.sessionId, principal: request.principal ?? { id: "local-user", kind: "local" } }; } };
      const gateway = createPolicyGateway({ execute: async () => ({ ok: false, status: "denied" }) });
      const factory = Object.assign(() => ({ async execute() { return "ok"; } }), { supportsPersistentSessions: true as const });
      const host = createSubpolarRuntimeHost({ context, gateway, piConfig: { runtimeDataDir }, piFactory: factory });
      const file = path.join(runtimeDataDir, "subpolar-runtime-host", "sessions", `${Buffer.from("broken").toString("hex")}.json`);
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, "{broken");
      expect(() => host.createSession(undefined, "broken")).toThrow("corrupt");
      expect(readFileSync(file, "utf8")).toBe("{broken");
    } finally {
      rmSync(runtimeDataDir, { recursive: true, force: true });
    }
  });

  test("two hosts sharing runtime storage retain both hosts' session and run records", async () => {
    const runtimeDataDir = mkdtempSync(path.join(os.tmpdir(), "subpolar-shared-"));
    try {
      const context: RuntimeContextPort = { async load(request) { return { requestId: request.requestId, runId: request.runId, sessionId: request.sessionId, principal: request.principal ?? { id: "local-user", kind: "local" } }; } };
      const gateway = createPolicyGateway({ execute: async () => ({ ok: false, status: "denied" }) });
      const factory = Object.assign(() => ({ async execute() { return "ok"; } }), { supportsPersistentSessions: true as const });
      const first = createSubpolarRuntimeHost({ context, gateway, piConfig: { runtimeDataDir }, piFactory: factory, createId: () => "first-run" });
      const second = createSubpolarRuntimeHost({ context, gateway, piConfig: { runtimeDataDir }, piFactory: factory, createId: () => "second-run" });
      first.createSession(undefined, "first-session");
      second.createSession(undefined, "second-session");
      await Promise.all([first.prompt("first-session", "one"), second.prompt("second-session", "two")]);
      const sessionsDir = path.join(runtimeDataDir, "subpolar-runtime-host", "sessions");
      const runsDir = path.join(runtimeDataDir, "subpolar-runtime-host", "runs");
      expect(readdirSync(sessionsDir).sort()).toEqual(["66697273742d73657373696f6e.json", "7365636f6e642d73657373696f6e.json"]);
      expect(JSON.parse(readFileSync(path.join(runsDir, `${Buffer.from("first-run").toString("hex")}.json`), "utf8")).state).toBe("completed");
      expect(JSON.parse(readFileSync(path.join(runsDir, `${Buffer.from("second-run").toString("hex")}.json`), "utf8")).state).toBe("completed");
    } finally {
      rmSync(runtimeDataDir, { recursive: true, force: true });
    }
  });

  test("rejects restoration when the selected executor has no persistent session storage", () => {
    const host = hostWith(() => "ok");
    expect(() => host.restoreSession("persisted-session")).toThrow("cannot resume sessions");
  });

  test("cancels the active Pi turn and releases the session for the next turn", async () => {
    let started!: () => void;
    const didStart = new Promise<void>((resolve) => { started = resolve; });
    const host = hostWith(({ signal }) => new Promise((_, reject) => {
      started();
      signal?.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
    }));
    const session = host.createSession();
    const pending = host.prompt(session.sessionId, "wait");
    await didStart;
    expect(host.cancel(session.sessionId)).toBe(true);
    expect((await pending).state).toBe("interrupted");
    expect(host.cancel(session.sessionId)).toBe(false);
  });

  test("closing a session cancels its active turn and rejects later use", async () => {
    let started!: () => void;
    const didStart = new Promise<void>((resolve) => { started = resolve; });
    const host = hostWith(({ signal }) => new Promise((_, reject) => {
      started();
      signal?.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
    }));
    const session = host.createSession();
    const pending = host.prompt(session.sessionId, "wait");
    await didStart;
    expect(await host.closeSession(session.sessionId)).toBe(true);
    expect((await pending).state).toBe("interrupted");
    expect(await host.closeSession(session.sessionId)).toBe(false);
    await expect(host.prompt(session.sessionId, "closed")).rejects.toThrow("does not exist");
  });
});
