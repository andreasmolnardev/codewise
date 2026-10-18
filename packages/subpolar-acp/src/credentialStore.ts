type PiCredential = Readonly<Record<string, unknown>>;

interface CredentialClient {
  readonly raw: { request(method: string, payload: unknown): Promise<unknown> };
}

const METHOD = "subpolar/credentials";

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Credential broker returned an invalid response");
  return value as Record<string, unknown>;
}

function credential(value: unknown): PiCredential | undefined {
  if (value === undefined) return undefined;
  const result = object(value);
  if (result.type === "api_key" || result.type === "oauth") return result;
  throw new Error("Credential broker returned an invalid credential");
}

function request(client: CredentialClient, sessionId: string, operation: string, fields: Record<string, unknown> = {}) {
  return client.raw.request(METHOD, { sessionId, operation, ...fields });
}

/** A worker-local Pi CredentialStore whose only backing transport is its private ACP session. */
export function createAcpCredentialStore(client: CredentialClient, sessionId: string) {
  return {
    async read(providerId: string) {
      return credential(object(await request(client, sessionId, "read", { providerId })).credential);
    },
    async list() {
      const result = object(await request(client, sessionId, "list"));
      if (!Array.isArray(result.credentials)) throw new Error("Credential broker returned an invalid list");
      return result.credentials as readonly { providerId: string; type: "api_key" | "oauth" }[];
    },
    async modify(providerId: string, fn: (current: PiCredential | undefined) => Promise<PiCredential | undefined>) {
      const begun = object(await request(client, sessionId, "beginModify", { providerId }));
      if (typeof begun.transactionId !== "string") throw new Error("Credential broker returned an invalid transaction");
      try {
        const current = credential(begun.credential);
        const updated = await fn(current);
        if (updated !== undefined && !credential(updated)) throw new Error("Credential update is invalid");
        const committed = object(await request(client, sessionId, "commitModify", {
          providerId,
          transactionId: begun.transactionId,
          ...(updated === undefined ? {} : { credential: updated }),
        }));
        return credential(committed.credential);
      } catch (error) {
        await request(client, sessionId, "abortModify", { providerId, transactionId: begun.transactionId }).catch(() => undefined);
        throw error;
      }
    },
    async delete(providerId: string) {
      await request(client, sessionId, "delete", { providerId });
    },
  };
}
