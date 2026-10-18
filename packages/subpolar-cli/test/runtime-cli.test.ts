import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PiRuntimeError, type PiSdkModule, type PiExecutionRequest } from "../../subpolar-core-pi/src/index.ts";
import { runCli } from "../src/cli.ts";

async function jsonRun(args: string[], options: Parameters<typeof runCli>[1] = {}) {
  const lines: string[] = [];
  const code = await runCli(["run", "hello", "--json", ...args], options, { stdout: (line) => lines.push(line) });
  return { code, value: JSON.parse(lines.join("")) };
}

test("normal run selects the SDK rather than echo, without needing an injected executor", async () => {
  let disposed = false;
  let prompt = "";
  const sdk: PiSdkModule = {
    getAgentDir: () => "/test/agent",
    SessionManager: { inMemory: () => ({ appendMessage() {} }) },
    SettingsManager: { inMemory: () => ({}) },
    DefaultResourceLoader: class { async reload() {} },
    async createAgentSession(options) {
      expect(options.tools).toEqual([]);
      expect(options.noTools).toBe("all");
      return { session: {
        subscribe: () => () => {},
        async prompt(value) { prompt = value; },
        async abort() {},
        dispose() { disposed = true; },
        messages: [{ role: "assistant", content: [{ type: "text", text: "SDK response" }] }],
      } };
    },
  };
  const { code, value } = await jsonRun([], { pi: { sdkLoader: async () => sdk } });
  expect(code).toBe(0);
  expect(value).toMatchObject({ executor: "pi", result: { text: "SDK response" }, recoverable: false });
  expect(prompt).toBe("hello");
  expect(disposed).toBe(true);
});

test("unavailable SDK fails actionably without a silent fixture fallback", async () => {
  const { code, value } = await jsonRun([], { pi: { sdkLoader: async () => { throw new PiRuntimeError("Pi SDK unavailable; use --fixture for tests"); } } });
  expect(code).toBe(1);
  expect(value).toMatchObject({ ok: false, state: "failed", recoverable: false, error: { code: "PI_RUNTIME_ERROR" } });
  expect(value.error.message).toContain("--fixture");
});

test("session-file resume projects prior history once and uses fresh run correlation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "subpolar-cli-test-"));
  const seen: { runId: string; requestId: string; entries: readonly unknown[] }[] = [];
  const pi = { factory: async () => ({ execute(request: PiExecutionRequest) {
    seen.push({ runId: request.runId, requestId: request.requestId, entries: request.transcript.entries });
    return { text: "response" };
  } }) };
  try {
    const args = ["--session", "same", "--session-file", join(directory, "sessions.json")];
    const first = await jsonRun(args, { pi });
    const second = await jsonRun(args, { pi });
    expect(first.value).toMatchObject({ resumed: false, recoverable: false });
    expect(second.value).toMatchObject({ resumed: true, recoverable: false });
    expect(seen[0].entries).toEqual([]);
    expect(seen[1].entries).toMatchObject([{ role: "user", content: "hello" }, { role: "assistant", content: "response" }]);
    expect(seen[1].runId).not.toBe(seen[0].runId);
    expect(seen[1].requestId).not.toBe(seen[0].requestId);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

for (const output of [null, "plain response", 42, ["item"]]) {
  test(`preserves non-object output ${JSON.stringify(output)}`, async () => {
    const { code, value } = await jsonRun([], { pi: { factory: () => ({ execute: () => output }) } });
    expect(code).toBe(0);
    expect(value.result).toEqual(output);
    expect(value.recoverable).toBe(false);
  });
}

test("rejects conflicting fixture/Pi modes", async () => {
  const { code, value } = await jsonRun(["--fixture"], { pi: { factory: () => ({ execute: () => "not used" }) } });
  expect(code).toBe(2);
  expect(value.error.code).toBe("CLI_USAGE_ERROR");
});

test("loads a standalone executor module through the command-line flag", async () => {
  const directory = await mkdtemp(join(tmpdir(), "subpolar-cli-module-"));
  try {
    const file = join(directory, "executor.ts");
    await Bun.write(file, 'export const createPiExecutor = () => ({ execute: () => ({ text: "module response" }) });');
    const { code, value } = await jsonRun(["--pi-module", file]);
    expect(code).toBe(0);
    expect(value.result.text).toBe("module response");
  } finally { await rm(directory, { recursive: true, force: true }); }
});
