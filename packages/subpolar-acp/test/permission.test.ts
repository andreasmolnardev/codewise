import { expect, it as test } from "@effect/vitest";
import { AcpPermissionBridgeError, awaitAcpPermissionDecision } from "../src/permission.ts";

test("only an explicit ACP reject is a denial", async () => {
  const rejected = await awaitAcpPermissionDecision("session-1", async () => ({
    outcome: { outcome: "selected", optionId: "reject-once" },
  }));

  expect(rejected).toBe(false);
});

test("an ACP cancelled response is interrupted rather than denied", async () => {
  let failure: unknown;
  try {
    await awaitAcpPermissionDecision("session-1", async () => ({
      outcome: { outcome: "cancelled" },
    }));
  } catch (error) {
    failure = error;
  }

  expect(failure).toBeInstanceOf(DOMException);
  expect((failure as DOMException).name).toBe("AbortError");
});

test("a missing ACP session is a bridge failure, not a user denial", async () => {
  let requested = false;
  let failure: unknown;
  try {
    await awaitAcpPermissionDecision(undefined, async () => {
      requested = true;
      return { outcome: { outcome: "selected", optionId: "allow-once" } };
    });
  } catch (error) {
    failure = error;
  }

  expect(failure).toBeInstanceOf(AcpPermissionBridgeError);
  expect((failure as AcpPermissionBridgeError).code).toBe("SESSION_UNAVAILABLE");
  expect(requested).toBe(false);
});

test("an ACP transport failure stays a failure instead of becoming a denial", async () => {
  let failure: unknown;
  try {
    await awaitAcpPermissionDecision("session-1", async () => {
      throw new Error("transport closed");
    });
  } catch (error) {
    failure = error;
  }

  expect(failure).toBeInstanceOf(AcpPermissionBridgeError);
  expect((failure as AcpPermissionBridgeError).code).toBe("REQUEST_FAILED");
  expect((failure as Error).cause).toBeInstanceOf(Error);
});

test("an aborted ACP permission request rejects instead of returning a denial", async () => {
  const controller = new AbortController();
  controller.abort();

  let failure: unknown;
  try {
    await awaitAcpPermissionDecision(
      "session-1",
      async () => ({
        outcome: { outcome: "selected", optionId: "allow-once" },
      }),
      controller.signal,
    );
  } catch (error) {
    failure = error;
  }

  expect(failure).toBeInstanceOf(DOMException);
  expect((failure as DOMException).name).toBe("AbortError");
});
