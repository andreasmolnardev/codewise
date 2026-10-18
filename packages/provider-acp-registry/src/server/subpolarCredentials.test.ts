import { assert, it } from "@effect/vitest";
import { randomUUID } from "node:crypto";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as AcpErrors from "effect-acp/errors";

import { registerSubpolarCredentialExtension, setPiCredential } from "./subpolarCredentials.ts";

const credential = { type: "oauth", access: "secret-canary-access", refresh: "secret-canary-refresh", expires: 123 };

function makeCredentialHost() {
  const records = new Map<string, Uint8Array>();
  return {
    records,
    credentials: (namespace: string, instanceId: string) => {
      const key = `${namespace}\0${instanceId}`;
      return Effect.succeed({
        binding: { owner: "t3" as const, key },
        get: Effect.sync(() => records.has(key) ? Option.some(records.get(key)!) : Option.none()),
        set: (value: Uint8Array) => Effect.sync(() => { records.set(key, value); }),
        remove: Effect.sync(() => { records.delete(key); }),
      });
    },
  };
}

function makeHarness(
  activeSessionId = "worker-session",
  threadId = "thread-a",
  instanceId = `broker-test-${randomUUID()}`,
  host = makeCredentialHost(),
) {
  let handler: ((request: unknown) => Effect.Effect<unknown, unknown>) | undefined;
  const context = {
    threadId,
    activeSessionId: Effect.succeed(activeSessionId),
    runtime: {
      handleExtRequest: (_method: string, _schema: unknown, callback: unknown) =>
        Effect.sync(() => { handler = callback as typeof handler; }),
    },
  };
  const ready = Effect.runPromise(registerSubpolarCredentialExtension({
    host: host as never,
    instanceId,
    providerIds: ["openai"],
    context: context as never,
  }));
  return {
    ready,
    invoke: async (request: Record<string, unknown>) => {
      await ready;
      if (!handler) throw new Error("Extension handler was not registered");
      return Effect.runPromise(handler(request));
    },
    stored: () => {
      const bytes = host.records.get(`subpolar-pi\0${instanceId}`);
      return bytes ? JSON.parse(new TextDecoder().decode(bytes)) : undefined;
    },
  };
}

it("keeps Pi credential operations inside the bound ACP session and persists refresh updates", async () => {
  const harness = makeHarness();
  const base = { sessionId: "worker-session" };
  const begun = await harness.invoke({ ...base, operation: "beginModify", providerId: "openai" }) as { transactionId: string; credential?: unknown };
  assert.isUndefined(begun.credential);
  const updated = { ...credential, access: "rotated-access" };
  await harness.invoke({ ...base, operation: "commitModify", providerId: "openai", transactionId: begun.transactionId, credential: updated });
  assert.deepEqual(harness.stored(), { version: 1, credentials: { openai: updated } });
  assert.deepEqual(await harness.invoke({
    ...base,
    operation: "read",
    providerId: "openai",
    instanceId: "attacker-selected-instance",
    namespace: "attacker-selected-namespace",
    path: "/home/worker/.pi/agent/auth.json",
  }), { credential: updated });
  assert.deepEqual(await harness.invoke({ ...base, operation: "list" }), { credentials: [{ providerId: "openai", type: "oauth" }] });
  await harness.invoke({ ...base, operation: "delete", providerId: "openai" });
  assert.isUndefined(harness.stored());
});

it("rejects stale sessions and transactions from another T3 thread", async () => {
  const instanceId = `broker-test-${randomUUID()}`;
  const harness = makeHarness("worker-session", "thread-a", instanceId);
  const error = await harness.invoke({ sessionId: "other-session", operation: "read", providerId: "openai" }).then(
    () => undefined,
    (cause: unknown) => cause,
  );
  assert.instanceOf(error, AcpErrors.AcpRequestError);
  assert.include((error as Error).message, "active ACP session");

  const begun = await harness.invoke({ sessionId: "worker-session", operation: "beginModify", providerId: "openai" }) as { transactionId: string };
  const crossed = makeHarness("worker-session", "thread-b", instanceId);
  const crossError = await crossed.invoke({
    sessionId: "worker-session",
    operation: "commitModify",
    providerId: "openai",
    transactionId: begun.transactionId,
    credential,
  }).then(() => undefined, (cause: unknown) => cause);
  assert.instanceOf(crossError, AcpErrors.AcpRequestError);
});

it("does not accept caller-selected storage bindings or include secrets in broker failures", async () => {
  const harness = makeHarness();
  const error = await harness.invoke({
    sessionId: "worker-session",
    operation: "commitModify",
    providerId: "openai",
    transactionId: "not-a-transaction",
    credential,
    instanceId: "attacker-selected-instance",
    path: "/home/worker/.pi/agent/auth.json",
  }).then(() => undefined, (cause: unknown) => cause);
  assert.instanceOf(error, AcpErrors.AcpRequestError);
  assert.notInclude((error as Error).message, "secret-canary");
  assert.notInclude(JSON.stringify(error), "secret-canary");
});

it("keeps seeded Pi credentials isolated per ACP provider instance", async () => {
  const host = makeCredentialHost();
  const instanceA = `broker-instance-a-${randomUUID()}`;
  const instanceB = `broker-instance-b-${randomUUID()}`;
  const harnessA = makeHarness("worker-a", "thread-a", instanceA, host);
  const harnessB = makeHarness("worker-b", "thread-b", instanceB, host);

  await Effect.runPromise(setPiCredential({ host: host as never, instanceId: instanceA, providerId: "openai", credential }));

  assert.deepEqual(await harnessA.invoke({ sessionId: "worker-a", operation: "read", providerId: "openai" }), { credential });
  assert.deepEqual(await harnessB.invoke({ sessionId: "worker-b", operation: "read", providerId: "openai" }), { credential: undefined });
  assert.isTrue(host.records.has(`subpolar-pi\0${instanceA}`));
  assert.isFalse(host.records.has(`subpolar-pi\0${instanceB}`));
});
