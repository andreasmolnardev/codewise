import { describe, expect, test } from "bun:test";
import type { RunEvent } from "../../subpolar-contracts/src/index.ts";
import { createRunService } from "../../subpolar-core/src/index.ts";
import {
  createInMemoryPiExecutor,
  createPiRunPort,
  InMemoryPiSession,
  PiProviderError,
  PiRuntimeError,
} from "../src/index.ts";

const request = {
  runId: "run-pi",
  prompt: "hello",
  context: {
    requestId: "request-pi",
    principal: { id: "user-1", kind: "user" as const },
    sessionId: "session-1",
    projectId: "project-1",
    agentId: "agent-1",
    model: "model-1",
    permission: "standard",
    cwd: "/tmp/project",
  },
};

describe("Pi executor adapter", () => {
  test("maps the complete run context and streams correlated RunEvents", async () => {
    const seen: unknown[] = [];
    const events: RunEvent[] = [];
    const port = createPiRunPort(() => ({
      async execute(input) {
        seen.push(input.context);
        await input.emit({ type: "text", data: { text: "partial" } });
        return { text: "complete" };
      },
    }), { profile: "fake" });

    const result = await createRunService({ runPort: port, eventSink: (event) => { events.push(event); } }).run(request);

    expect(port.capabilities.durability).toBe("ephemeral");
    expect(port.capabilities.supports["session.persistence"]).toBe(false);
    expect(result).toMatchObject({ state: "completed", output: { text: "complete" } });
    expect(seen).toEqual([{ principal: request.context.principal, sessionId: request.context.sessionId, projectId: request.context.projectId, agentId: request.context.agentId, model: request.context.model, permission: request.context.permission, cwd: request.context.cwd }]);
    expect(events.map((event) => event.type)).toEqual(["run.started", "run.progress", "run.completed"]);
    expect(events[1]).toMatchObject({ runId: "run-pi", requestId: "request-pi", sessionId: "session-1", data: { type: "text", data: { text: "partial" } } });
  });

  test("passes abort through the adapter and preserves core cancellation semantics", async () => {
    const controller = new AbortController();
    let started!: () => void;
    const startedPromise = new Promise<void>((resolve) => { started = resolve; });
    const port = createPiRunPort(() => ({
      execute({ signal }) {
        started();
        return new Promise((_, reject) => signal?.addEventListener("abort", () => reject(new Error("cancelled")), { once: true }));
      },
    }), undefined);
    const pending = createRunService({ runPort: port }).run({ ...request, signal: controller.signal });
    await startedPromise;
    controller.abort();

    await expect(pending).resolves.toMatchObject({ state: "interrupted", error: { code: "RUN_INTERRUPTED" } });
  });

  test("maps provider and runtime failures to typed errors", async () => {
    const provider = createPiRunPort(() => ({ execute: () => { throw { kind: "provider", message: "provider unavailable" }; } }), undefined);
    const runtime = createPiRunPort(() => ({ execute: () => { throw new Error("runtime unavailable"); } }), undefined);

    await expect(provider.run(request)).rejects.toBeInstanceOf(PiProviderError);
    await expect(runtime.run(request)).rejects.toBeInstanceOf(PiRuntimeError);
  });

  test("passes an explicit transcript projection without looking up the session", async () => {
    let received!: Parameters<NonNullable<Parameters<typeof createPiRunPort>[0]>>[1];
    const transcript = {
      sessionId: "session-1",
      leafId: "leaf-1",
      entries: [{ role: "user" as const, content: "prior turn", occurredAt: "2026-01-01T00:00:00.000Z" }],
    };
    const port = createPiRunPort((_config, input) => {
      received = input;
      return { execute: async (execution) => ({ entries: execution.transcript.entries }) };
    }, undefined);

    const result = await port.run({ ...request, transcript });

    expect(result).toEqual({ entries: transcript.entries });
    expect(received?.context.sessionId).toBe("session-1");
    expect(received?.transcript).toEqual(transcript);
    expect(received?.transcript).not.toBe(transcript);
    expect(received?.transcript.entries).not.toBe(transcript.entries);
  });

  test("creates and disposes one transient executor for every run", async () => {
    let factories = 0;
    const disposed: number[] = [];
    const port = createPiRunPort(() => {
      const id = ++factories;
      return {
        execute: async () => ({ id }),
        dispose: () => { disposed.push(id); },
      };
    }, undefined);

    await expect(port.run(request)).resolves.toEqual({ id: 1 });
    await expect(port.run({ ...request, runId: "run-pi-2" })).resolves.toEqual({ id: 2 });

    expect(factories).toBe(2);
    expect(disposed).toEqual([1, 2]);
  });

  test("normalizes SDK-shaped stream events before exposing them as progress", async () => {
    const events: unknown[] = [];
    const port = createPiRunPort(() => ({
      async execute(input) {
        await input.emit({ type: "text_delta", text: "partial" });
        await input.emit({ type: "tool_result", data: { status: "completed" } });
        await input.emit({ type: "agent_end", reason: "stop" });
        return "complete";
      },
    }), undefined);

    await port.run(request, (event) => { events.push(event); });

    expect(events).toEqual([
      { type: "text", data: { text: "partial" } },
      { type: "tool", data: { status: "completed" } },
      { type: "status", data: { reason: "stop" } },
    ]);
  });

  test("provides an in-memory executor/session and drops its transcript on disposal", async () => {
    const seen: string[] = [];
    const executor = createInMemoryPiExecutor((input) => {
      seen.push(input.transcript.entries[0]?.content as string);
      return { text: "ok" };
    });
    const port = createPiRunPort(() => executor, undefined);

    await expect(port.run({
      ...request,
      transcript: { entries: [{ role: "user", content: "in memory only" }] },
    })).resolves.toEqual({ text: "ok" });

    expect(seen).toEqual(["in memory only"]);
    expect(executor.activeSession).toBeDefined();
    expect(executor.activeSession?.disposed).toBe(true);
    expect(executor.activeSession?.transcript).toEqual({ entries: [] });

    const session = new InMemoryPiSession();
    await session.execute({
      runId: request.runId,
      requestId: request.context.requestId,
      prompt: request.prompt,
      context: { principal: request.context.principal },
      transcript: { entries: [{ role: "assistant", content: "temporary" }] },
      emit: () => undefined,
    });
    session.dispose();
    expect(session.transcript).toEqual({ entries: [] });
    await expect(session.execute({
      runId: request.runId,
      requestId: request.context.requestId,
      prompt: request.prompt,
      context: { principal: request.context.principal },
      transcript: { entries: [] },
      emit: () => undefined,
    })).rejects.toBeInstanceOf(PiRuntimeError);
  });
});
