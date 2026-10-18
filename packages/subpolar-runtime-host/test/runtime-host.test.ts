import { describe, expect, test } from "bun:test";
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
    const context: RuntimeContextPort = { async load(request) {
      return { requestId: request.requestId, runId: request.runId, sessionId: request.sessionId, principal: request.principal ?? { id: "local-user", kind: "local" } };
    } };
    const gateway = createPolicyGateway({ execute: async () => ({ ok: false, status: "denied" }) });
    const executor = Object.assign(() => ({ async execute() { return "ok"; } }), { supportsPersistentSessions: true as const });
    const persistent = createSubpolarRuntimeHost({ context, gateway, piConfig: { runtimeDataDir: "/var/lib/subpolar" }, piFactory: executor });
    const customExecutor = createSubpolarRuntimeHost({ context, gateway, piConfig: { runtimeDataDir: "/var/lib/subpolar" }, piFactory: () => ({ async execute() { return "ok"; } }) });
    const relativeStorage = createSubpolarRuntimeHost({ context, gateway, piConfig: { runtimeDataDir: "relative/path" }, piFactory: executor });

    expect(persistent.createSession().capabilities.supports).toMatchObject({ "session.resume": true, "session.persistence": true });
    expect(customExecutor.createSession().capabilities.supports).toMatchObject({ "session.resume": false, "session.persistence": false });
    expect(relativeStorage.createSession().capabilities.supports).toMatchObject({ "session.resume": false, "session.persistence": false });
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
