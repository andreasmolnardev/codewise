import { assert, it } from "@effect/vitest";

import { createAcpCredentialStore } from "./credentialStore.ts";

it("performs Pi credential mutations through the bound ACP session", async () => {
  const requests: Array<{ method: string; payload: unknown }> = [];
  const credential = { type: "oauth", access: "before", refresh: "refresh", expires: 99 };
  const client = {
    raw: {
      request: async (method: string, payload: unknown) => {
        requests.push({ method, payload });
        const input = payload as { operation: string };
        if (input.operation === "read") return { credential };
        if (input.operation === "beginModify") return { transactionId: "txn-1", credential };
        if (input.operation === "commitModify") return { credential: (payload as { credential?: unknown }).credential };
        return { ok: true };
      },
    },
  };
  const store = createAcpCredentialStore(client, "worker-session");
  assert.deepEqual(await store.read("openai"), credential);
  const updated = await store.modify("openai", async (current) => ({ ...current!, access: "after" }));
  assert.deepEqual(updated, { ...credential, access: "after" });
  await store.delete("openai");
  assert.isTrue(requests.every(({ payload }) => (payload as { sessionId?: string }).sessionId === "worker-session"));
  assert.deepEqual(requests.map(({ payload }) => (payload as { operation: string }).operation), [
    "read", "beginModify", "commitModify", "delete",
  ]);
});
