#!/usr/bin/env node
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import { writeFile } from "node:fs/promises";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import type { EnvironmentManager, EnvironmentRequest } from "@subpolar/environments";
import type { EnvironmentManagedSessionRequest } from "@subpolar/environments";
import { makeInMemoryStdio } from "../../packages/effect-acp/src/_internal/stdio.ts";
import { createWorkerExecutionOptions } from "../../packages/subpolar-acp/src/workerExecution.ts";
import { layerManagedStdio } from "../../packages/subpolar-acp/src/managedProxy.ts";
import { layerStdio } from "../../packages/subpolar-acp/src/index.ts";

type OutputChunk = { readonly data: Uint8Array } | null;

function outputQueue() {
  const chunks: OutputChunk[] = [];
  const waiters: Array<(chunk: OutputChunk) => void> = [];
  let ended = false;
  return {
    push(data: Uint8Array) {
      const waiter = waiters.shift();
      if (waiter) waiter({ data });
      else chunks.push({ data });
    },
    take(): Promise<OutputChunk> {
      const chunk = chunks.shift();
      if (chunk !== undefined) return Promise.resolve(chunk);
      if (ended) return Promise.resolve(null);
      return new Promise((resolve) => waiters.push(resolve));
    },
    end() {
      ended = true;
      for (const waiter of waiters.splice(0)) waiter(null);
    },
  };
}

const reportPath = process.env.SUBPOLAR_TEST_REPORT_FILE;
const report: Record<string, unknown> = { starts: [], executions: [], terminations: [] };
const saveReport = async () => {
  if (reportPath) await writeFile(reportPath, JSON.stringify(report));
};

interface Worker {
  readonly target: EnvironmentRequest;
  readonly scope: Scope.Scope;
  readonly input: Queue.Queue<Uint8Array, Cause.Done<void>>;
  readonly rawOutput: Queue.Queue<string>;
  readonly output: ReturnType<typeof outputQueue>;
  readonly pumpDone: Promise<void>;
}

const workers = new Map<string, Worker>();
let nextSession = 0;
const manager = {
  async startManagedSession(target: EnvironmentRequest, command: readonly string[], processRequest?: EnvironmentManagedSessionRequest) {
    const request = processRequest ?? {};
    const { stdio, input, output } = await Effect.runPromise(makeInMemoryStdio());
    const scope = await Effect.runPromise(Scope.make());
    const stream = outputQueue();
    const sessionId = `managed-mock-${++nextSession}`;
    (report.starts as unknown[]).push({ target, command, process: request });

    const workerOptions = createWorkerExecutionOptions(request.environment ?? {}, {
      workspaceRoot: target.worktreePath,
    });
    const worker = layerStdio({
      ...workerOptions,
      executeTool: async (call, _definition, context) => {
        (report.executions as unknown[]).push({ call, cwd: context.cwd });
        await saveReport();
        return { ok: true, value: { exitCode: 0, stdout: `cwd=${context.cwd}`, stderr: "", cancelled: false } };
      },
      executorFactory: async () => ({
        async execute(execution) {
          const toolResult = await execution.tools!.call({
            callId: "managed-mock-pi-tool",
            toolId: "internal/worker/execute",
            input: { command: ["pwd"] },
          });
          await execution.emit({ type: "text", data: { text: `mock Pi answered; tool result: ${JSON.stringify(toolResult)}` } });
          return `mock Pi answered; tool result: ${JSON.stringify(toolResult)}`;
        },
      }),
    });
    await Effect.runPromise(Layer.buildWithScope(worker, scope));
    const pumpDone = (async () => {
      try {
        while (true) {
          const chunk = await Effect.runPromise(Queue.take(output));
          stream.push(new TextEncoder().encode(chunk));
        }
      } catch {
        stream.end();
      }
    })();
    workers.set(sessionId, { target, scope, input, rawOutput: output, output: stream, pumpDone });
    await saveReport();
    return { sessionId, outputSequence: 0 };
  },
  async writeManagedSession(_target: EnvironmentRequest, sessionId: string, data: Uint8Array) {
    const worker = workers.get(sessionId);
    if (!worker) throw new Error(`Unknown fake managed session ${sessionId}`);
    await Effect.runPromise(Queue.offer(worker.input, data));
  },
  async *attachManagedSessionOutput(_target: EnvironmentRequest, sessionId: string) {
    const worker = workers.get(sessionId);
    if (!worker) throw new Error(`Unknown fake managed session ${sessionId}`);
    let sequence = 0;
    while (true) {
      const chunk = await worker.output.take();
      if (!chunk) {
        yield { type: "exit", sequence: ++sequence, exitCode: 0, signal: null };
        return;
      }
      yield { type: "output", sequence: ++sequence, stream: "stdout", data: chunk.data };
    }
  },
  async terminateManagedSession(_target: EnvironmentRequest, sessionId: string) {
    const worker = workers.get(sessionId);
    if (!worker) return;
    workers.delete(sessionId);
    (report.terminations as string[]).push(sessionId);
    await Effect.runPromise(Scope.close(worker.scope, Exit.void));
    await Effect.runPromise(Queue.shutdown(worker.input));
    await Effect.runPromise(Queue.shutdown(worker.rawOutput));
    await worker.pumpDone;
    worker.output.end();
    await saveReport();
  },
} as unknown as EnvironmentManager;

const program = layerManagedStdio({ environment: process.env, manager });
Layer.launch(Layer.provide(program, NodeServices.layer)).pipe(NodeRuntime.runMain);
