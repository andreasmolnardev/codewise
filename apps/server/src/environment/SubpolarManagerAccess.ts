import { createHash } from "node:crypto";
import path from "node:path";

import { createEnvironmentManagerHttpClient } from "@subpolar/environments/manager-client";
import type { EnvironmentRequest } from "@subpolar/environments";

export interface SubpolarManagerConnection {
  readonly baseUrl: string;
  readonly storageRoot: string;
  readonly allowPrivateHttp: boolean;
  readonly fetch?: typeof fetch;
}

export interface SubpolarProviderInstanceAccess {
  readonly providerInstanceId: string | null;
  readonly instanceToken: string | undefined;
  readonly worktreePath: string | null;
}

/** Resolve manager authority from the selected server-side provider instance. */
export function createSubpolarManagerAccess(
  connection: SubpolarManagerConnection,
  access: SubpolarProviderInstanceAccess,
): {
  readonly manager: ReturnType<typeof createEnvironmentManagerHttpClient>;
  /** Opaque identity for caches that must be invalidated when credentials rotate. */
  readonly cacheIdentity: string;
  readonly environment: EnvironmentRequest;
} {
  const providerInstanceId = access.providerInstanceId?.trim();
  const instanceToken = access.instanceToken?.trim();
  const worktreePath = access.worktreePath;
  const storageRoot = connection.storageRoot.trim();
  if (!providerInstanceId)
    throw new Error("Managed Subpolar execution requires an authorized provider instance");
  if (!instanceToken)
    throw new Error("Managed Subpolar execution requires a provider-instance manager token");
  if (!path.isAbsolute(storageRoot))
    throw new Error("Managed Subpolar storage root must be an absolute path");
  if (!worktreePath || !path.isAbsolute(worktreePath)) {
    throw new Error("Managed Subpolar execution requires an absolute T3 worktree");
  }

  const normalizedStorageRoot = path.resolve(storageRoot);
  const normalizedWorktreePath = path.resolve(worktreePath);
  const baseUrl = connection.baseUrl.trim();
  const relative = path.relative(normalizedStorageRoot, normalizedWorktreePath);
  if (
    relative === "" ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new Error("Managed Subpolar worktree must be inside its configured storage root");
  }

  return {
    manager: createEnvironmentManagerHttpClient({
      baseUrl,
      token: instanceToken,
      allowPrivateHttp: connection.allowPrivateHttp,
      ...(connection.fetch === undefined ? {} : { fetch: connection.fetch }),
    }),
    cacheIdentity: createHash("sha256")
      .update(baseUrl)
      .update("\0")
      .update(instanceToken)
      .update("\0")
      .update(providerInstanceId)
      .digest("hex"),
    environment: {
      // Manager owner scope comes from T3's selected provider instance, never
      // from an environment variable supplied by a terminal client.
      ownerId: providerInstanceId,
      workspaceId: `ws_${createHash("sha256").update(normalizedWorktreePath).digest("hex").slice(0, 24)}`,
      storageRoot: normalizedStorageRoot,
      worktreePath: normalizedWorktreePath,
    },
  };
}
