import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { registerSubpolarModelEgressExtension } from "./subpolarModelEgress.ts";

function makeHarness(
  activeSessionId = "worker-session",
  providerIds = ["openai"],
  requestProvider?: (signal?: AbortSignal) => Promise<{ status: number; statusText: string; headers: Record<string, string>; body: string }>,
) {
  let handler: ((request: unknown) => Effect.Effect<unknown, unknown>) | undefined;
  let notificationHandler: ((request: unknown) => Effect.Effect<void, unknown>) | undefined;
  const context = {
    activeSessionId: Effect.succeed(activeSessionId),
    runtime: {
      handleExtRequest: (_method: string, _schema: unknown, callback: unknown) =>
        Effect.sync(() => { handler = callback as typeof handler; }),
      handleExtNotification: (_method: string, _schema: unknown, callback: unknown) =>
        Effect.sync(() => { notificationHandler = callback as typeof notificationHandler; }),
    },
  };
  const ready = Effect.runPromise(registerSubpolarModelEgressExtension({
    providerIds,
    context: context as never,
    resolveAddress: async () => "8.8.8.8",
    requestProvider: async (_hostname, _address, _method, _path, _headers, _body, signal) => requestProvider
      ? requestProvider(signal)
      : new Promise((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(new Error("Provider request aborted")), { once: true });
        }),
  }));
  return {
    ready,
    invoke: async (request: Record<string, unknown>) => {
      await ready;
      if (!handler) throw new Error("Egress handler was not registered");
      return Effect.runPromise(handler(request));
    },
    notify: async (request: Record<string, unknown>) => {
      await ready;
      if (!notificationHandler) throw new Error("Egress cancel handler was not registered");
      return Effect.runPromise(notificationHandler(request));
    },
  };
}

const request = {
  sessionId: "worker-session",
  requestId: "4f22d77f-1746-4acd-a924-73bbb2169d19",
  providerId: "openai",
  url: "https://api.openai.com/v1/chat/completions",
  method: "POST",
  headers: { authorization: "Bearer canary", "content-type": "application/json" },
  body: Buffer.from("{}").toString("base64"),
};

it("rejects model egress from a different ACP session", async () => {
  const harness = makeHarness("other-session");
  await assert.rejects(harness.invoke(request));
});

it("rejects providers outside the provider-instance credential allowlist", async () => {
  const harness = makeHarness("worker-session", []);
  await assert.rejects(harness.invoke(request));
});

it("aborts the active provider request when the matching ACP cancel notification arrives", async () => {
  let started!: () => void;
  const began = new Promise<void>((resolve) => { started = resolve; });
  let requestSignal: AbortSignal | undefined;
  const harness = makeHarness("worker-session", ["openai"], async (signal) => {
      requestSignal = signal;
      started();
      return new Promise((_resolve, reject) => signal?.addEventListener("abort", () => reject(new Error("Provider request aborted")), { once: true }));
    });
  const pending = harness.invoke(request);
  await began;
  await harness.notify({ sessionId: request.sessionId, requestId: request.requestId });
  await assert.rejects(pending);
  assert.equal(requestSignal?.aborted, true);
});

it("rejects non-provider hosts and custom endpoint redirects before opening a network request", async () => {
  const harness = makeHarness();
  await assert.rejects(harness.invoke({ ...request, url: "https://127.0.0.1/latest/meta-data" }));
  await assert.rejects(harness.invoke({ ...request, url: "https://evil.example/v1/chat/completions" }));
  await assert.rejects(harness.invoke({ ...request, url: "https://api.openai.com:444/v1/chat/completions" }));
  await assert.rejects(harness.invoke({ ...request, url: "https://api.openai.com/v1/models" }));
  await assert.rejects(harness.invoke({ ...request, method: "GET" }));
});
