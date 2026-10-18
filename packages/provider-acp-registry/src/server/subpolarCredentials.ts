import { randomUUID } from "node:crypto";

import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as AcpErrors from "effect-acp/errors";

import type * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import type { AcpAdapterV2ExtensionContext } from "@t3tools/provider-acp/server/adapter";

const METHOD = "subpolar/credentials";
const MAX_STORE_BYTES = 256 * 1024;
const MAX_CREDENTIAL_BYTES = 64 * 1024;
const MAX_TRANSACTION_MS = 30_000;

const Request = Schema.Struct({
  sessionId: Schema.String,
  operation: Schema.Literals(["read", "list", "beginModify", "commitModify", "abortModify", "delete"]),
  providerId: Schema.optional(Schema.String),
  transactionId: Schema.optional(Schema.String),
  credential: Schema.optional(Schema.Unknown),
});

type Credential = Readonly<Record<string, unknown>>;
type CredentialMap = Record<string, Credential>;
type Transaction = {
  readonly id: string;
  readonly threadId: string;
  readonly sessionId: string;
  readonly providerId: string;
  readonly timer: ReturnType<typeof setTimeout>;
  readonly release: () => void;
};

const transactionsByInstance = new Map<string, Map<string, Transaction>>();
// ProviderCredentials has no compare-and-set operation, so this mutex closes
// same-process races across threads using one provider instance. Separate T3
// server processes sharing the same credential backend can still race.
const tailsByInstance = new Map<string, Promise<void>>();

export function isPiCredential(value: unknown): value is Credential {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  if (candidate.type === "api_key") {
    return (candidate.key === undefined || typeof candidate.key === "string") &&
      (candidate.env === undefined || (typeof candidate.env === "object" && candidate.env !== null && !Array.isArray(candidate.env)));
  }
  return candidate.type === "oauth" && typeof candidate.access === "string" &&
    typeof candidate.refresh === "string" && typeof candidate.expires === "number";
}

export function parsePiCredentialStore(bytes: Uint8Array | undefined): CredentialMap {
  if (!bytes) return {};
  if (bytes.byteLength > MAX_STORE_BYTES) throw new Error("Credential store is invalid");
  const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || !("credentials" in parsed)) {
    throw new Error("Credential store is invalid");
  }
  const records = (parsed as { credentials: unknown }).credentials;
  if (!records || typeof records !== "object" || Array.isArray(records)) throw new Error("Credential store is invalid");
  const result: CredentialMap = Object.create(null) as CredentialMap;
  for (const [providerId, credential] of Object.entries(records)) {
    if (!isPiProviderId(providerId) || !isPiCredential(credential)) throw new Error("Credential store is invalid");
    result[providerId] = credential;
  }
  return result;
}

export function isPiProviderId(value: string): boolean {
  return value.length > 0 && value.length <= 128 && /^[A-Za-z0-9._-]+$/.test(value);
}

export function encodePiCredentialStore(credentials: CredentialMap): Uint8Array {
  const encoded = new TextEncoder().encode(JSON.stringify({ version: 1, credentials }));
  if (encoded.byteLength > MAX_STORE_BYTES) throw new Error("Credential store capacity exceeded");
  return encoded;
}

export function setPiCredential(input: {
  readonly host: ProviderHost.ProviderHost["Service"];
  readonly instanceId: string;
  readonly providerId: string;
  readonly credential: unknown;
}) {
  return Effect.gen(function* () {
    if (!isPiProviderId(input.providerId) || !isPiCredential(input.credential)) {
      return yield* Effect.fail(new Error("Pi credential is invalid"));
    }
    const encodedCredential = new TextEncoder().encode(JSON.stringify(input.credential));
    if (encodedCredential.byteLength > MAX_CREDENTIAL_BYTES) {
      return yield* Effect.fail(new Error("Pi credential is too large"));
    }
    const release = yield* Effect.promise(() => acquireInstanceLock(input.instanceId));
    yield* Effect.gen(function* () {
      const store = yield* input.host.credentials("subpolar-pi", input.instanceId);
      const current = yield* store.get;
      const credentials = yield* Effect.try({
        try: () => parsePiCredentialStore(Option.getOrUndefined(current)),
        catch: () => new Error("Credential store is invalid"),
      });
      credentials[input.providerId] = input.credential;
      yield* store.set(encodePiCredentialStore(credentials));
    }).pipe(Effect.ensuring(Effect.sync(release)));
  });
}

export function removePiCredential(input: {
  readonly host: ProviderHost.ProviderHost["Service"];
  readonly instanceId: string;
  readonly providerId: string;
}) {
  return Effect.gen(function* () {
    const release = yield* Effect.promise(() => acquireInstanceLock(input.instanceId));
    yield* Effect.gen(function* () {
      const store = yield* input.host.credentials("subpolar-pi", input.instanceId);
      const current = yield* store.get;
      const credentials = yield* Effect.try({
        try: () => parsePiCredentialStore(Option.getOrUndefined(current)),
        catch: () => new Error("Credential store is invalid"),
      });
      delete credentials[input.providerId];
      if (Object.keys(credentials).length === 0) yield* store.remove;
      else yield* store.set(encodePiCredentialStore(credentials));
    }).pipe(Effect.ensuring(Effect.sync(release)));
  });
}

function acquireInstanceLock(instanceId: string): Promise<() => void> {
  const previous = tailsByInstance.get(instanceId) ?? Promise.resolve();
  let release!: () => void;
  const next = new Promise<void>((resolve) => { release = resolve; });
  const tail = previous.then(() => next);
  tailsByInstance.set(instanceId, tail);
  return previous.then(() => () => {
    release();
    if (tailsByInstance.get(instanceId) === tail) tailsByInstance.delete(instanceId);
  });
}

function finishTransaction(instanceId: string, id: string): void {
  const transactions = transactionsByInstance.get(instanceId);
  const transaction = transactions?.get(id);
  if (!transaction) return;
  clearTimeout(transaction.timer);
  transaction.release();
  transactions!.delete(id);
  if (transactions!.size === 0) transactionsByInstance.delete(instanceId);
}

function requestFailure(message: string): Effect.Effect<never, AcpErrors.AcpError> {
  return Effect.fail(AcpErrors.AcpRequestError.invalidRequest(message));
}

/** Registers an opt-in Pi CredentialStore bridge for one ACP registry instance and thread. */
export function registerSubpolarCredentialExtension(input: {
  readonly host: ProviderHost.ProviderHost["Service"];
  readonly instanceId: string;
  readonly providerIds: ReadonlyArray<string>;
  readonly context: AcpAdapterV2ExtensionContext;
}) {
  const { host, instanceId, context } = input;
  const providerIds = new Set(input.providerIds.filter(isPiProviderId));
  return Effect.gen(function* () {
    const store = yield* host.credentials("subpolar-pi", instanceId);
    const readMap = Effect.gen(function* () {
      const stored = yield* store.get;
      return yield* Effect.try({
        try: () => parsePiCredentialStore(Option.getOrUndefined(stored)),
        catch: () => new Error("Credential store is invalid"),
      });
    });
    const persist = (credentials: CredentialMap) => Effect.gen(function* () {
      if (Object.keys(credentials).length === 0) yield* store.remove;
      else yield* store.set(encodePiCredentialStore(credentials));
    });
    yield* context.runtime.handleExtRequest(METHOD, Request, (request) => Effect.gen(function* () {
      const activeSessionId = yield* context.activeSessionId;
      if (!request.sessionId || request.sessionId !== activeSessionId) {
        return yield* requestFailure("Credential request is not bound to the active ACP session");
      }
      if (request.providerId !== undefined && !isPiProviderId(request.providerId)) {
        return yield* requestFailure("Credential provider ID is invalid");
      }
      const providerId = request.providerId;
      if (providerId !== undefined && !providerIds.has(providerId)) {
        return yield* requestFailure("Credential provider is not enabled for this instance");
      }
      const transactions = transactionsByInstance.get(instanceId);

      switch (request.operation) {
        case "read": {
          if (!providerId) return yield* requestFailure("Credential provider ID is required");
          const credentials = yield* readMap;
          return { credential: credentials[providerId] };
        }
        case "list": {
          const credentials = yield* readMap;
          return { credentials: Object.entries(credentials)
            .filter(([id]) => providerIds.has(id))
            .map(([id, credential]) => ({ providerId: id, type: credential.type })) };
        }
        case "beginModify": {
          if (!providerId) return yield* requestFailure("Credential provider ID is required");
          const release = yield* Effect.promise(() => acquireInstanceLock(instanceId));
          const credentials = yield* readMap.pipe(Effect.onError(() => Effect.sync(release)));
          const transactionId = randomUUID();
          const records = transactionsByInstance.get(instanceId) ?? new Map<string, Transaction>();
          const timer = setTimeout(() => finishTransaction(instanceId, transactionId), MAX_TRANSACTION_MS);
          timer.unref();
          records.set(transactionId, { id: transactionId, threadId: context.threadId, sessionId: request.sessionId, providerId, timer, release });
          transactionsByInstance.set(instanceId, records);
          return { transactionId, credential: credentials[providerId] };
        }
        case "commitModify": {
          if (!request.transactionId) return yield* requestFailure("Credential transaction is required");
          const transaction = transactions?.get(request.transactionId);
          if (!transaction || transaction.threadId !== context.threadId || transaction.sessionId !== request.sessionId || transaction.providerId !== providerId) {
            return yield* requestFailure("Credential transaction is invalid or expired");
          }
          if (request.credential !== undefined) {
            if (!isPiCredential(request.credential) || new TextEncoder().encode(JSON.stringify(request.credential)).byteLength > MAX_CREDENTIAL_BYTES) {
              return yield* requestFailure("Credential value is invalid");
            }
          }
          return yield* Effect.gen(function* () {
            const credentials = yield* readMap;
            if (request.credential !== undefined) credentials[transaction.providerId] = request.credential;
            yield* persist(credentials);
            const committed = credentials[transaction.providerId];
            finishTransaction(instanceId, transaction.id);
            return { credential: committed };
          }).pipe(Effect.onError(() => Effect.sync(() => finishTransaction(instanceId, transaction.id))));
        }
        case "abortModify": {
          if (!request.transactionId) return { ok: true };
          const transaction = transactions?.get(request.transactionId);
          if (transaction?.threadId === context.threadId && transaction.sessionId === request.sessionId) finishTransaction(instanceId, transaction.id);
          return { ok: true };
        }
        case "delete": {
          if (!providerId) return yield* requestFailure("Credential provider ID is required");
          const release = yield* Effect.promise(() => acquireInstanceLock(instanceId));
          yield* readMap.pipe(Effect.flatMap((credentials) => {
            delete credentials[providerId];
            return persist(credentials);
          }), Effect.ensuring(Effect.sync(release)));
          return { ok: true };
        }
      }
    }).pipe(Effect.mapError((cause) =>
      cause instanceof AcpErrors.AcpRequestError
        ? cause
        : AcpErrors.AcpRequestError.invalidRequest("Credential operation failed"),
    )));
  });
}
