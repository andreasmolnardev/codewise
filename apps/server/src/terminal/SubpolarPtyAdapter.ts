import { createHash } from "node:crypto";
import path from "node:path";

import { createEnvironmentManagerHttpClient } from "@subpolar/environments/manager-client";
import type { EnvironmentRequest } from "@subpolar/environments";
import * as Effect from "effect/Effect";

import * as PtyAdapter from "@t3tools/shared/PtyAdapter";

export interface ManagedTerminalSpawnInput {
  readonly threadId: string;
  readonly terminalId: string;
  readonly worktreePath: string | null;
  readonly cwd: string;
  readonly shell: string;
  readonly args: ReadonlyArray<string>;
  readonly cols: number;
  readonly rows: number;
  readonly env: NodeJS.ProcessEnv;
}

export type ManagedTerminalSpawn = (
  input: ManagedTerminalSpawnInput,
) => Effect.Effect<PtyAdapter.PtyProcess, PtyAdapter.PtySpawnError>;

const SAFE_TERMINAL_ENVIRONMENT_KEYS = new Set([
  "COLORTERM",
  "EDITOR",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "LC_MESSAGES",
  "TERM",
  "TZ",
  "VISUAL",
]);

function managedEnvironment(source: NodeJS.ProcessEnv): Record<string, string> {
  const result: Record<string, string> = {
    HOME: "/tmp/home",
    PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    SHELL: "/bin/bash",
    TMPDIR: "/tmp",
    USER: "subpolar",
  };
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined && SAFE_TERMINAL_ENVIRONMENT_KEYS.has(key)) result[key] = value;
  }
  result.TERM ??= "xterm-256color";
  result.COLORTERM ??= "truecolor";
  return result;
}

function requestFor(input: ManagedTerminalSpawnInput, environment: NodeJS.ProcessEnv): {
  readonly request: EnvironmentRequest;
  readonly relativeCwd: string;
  readonly clientSessionId: string;
} {
  const storageRoot = environment.SUBPOLAR_STORAGE_ROOT?.trim();
  const worktreePath = input.worktreePath;
  if (!storageRoot || !path.isAbsolute(storageRoot)) {
    throw new Error("Managed terminal storage root is not configured");
  }
  if (!worktreePath || !path.isAbsolute(worktreePath) || !path.isAbsolute(input.cwd)) {
    throw new Error("Managed terminal requires an absolute T3 worktree and working directory");
  }
  const root = path.resolve(worktreePath);
  const cwd = path.resolve(input.cwd);
  const relativeCwd = path.relative(root, cwd);
  if (relativeCwd === ".." || relativeCwd.startsWith(`..${path.sep}`) || path.isAbsolute(relativeCwd)) {
    throw new Error("Managed terminal working directory is outside its T3 worktree");
  }
  const workspaceId = `ws_${createHash("sha256").update(root).digest("hex").slice(0, 24)}`;
  const terminalKey = createHash("sha256")
    .update(input.threadId)
    .update("\0")
    .update(input.terminalId)
    .digest("hex");
  return {
    request: {
      ownerId: environment.SUBPOLAR_OWNER_ID?.trim() || "t3-installation",
      workspaceId,
      storageRoot,
      worktreePath: root,
    },
    relativeCwd: relativeCwd || ".",
    clientSessionId: `t3-terminal-${terminalKey}`,
  };
}

/**
 * Build the optional T3 terminal adapter for provider instances explicitly
 * allowlisted by the server. The worker receives a small terminal environment,
 * never the gateway's process environment or ACP credentials.
 */
export function makeSubpolarTerminalSpawner(
  environment: NodeJS.ProcessEnv = process.env,
): ManagedTerminalSpawn | undefined {
  const configured = [
    environment.SUBPOLAR_MANAGER_URL,
    environment.SUBPOLAR_MANAGER_TOKEN,
    environment.SUBPOLAR_STORAGE_ROOT,
  ].filter((value) => value?.trim()).length;
  if (configured === 0) return undefined;
  if (configured !== 3) {
    throw new Error(
      "Managed terminals require SUBPOLAR_MANAGER_URL, SUBPOLAR_MANAGER_TOKEN, and SUBPOLAR_STORAGE_ROOT",
    );
  }

  const manager = createEnvironmentManagerHttpClient({
    baseUrl: environment.SUBPOLAR_MANAGER_URL!.trim(),
    token: environment.SUBPOLAR_MANAGER_TOKEN!.trim(),
    allowPrivateHttp: environment.SUBPOLAR_MANAGER_ALLOW_PRIVATE_HTTP === "true",
  });

  return (input) =>
    Effect.tryPromise({
      try: async () => {
        const bound = requestFor(input, environment);
        const session = await manager.startInteractive(
          bound.request,
          [input.shell, ...input.args],
          {
            cwd: bound.relativeCwd,
            environment: managedEnvironment(input.env),
            clientSessionId: bound.clientSessionId,
          },
        );
        try {
          await manager.resizeInteractive(bound.request, session.sessionId, input.cols, input.rows);
        } catch (cause) {
          await manager.terminateInteractive(bound.request, session.sessionId).catch(() => undefined);
          throw cause;
        }
        return new ManagedTerminalPtyProcess(
          manager,
          bound.request,
          session.sessionId,
          session.sequence ?? 0,
        );
      },
      catch: (cause) =>
        new PtyAdapter.PtySpawnError({
          adapter: "subpolar-manager",
          shell: input.shell,
          cause,
        }),
    });
}

let syntheticPid = 0;

class ManagedTerminalPtyProcess implements PtyAdapter.PtyProcess {
  readonly pid = --syntheticPid;
  private readonly outputListeners = new Set<(data: string) => void>();
  private readonly exitListeners = new Set<(event: PtyAdapter.PtyExitEvent) => void>();
  private exitEvent: PtyAdapter.PtyExitEvent | undefined;
  private outputStarted = false;
  private writeQueue: Promise<void> = Promise.resolve();
  private readonly decoder = new TextDecoder();

  constructor(
    private readonly manager: ReturnType<typeof createEnvironmentManagerHttpClient>,
    private readonly environment: EnvironmentRequest,
    private readonly sessionId: string,
    private cursor: number,
  ) {}

  write(data: string): void {
    this.enqueue(() =>
      this.manager.writeInteractive(this.environment, this.sessionId, new TextEncoder().encode(data)),
    );
  }

  resize(cols: number, rows: number): void {
    this.enqueue(() => this.manager.resizeInteractive(this.environment, this.sessionId, cols, rows));
  }

  kill(): void {
    this.enqueue(() => this.manager.terminateInteractive(this.environment, this.sessionId));
  }

  onData(callback: (data: string) => void): () => void {
    this.outputListeners.add(callback);
    if (!this.outputStarted) {
      this.outputStarted = true;
      void this.readOutput();
    }
    return () => this.outputListeners.delete(callback);
  }

  onExit(callback: (event: PtyAdapter.PtyExitEvent) => void): () => void {
    if (this.exitEvent) {
      callback(this.exitEvent);
      return () => undefined;
    }
    this.exitListeners.add(callback);
    return () => this.exitListeners.delete(callback);
  }

  private enqueue(operation: () => Promise<void>): void {
    this.writeQueue = this.writeQueue.then(operation).catch(() => {
      void this.manager.terminateInteractive(this.environment, this.sessionId).catch(() => undefined);
      this.finish({ exitCode: 1, signal: null });
    });
  }

  private async readOutput(): Promise<void> {
    try {
      for await (const event of this.manager.attachInteractiveOutput(this.environment, this.sessionId, this.cursor)) {
        if (event.type === "output") {
          this.cursor = event.sequence;
          const data = this.decoder.decode(event.data, { stream: true });
          if (data) for (const listener of this.outputListeners) listener(data);
          continue;
        }
        const tail = this.decoder.decode();
        if (tail) for (const listener of this.outputListeners) listener(tail);
        this.finish({
          exitCode: event.result.exitCode ?? (event.result.cancelled ? 130 : 1),
          signal: null,
        });
        return;
      }
      this.finish({ exitCode: 1, signal: null });
    } catch {
      this.finish({ exitCode: 1, signal: null });
    }
  }

  private finish(event: PtyAdapter.PtyExitEvent): void {
    if (this.exitEvent) return;
    this.exitEvent = event;
    for (const listener of this.exitListeners) listener(event);
    this.exitListeners.clear();
  }
}
