import { createServer, type Server, type Socket } from "node:net";
import type {
  EnvironmentManager,
  EnvironmentManagedSessionOutputEvent,
  EnvironmentRequest,
} from "@subpolar/environments";

export interface SubpolarPreviewTarget {
  readonly manager: EnvironmentManager;
  readonly environment: EnvironmentRequest;
  /** Opaque identity that changes when manager authority or endpoint changes. */
  readonly cacheIdentity: string;
}

export type ResolveSubpolarPreviewTarget = (
  threadId: string,
) => Promise<SubpolarPreviewTarget | null>;

interface ForwardedPort {
  readonly server: Server;
  readonly port: number;
  readonly sockets: Set<Socket>;
  closed: boolean;
}

function localPort(url: URL): number | null {
  if (
    url.protocol !== "http:" ||
    (url.hostname !== "localhost" && url.hostname !== "127.0.0.1" && url.hostname !== "[::1]") ||
    url.username !== "" ||
    url.password !== ""
  ) {
    return null;
  }
  const port = url.port === "" ? 80 : Number(url.port);
  return Number.isInteger(port) && port > 0 && port <= 65_535 ? port : null;
}

function environmentKey(environment: EnvironmentRequest): string {
  return JSON.stringify([
    environment.ownerId,
    environment.workspaceId,
    environment.storageRoot,
    environment.worktreePath,
  ]);
}

function isOutputEvent(
  event: EnvironmentManagedSessionOutputEvent | { readonly type: "exit" },
): event is Extract<EnvironmentManagedSessionOutputEvent, { readonly type: "output" }> {
  return event.type === "output";
}

function forwardSocket(
  socket: Socket,
  target: SubpolarPreviewTarget,
  port: number,
  state: ForwardedPort,
): void {
  let sessionId: string | undefined;
  let writeQueue = Promise.resolve();
  let stopped = false;
  socket.pause();

  const stop = () => {
    if (stopped) return;
    stopped = true;
    state.sockets.delete(socket);
    if (sessionId !== undefined) {
      void target.manager
        .terminateManagedSession(target.environment, sessionId)
        .catch(() => undefined);
    }
  };

  socket.on("data", (data) => {
    if (sessionId === undefined || stopped) return;
    const bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength).slice();
    writeQueue = writeQueue.then(() =>
      target.manager.writeManagedSession(target.environment, sessionId!, bytes),
    );
    void writeQueue.catch(() => socket.destroy());
  });
  socket.once("close", stop);
  socket.once("error", stop);

  void (async () => {
    try {
      const started = await target.manager.startPortTunnel(target.environment, port);
      if (stopped || state.closed) {
        await target.manager
          .terminateManagedSession(target.environment, started.sessionId)
          .catch(() => undefined);
        return;
      }
      sessionId = started.sessionId;
      socket.resume();
      for await (const event of target.manager.attachManagedSessionOutput(
        target.environment,
        sessionId,
        started.outputSequence,
      )) {
        if (stopped) return;
        if (!isOutputEvent(event)) break;
        if (!socket.write(Buffer.from(event.data))) {
          await new Promise<void>((resolve) => socket.once("drain", resolve));
        }
      }
      if (!stopped) socket.end();
    } catch {
      if (!stopped) socket.destroy();
    }
  })();
}

async function listenForwarder(
  target: SubpolarPreviewTarget,
  targetPort: number,
): Promise<ForwardedPort> {
  const state: ForwardedPort = {
    server: createServer((socket) => {
      state.sockets.add(socket);
      forwardSocket(socket, target, targetPort, state);
    }),
    port: 0,
    sockets: new Set(),
    closed: false,
  };
  await new Promise<void>((resolve, reject) => {
    state.server.once("error", reject);
    state.server.listen(0, "127.0.0.1", () => {
      state.server.off("error", reject);
      const address = state.server.address();
      if (!address || typeof address === "string") {
        reject(new Error("Subpolar preview tunnel did not bind a TCP port"));
        return;
      }
      (state as { port: number }).port = address.port;
      resolve();
    });
  });
  return state;
}

/** Routes server-browser localhost requests to the manager-owned worktree tunnel. */
export function makeSubpolarPreviewRouting(resolveTarget: ResolveSubpolarPreviewTarget) {
  const forwarders = new Map<string, Promise<ForwardedPort>>();

  const rewrite = async (threadId: string, rawUrl: string): Promise<string | null> => {
    const parsed = new URL(rawUrl);
    const port = localPort(parsed);
    if (port === null) return null;

    const target = await resolveTarget(threadId);
    if (target === null) return null;

    const key = `${target.cacheIdentity}\0${environmentKey(target.environment)}\0${port}`;
    let pending = forwarders.get(key);
    if (!pending) {
      pending = listenForwarder(target, port);
      forwarders.set(key, pending);
      void pending.catch(() => {
        if (forwarders.get(key) === pending) forwarders.delete(key);
      });
    }
    const forwarder = await pending;
    parsed.hostname = "127.0.0.1";
    parsed.port = String(forwarder.port);
    return parsed.toString();
  };

  const close = async () => {
    const values = await Promise.allSettled(forwarders.values());
    forwarders.clear();
    await Promise.all(
      values.flatMap((result) => {
        if (result.status !== "fulfilled") return [];
        const forwarder = result.value;
        forwarder.closed = true;
        for (const socket of forwarder.sockets) socket.destroy();
        return [new Promise<void>((resolve) => forwarder.server.close(() => resolve()))];
      }),
    );
  };

  return { rewrite, close };
}
