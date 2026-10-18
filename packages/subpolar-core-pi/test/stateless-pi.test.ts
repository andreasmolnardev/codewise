import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { createPolicyGateway, createStatelessSubpolarRuntime } from "../../subpolar-core/src/index.ts";
import { createPiStatelessExecutor, createPiSdkExecutorFactory, type PiExecutionRequest, type PiSdkModule, type PiSessionManager } from "../src/index.ts";

function sessionManagerApi() {
  const files = new Map<string, PiSessionManager>();
  const make = (cwd: string, id: string, file?: string): PiSessionManager => ({
    appendMessage() {},
    getCwd: () => cwd,
    getSessionId: () => id,
    getSessionFile: () => file,
    isPersisted: () => file !== undefined,
  });
  return {
    inMemory: (cwd = process.cwd()) => make(cwd, "memory"),
    create: (cwd: string, dir = "/sessions", options?: { id?: string }) => {
      const id = options?.id ?? "new-session";
      const file = `${dir}/${id}.jsonl`;
      const manager = make(cwd, id, file);
      files.set(file, manager);
      return manager;
    },
    findById: (cwd: string, id: string, dir = "/sessions") =>
      [...files].find(([, manager]) => manager.getCwd() === cwd && manager.getSessionId() === id)?.[0],
    open: (file: string) => {
      const manager = files.get(file);
      if (!manager) throw new Error("session file missing");
      return manager;
    },
  };
}

const request = { runId: "run", requestId: "request", prompt: "hello" };

test("shared Pi executor delegates tool calls through the runtime policy boundary", async () => {
  let executions = 0;
  let disposed = 0;
  const progress: unknown[] = [];
  const runtime = createStatelessSubpolarRuntime({
    context: { async load() { return { requestId: "request", principal: { id: "local", kind: "local" } }; } },
    gateway: createPolicyGateway({
      tools: [{ id: "denied", namespace: "test", description: "Denied", inputSchema: {}, enabled: true, risk: "high" }],
      resolvePolicy: () => ({ deny: true }),
      execute: async () => { executions++; return { ok: true, value: "unsafe" }; },
    }),
    executor: createPiStatelessExecutor(() => ({
      async execute(input) {
        expect(input.transcript.entries).toEqual([{ role: "user", content: "prior" }]);
        const result = await input.tools!.call({ callId: "call", toolId: "denied", input: {} });
        await input.emit({ type: "status", data: "done" });
        return result;
      },
      dispose() { disposed++; },
    }), undefined, () => [{ role: "user", content: "prior" }]),
    eventSink: (event) => { progress.push(event.type); },
  });
  expect(await runtime.run(request)).toMatchObject({ state: "completed", output: { ok: false, status: "denied" }, recoverable: false });
  expect(executions).toBe(0);
  expect(disposed).toBe(1);
  expect(progress).toEqual(["run.started", "run.progress", "run.completed"]);
});

test("SDK execution aborts, unsubscribes, and disposes without loading tools or file sessions", async () => {
  const controller = new AbortController();
  let aborts = 0;
  let disposed = 0;
  let unsubscribed = 0;
  let rejectPrompt: ((reason: Error) => void) | undefined;
  const sdk: PiSdkModule = {
    getAgentDir: () => "/test/agent",
    SessionManager: sessionManagerApi(),
    SettingsManager: { inMemory: () => ({}) },
    DefaultResourceLoader: class {
      constructor(options: Record<string, unknown>) {
        expect(options).toMatchObject({ noExtensions: true, noSkills: true, noPromptTemplates: true, noContextFiles: true });
      }
      async reload() {}
    },
    async createAgentSession(options) {
      expect(options).toMatchObject({ tools: [], noTools: "all" });
      return { session: {
        subscribe: () => () => { unsubscribed++; },
        prompt: () => new Promise<void>((_, reject) => { rejectPrompt = reject; controller.abort(); }),
        async abort() { aborts++; rejectPrompt?.(new Error("aborted")); },
        dispose() { disposed++; },
        messages: [],
      } };
    },
  };
  const runtime = createStatelessSubpolarRuntime({
    context: { async load() { return { requestId: "request", principal: { id: "local", kind: "local" } }; } },
    gateway: createPolicyGateway({ tools: [], resolvePolicy: () => ({ deny: true }), execute: async () => ({ ok: true, value: null }) }),
    executor: createPiStatelessExecutor(createPiSdkExecutorFactory(async () => sdk), undefined),
  });
  expect(await runtime.run({ ...request, signal: controller.signal })).toMatchObject({ state: "interrupted", recoverable: false });
  expect(aborts).toBe(1);
  expect(unsubscribed).toBe(1);
  expect(disposed).toBe(1);
});

test("uses the environment runtime data directory for Pi agent files", async () => {
  const previous = process.env.SUBPOLAR_RUNTIME_DATA_DIR;
  process.env.SUBPOLAR_RUNTIME_DATA_DIR = "/var/lib/subpolar";
  let loaderOptions: Record<string, unknown> | undefined;
  const sdk: PiSdkModule = {
    getAgentDir: () => "/test/agent",
    SessionManager: sessionManagerApi(),
    SettingsManager: { inMemory: () => ({}) },
    DefaultResourceLoader: class {
      constructor(options: Record<string, unknown>) { loaderOptions = options; }
      async reload() {}
    },
    async createAgentSession() {
      return { session: {
        subscribe: () => () => undefined,
        async prompt() {},
        async abort() {},
        dispose() {},
        messages: [{ role: "assistant", content: [{ type: "text", text: "ok" }], stopReason: "stop" }],
      } };
    },
  };
  const execution: PiExecutionRequest = {
    runId: "run-persistent-dir",
    requestId: "request-persistent-dir",
    prompt: "hello",
    context: { principal: { id: "owner", kind: "local" } },
    transcript: { entries: [] },
    emit: () => undefined,
  };

  try {
    const executor = await createPiSdkExecutorFactory(async () => sdk)(undefined, execution);
    await executor.execute(execution);
    await executor.dispose?.();
    expect(loaderOptions).toMatchObject({ agentDir: "/var/lib/subpolar/pi-agent" });
  } finally {
    if (previous === undefined) delete process.env.SUBPOLAR_RUNTIME_DATA_DIR;
    else process.env.SUBPOLAR_RUNTIME_DATA_DIR = previous;
  }
});

test("persists Pi sessions under runtime data and reopens them by the T3 ACP session key", async () => {
  const SessionManager = sessionManagerApi();
  let managerSeen: PiSessionManager | undefined;
  const sdk: PiSdkModule = {
    getAgentDir: () => "/test/agent",
    SessionManager,
    SettingsManager: { inMemory: () => ({}) },
    DefaultResourceLoader: class { async reload() {} },
    async createAgentSession(options) {
      managerSeen = options.sessionManager as PiSessionManager;
      return { session: {
        subscribe: () => () => undefined,
        async prompt() {},
        async abort() {},
        dispose() {},
        messages: [{ role: "assistant", content: "ok", stopReason: "stop" }],
      } };
    },
  };
  const nativeId = "native-session-id";
  const execution: PiExecutionRequest = {
    runId: "run-persistent-session",
    requestId: "request-persistent-session",
    prompt: "hello",
    context: { principal: { id: "owner", kind: "local" }, sessionId: nativeId, cwd: "/workspace/project" },
    transcript: { entries: [{ role: "user", content: "T3 owns this history" }] },
    emit: () => undefined,
  };
  const factory = createPiSdkExecutorFactory(async () => sdk);

  const first = await factory({ runtimeDataDir: "/var/lib/subpolar" }, execution);
  expect(managerSeen?.getSessionFile()).toBe(`/var/lib/subpolar/sessions/${createHash("sha256").update(nativeId).digest("hex")}.jsonl`);
  await first.execute(execution);
  await first.dispose?.();

  const resumed = await factory({ runtimeDataDir: "/var/lib/subpolar", resumeSessionIds: new Set([nativeId]) }, execution);
  expect(managerSeen?.getSessionId()).toBe(createHash("sha256").update(nativeId).digest("hex"));
  await resumed.dispose?.();

  await expect(factory({ runtimeDataDir: "/var/lib/subpolar", resumeSessionIds: new Set(["missing"]) }, {
    ...execution,
    context: { ...execution.context, sessionId: "missing" },
  })).rejects.toThrow("Persisted Pi session was not found");
});

test("rejects relative Pi runtime data directories before creating a session file", async () => {
  const sdk: PiSdkModule = {
    getAgentDir: () => "/test/agent",
    SessionManager: sessionManagerApi(),
    SettingsManager: { inMemory: () => ({}) },
    DefaultResourceLoader: class { async reload() {} },
    async createAgentSession() { throw new Error("must reject before creating an agent session"); },
  };
  const execution: PiExecutionRequest = {
    runId: "run-relative-dir",
    requestId: "request-relative-dir",
    prompt: "hello",
    context: { principal: { id: "owner", kind: "local" }, sessionId: "session", cwd: "/workspace/project" },
    transcript: { entries: [] },
    emit: () => undefined,
  };

  await expect(createPiSdkExecutorFactory(async () => sdk)({ runtimeDataDir: "relative/path" }, execution))
    .rejects.toThrow("runtime data directory must be an absolute path");
});

test("SDK exposes only policy-gateway tools and routes calls through the run invoker", async () => {
  const observedCalls: unknown[] = [];
  let optionsSeen: Record<string, unknown> | undefined;
  const messages: Array<{ role: string; content: unknown; stopReason?: string }> = [];
  const sdk: PiSdkModule = {
    getAgentDir: () => "/test/agent",
    SessionManager: sessionManagerApi(),
    SettingsManager: { inMemory: () => ({}) },
    DefaultResourceLoader: class { async reload() {} },
    async createAgentSession(options) {
      optionsSeen = options;
      return { session: {
        subscribe: () => () => undefined,
        async prompt() {
          const tools = options.customTools as Array<{
            name: string;
            parameters: Record<string, unknown>;
            execute(id: string, params: unknown): Promise<unknown>;
          }>;
          const toolResult = await tools[0]!.execute("call-1", { text: "hello" });
          observedCalls.push(toolResult);
          messages.push({ role: "assistant", content: [{ type: "text", text: "tool finished" }], stopReason: "stop" });
        },
        async abort() {},
        dispose() {},
        messages,
      } };
    },
  };
  const execution: PiExecutionRequest = {
    runId: "run-1",
    requestId: "request-1",
    prompt: "use the tool",
    context: { principal: { id: "owner-1", kind: "local" }, sessionId: "session-1" },
    transcript: { entries: [] },
    toolDefinitions: [{
      id: "test.echo",
      namespace: "test",
      description: "Echo text",
      inputSchema: {},
      enabled: true,
      risk: "low",
    }],
    emit: () => undefined,
    tools: {
      async call(call) {
        observedCalls.push(call);
        return { ok: true, status: "executed", callId: call.callId, toolId: call.toolId, value: { accepted: true } };
      },
    },
  };

  const executor = await createPiSdkExecutorFactory(async () => sdk)(undefined, execution);
  const result = await executor.execute(execution);

  expect(optionsSeen).toMatchObject({ noTools: "builtin", tools: [expect.stringMatching(/^subpolar_[a-f0-9]{16}$/)] });
  const customTools = optionsSeen?.customTools as Array<{ parameters: Record<string, unknown> }>;
  expect(customTools[0]?.parameters).toEqual({});
  expect(observedCalls[0]).toMatchObject({
    callId: "call-1",
    toolId: "test.echo",
    input: { text: "hello" },
    requestId: "request-1",
    runId: "run-1",
  });
  expect(observedCalls[1]).toMatchObject({
    content: [{ type: "text", text: expect.stringContaining('"accepted":true') }],
    details: { toolId: "test.echo" },
  });
  expect(result).toEqual({ text: "tool finished" });
  await executor.dispose?.();
});
