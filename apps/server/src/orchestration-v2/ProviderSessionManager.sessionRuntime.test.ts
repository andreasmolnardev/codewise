import { assert, it } from "@effect/vitest";
import { ProviderInstanceId, ProviderSessionId, ThreadId } from "@t3tools/contracts";
import { buildSubpolarPiSessionRuntime } from "./ProviderSessionManager.ts";

it("binds a T3 thread and provider instance to Subpolar's persisted Pi session identity", () => {
  const runtime = buildSubpolarPiSessionRuntime({
    threadId: ThreadId.make("thread-1"),
    providerInstanceId: ProviderInstanceId.make("subpolar-instance"),
    providerSessionId: ProviderSessionId.make("subpolar-session"),
    runtimeMode: "approval-required",
    acpSessionId: "acp-session-1",
    lastSeenAt: "2026-10-18T10:00:00.000Z",
  });

  assert.deepEqual(runtime, {
    threadId: ThreadId.make("thread-1"),
    providerName: "subpolar",
    providerInstanceId: ProviderInstanceId.make("subpolar-instance"),
    adapterKey: "subpolar/pi-acp",
    runtimeMode: "approval-required",
    status: "running",
    lastSeenAt: "2026-10-18T10:00:00.000Z",
    resumeCursor: null,
    runtimePayload: {
      subpolar: {
        acpSessionId: "acp-session-1",
        providerSessionId: ProviderSessionId.make("subpolar-session"),
        piSessionId: "7747a9eddc317d5a6a1da52be4f986b23a50fce573ff8b6ddf76a52331c5e276",
      },
    },
  });
});
