import { describe, expect, it } from "bun:test";
import * as Effect from "effect/Effect";

import { createAcpModelFetch, installAcpModelFetch, MANAGED_MODEL_FETCH_METHOD } from "./modelEgress.ts";

describe("managed Pi model fetch", () => {
  it("tunnels request and response bytes through the bound ACP session", async () => {
    const calls: unknown[] = [];
    const client = {
      extRequest(method: string, payload: unknown) {
        calls.push({ method, payload });
        return Effect.succeed({
          status: 200,
          statusText: "OK",
          headers: { "content-type": "text/event-stream" },
          body: Buffer.from("data: done\n\n").toString("base64"),
        });
      },
      extNotification: () => Effect.void,
    };
    const fetch = createAcpModelFetch(client, "session-a", "openai");
    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: { authorization: "Bearer canary" },
      body: "{}",
    });

    expect(await response.text()).toBe("data: done\n\n");
    expect(calls).toEqual([{
      method: MANAGED_MODEL_FETCH_METHOD,
      payload: expect.objectContaining({ sessionId: "session-a", requestId: expect.any(String), providerId: "openai", method: "POST", url: "https://api.openai.com/v1/responses", body: Buffer.from("{}").toString("base64") }),
    }]);
  });

  it("forwards an aborted model request to the host with its request ID", async () => {
    const notifications: unknown[] = [];
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const client = {
      extRequest: (_method: string, _payload: unknown) => Effect.tryPromise({
        try: (signal) => new Promise((_resolve, reject) => {
          markStarted();
          signal.addEventListener("abort", () => reject(new Error("ACP request interrupted")), { once: true });
        }),
      }),
      extNotification: (method: string, payload: unknown) => Effect.sync(() => notifications.push({ method, payload })),
    };
    const controller = new AbortController();
    const fetch = createAcpModelFetch(client, "session-cancel", "openai");
    const pending = fetch("https://api.openai.com/v1/responses", { method: "GET", signal: controller.signal });
    await started;
    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toEqual({
      method: "subpolar/cancel",
      payload: expect.objectContaining({ sessionId: "session-cancel", requestId: expect.any(String) }),
    });
  });

  it("re-registers HTTP provider methods with the private ACP fetch implementation", async () => {
    const observed: Array<{ provider: string; fetch: unknown }> = [];
    const provider = {
      id: "openai",
      stream(model: unknown, context: unknown, options?: Record<string, unknown>) {
        observed.push({ provider: "openai.stream", fetch: options?.fetch });
        return { model, context };
      },
      streamSimple(model: unknown, context: unknown, options?: Record<string, unknown>) {
        observed.push({ provider: "openai.streamSimple", fetch: options?.fetch });
        return { model, context };
      },
    };
    const registered: unknown[] = [];
    const runtime = {
      getProviders: () => [provider],
      registerNativeProvider: (next: unknown) => registered.push(next),
    };
    const client = { extRequest: () => Effect.succeed({}), extNotification: () => Effect.void };
    installAcpModelFetch(runtime, client, "session-b");

    const wrapped = registered[0] as typeof provider;
    wrapped.stream({}, {}, {});
    wrapped.streamSimple({}, {}, {});
    expect(observed).toHaveLength(2);
    expect(observed[0]?.fetch).toBeTypeOf("function");
    expect(observed[1]?.fetch).toBe(observed[0]?.fetch);
  });

  it("rejects an oversized streamed body before forwarding it to ACP", async () => {
    let calls = 0;
    const fetch = createAcpModelFetch({
      extRequest: () => Effect.sync(() => { calls += 1; return {}; }),
      extNotification: () => Effect.void,
    }, "session-c", "openai");
    const body = new Blob([new Uint8Array(8 * 1024 * 1024 + 1)]);
    await expect(fetch("https://api.openai.com/v1/responses", { method: "POST", body })).rejects.toThrow("size limit");
    expect(calls).toBe(0);
  });
});
