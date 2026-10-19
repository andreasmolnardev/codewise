// @effect-diagnostics globalFetch:off -- This plain Node test drives the local preview HTTP tunnel.
import { describe, expect, it } from "vite-plus/test";
import type { EnvironmentManager, EnvironmentRequest } from "@subpolar/environments";
import { makeSubpolarPreviewRouting } from "./SubpolarPreviewRouting.ts";

const responseBytes = new TextEncoder().encode(
  "HTTP/1.1 200 OK\r\nContent-Length: 8\r\nConnection: close\r\n\r\nsubpolar",
);

describe("Subpolar preview routing", () => {
  it("resolves the current thread target and tunnels its localhost port", async () => {
    const seen: Array<{ worktree: string; port: number }> = [];
    const targets = new Map<string, EnvironmentRequest>([
      [
        "thread-a",
        { ownerId: "pi-a", workspaceId: "a", storageRoot: "/storage", worktreePath: "/storage/a" },
      ],
      [
        "thread-b",
        { ownerId: "pi-b", workspaceId: "b", storageRoot: "/storage", worktreePath: "/storage/b" },
      ],
    ]);
    let sessionCount = 0;
    const manager = {
      startPortTunnel: async (environment: EnvironmentRequest, port: number) => {
        seen.push({ worktree: environment.worktreePath, port });
        return { sessionId: `session-${++sessionCount}`, outputSequence: 0 };
      },
      writeManagedSession: async () => undefined,
      attachManagedSessionOutput: async function* () {
        yield {
          type: "output" as const,
          sequence: 1,
          stream: "stdout" as const,
          data: responseBytes,
        };
      },
      terminateManagedSession: async () => undefined,
    } as unknown as EnvironmentManager;
    const routing = makeSubpolarPreviewRouting(async (threadId) => {
      const environment = targets.get(threadId);
      if (!environment) throw new Error("missing target");
      return { manager, environment, cacheIdentity: `credential:${environment.ownerId}` };
    });

    try {
      const routedA = await routing.rewrite("thread-a", "http://localhost:3000/a?x=1");
      const routedB = await routing.rewrite("thread-b", "http://127.0.0.1:3000/b");
      expect(routedA).not.toBeNull();
      expect(routedB).not.toBeNull();
      const [responseA, responseB] = await Promise.all([fetch(routedA!), fetch(routedB!)]);
      expect(await responseA.text()).toBe("subpolar");
      expect(await responseB.text()).toBe("subpolar");
      expect(seen.toSorted((left, right) => left.worktree.localeCompare(right.worktree))).toEqual([
        { worktree: "/storage/a", port: 3000 },
        { worktree: "/storage/b", port: 3000 },
      ]);
    } finally {
      await routing.close();
    }
  });

  it("does not intercept remote requests and fails closed when target resolution fails", async () => {
    const remoteRouting = makeSubpolarPreviewRouting(async () => {
      throw new Error("must not resolve remote URL");
    });
    await expect(remoteRouting.rewrite("thread", "https://example.com/")).resolves.toBeNull();

    const managedRouting = makeSubpolarPreviewRouting(async () => {
      throw new Error("manager credentials are missing");
    });
    await expect(managedRouting.rewrite("thread", "http://localhost:3000/")).rejects.toThrow(
      "manager credentials are missing",
    );
    await remoteRouting.close();
    await managedRouting.close();
  });
});
