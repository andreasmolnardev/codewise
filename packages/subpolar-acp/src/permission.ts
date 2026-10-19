export type AcpPermissionResponse = {
  readonly outcome:
    | { readonly outcome: "selected"; readonly optionId: string }
    | { readonly outcome: "cancelled" }
    | { readonly outcome: string; readonly optionId?: string };
};

export class AcpPermissionBridgeError extends Error {
  readonly code: "SESSION_UNAVAILABLE" | "REQUEST_FAILED";

  constructor(code: AcpPermissionBridgeError["code"], cause?: unknown) {
    super(
      code === "SESSION_UNAVAILABLE"
        ? "The ACP permission request has no active session"
        : "The ACP permission request failed",
      { cause },
    );
    this.name = "AcpPermissionBridgeError";
    this.code = code;
  }
}

function abortError(): Error {
  return new DOMException("The ACP permission request was cancelled", "AbortError");
}

/** A rejection is a decision; bridge failures and cancellation are execution failures. */
export async function awaitAcpPermissionDecision(
  sessionId: string | undefined,
  request: (sessionId: string) => Promise<AcpPermissionResponse>,
  signal?: AbortSignal,
): Promise<boolean> {
  if (!sessionId) throw new AcpPermissionBridgeError("SESSION_UNAVAILABLE");
  if (signal?.aborted) throw abortError();

  try {
    const pending = request(sessionId);
    const response = signal
      ? await new Promise<AcpPermissionResponse>((resolve, reject) => {
          let settled = false;
          const cleanup = () => signal.removeEventListener("abort", onAbort);
          const finish = <A>(settle: (value: A) => void, value: A) => {
            if (settled) return;
            settled = true;
            cleanup();
            settle(value);
          };
          const onAbort = () => finish(reject, abortError());
          signal.addEventListener("abort", onAbort, { once: true });
          if (signal.aborted) onAbort();
          pending.then(
            (value) => finish(resolve, value),
            (error: unknown) => finish(reject, error),
          );
        })
      : await pending;
    if (response.outcome.outcome === "cancelled") throw abortError();
    if (response.outcome.outcome !== "selected") {
      throw new AcpPermissionBridgeError("REQUEST_FAILED");
    }
    if (response.outcome.optionId === "allow-once") return true;
    if (response.outcome.optionId === "reject-once") return false;
    throw new AcpPermissionBridgeError("REQUEST_FAILED");
  } catch (cause) {
    if (signal?.aborted) throw abortError();
    if (cause instanceof DOMException && cause.name === "AbortError") throw cause;
    throw new AcpPermissionBridgeError("REQUEST_FAILED", cause);
  }
}
