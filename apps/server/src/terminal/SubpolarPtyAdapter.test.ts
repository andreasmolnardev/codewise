// @effect-diagnostics nodeBuiltinImport:off -- This plain Node test hashes unique fixture IDs.
import { createHash } from "node:crypto";

import { createEnvironmentManagerHttpClient } from "@subpolar/environments/manager-client";
import {
  createEnvironmentManagerHttpHandler,
  type EnvironmentManagerInstanceCredential,
} from "@subpolar/environments/manager-http";
import type { EnvironmentManager, EnvironmentRequest } from "@subpolar/environments";
import * as Effect from "effect/Effect";
import { expect, test } from "vite-plus/test";

import { makeSubpolarTerminalSpawner } from "./SubpolarPtyAdapter.ts";

const ADMIN_TOKEN = "manager-admin-token-with-more-than-thirty-two-characters";
const INSTANCE_TOKEN = "provider-instance-token-with-more-than-thirty-two-characters";
const PROVIDER_INSTANCE_ID = "subpolar_team_a";

test("managed PTY uses the selected provider instance's scoped manager credential and owner", async () => {
  const storageRoot = "/workspaces";
  const worktreePath = "/workspaces/worktree";
  let receivedRequest: EnvironmentRequest | undefined;
  const manager = {
    startInteractive: async (request: EnvironmentRequest) => {
      receivedRequest = request;
      return { sessionId: "session-a", outputSequence: 0 };
    },
    resizeInteractive: async () => undefined,
    terminateInteractive: async () => undefined,
  } as unknown as EnvironmentManager;
  const credentials: EnvironmentManagerInstanceCredential[] = [
    {
      token: INSTANCE_TOKEN,
      ownerId: PROVIDER_INSTANCE_ID,
      storageRoot,
      allowedOperations: ["pty"],
    },
  ];
  const handler = createEnvironmentManagerHttpHandler(manager, ADMIN_TOKEN, credentials);
  const managerFetch: typeof fetch = (input, init) => handler(new Request(input, init));
  const baseUrl = "http://127.0.0.1:8787";
  const workspaceId = `ws_${createHash("sha256").update(worktreePath).digest("hex").slice(0, 24)}`;
  const request: EnvironmentRequest = {
    ownerId: PROVIDER_INSTANCE_ID,
    workspaceId,
    storageRoot,
    worktreePath,
  };

  // The gateway's administrator credential is intentionally not authorized
  // for PTY operations; this proves the adapter must use the instance token.
  const adminClient = createEnvironmentManagerHttpClient({
    baseUrl,
    token: ADMIN_TOKEN,
    fetch: managerFetch,
  });
  await expect(
    adminClient.startInteractive(request, ["/bin/bash"], { cwd: "." }),
  ).rejects.toMatchObject({ code: "BACKEND_FAILURE" });
  expect(receivedRequest).toBeUndefined();

  const spawn = makeSubpolarTerminalSpawner(
    {
      SUBPOLAR_MANAGER_URL: baseUrl,
      SUBPOLAR_MANAGER_TOKEN: ADMIN_TOKEN,
      SUBPOLAR_STORAGE_ROOT: storageRoot,
    },
    managerFetch,
  );
  expect(spawn).toBeDefined();
  if (!spawn) return;
  await Effect.runPromise(
    spawn({
      providerInstanceId: PROVIDER_INSTANCE_ID,
      threadId: "thread-a",
      terminalId: "terminal-a",
      worktreePath,
      cwd: worktreePath,
      shell: "/bin/bash",
      args: ["-l"],
      cols: 80,
      rows: 24,
      env: {
        SUBPOLAR_MANAGER_INSTANCE_TOKEN: INSTANCE_TOKEN,
        SUBPOLAR_OWNER_ID: "forged-owner",
        SUBPOLAR_PROVIDER_INSTANCE_ID: "forged-provider",
        TERM: "xterm-256color",
      },
    }),
  );

  expect(receivedRequest).toEqual(request);
});

test("managed PTY fails closed without the provider instance token even when an admin token exists", async () => {
  const spawn = makeSubpolarTerminalSpawner({
    SUBPOLAR_MANAGER_URL: "http://127.0.0.1:8787",
    SUBPOLAR_MANAGER_TOKEN: ADMIN_TOKEN,
    SUBPOLAR_STORAGE_ROOT: "/workspaces",
  });
  expect(spawn).toBeDefined();
  if (!spawn) return;

  const exit = await Effect.runPromiseExit(
    spawn({
      providerInstanceId: PROVIDER_INSTANCE_ID,
      threadId: "thread-a",
      terminalId: "terminal-a",
      worktreePath: "/workspaces/worktree",
      cwd: "/workspaces/worktree",
      shell: "/bin/bash",
      args: [],
      cols: 80,
      rows: 24,
      env: { SUBPOLAR_OWNER_ID: PROVIDER_INSTANCE_ID },
    }),
  );

  expect(exit._tag).toBe("Failure");
});
