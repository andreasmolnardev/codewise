import { describe, expect, test } from "bun:test";
import { runCli } from "../src/cli.ts";

describe("subpolar-cli", () => {
  test("runs the local fixture with a stable JSON result envelope", async () => {
    const output: string[] = [];
    const exitCode = await runCli(["run", "hello", "world", "--fixture", "--json", "--session", "smoke"], { now: () => new Date("2026-01-01T00:00:00.000Z") }, { stdout: (text) => output.push(text) });

    expect(exitCode).toBe(0);
    expect(JSON.parse(output.join(""))).toMatchObject({ ok: true, command: "run", sessionId: "smoke", executor: "local-fixture-echo", result: { text: "Local fixture echo: hello world" } });
  });

  test("returns a JSON error and nonzero exit code for an invalid command", async () => {
    const output: string[] = [];
    const exitCode = await runCli(["nope", "--json"], {}, { stdout: (text) => output.push(text) });

    expect(exitCode).toBe(2);
    expect(JSON.parse(output.join(""))).toMatchObject({ ok: false, error: { code: "CLI_USAGE_ERROR" } });
  });

  test("sanitizes executor errors returned to the CLI", async () => {
    const output: string[] = [];
    const exitCode = await runCli(
      ["run", "hello", "--json", "--session", "executor-error"],
      {
        executor: async () => {
          throw new Error('provider failed with token=cli-secret');
        },
      },
      { stdout: (text) => output.push(text) },
    );

    expect(exitCode).toBe(1);
    const result = JSON.parse(output.join(""));
    expect(result).toMatchObject({ ok: false, error: { code: "EXECUTION_FAILED", message: "Tool execution failed" } });
    expect(output.join("")).not.toContain("cli-secret");
  });

  test("uses an explicitly configured Pi factory and passes its config", async () => {
    const output: string[] = [];
    const exitCode = await runCli(
      ["run", "hello", "pi", "--json", "--session", "pi-smoke"],
      {
        pi: {
          config: { provider: "fake" },
          factory: async (config) => ({
            async execute({ prompt, context, emit }) {
              expect(config).toEqual({ provider: "fake" });
              expect(context.sessionId).toBe("pi-smoke");
              await emit({ type: "status", data: { phase: "started" } });
              return { executor: "pi-fake", text: `Pi: ${prompt}` };
            },
          }),
        },
      },
      { stdout: (text) => output.push(text) },
    );

    expect(exitCode).toBe(0);
    expect(JSON.parse(output.join(""))).toMatchObject({ ok: true, executor: "pi-fake", result: { text: "Pi: hello pi" } });
  });

  test("streams ordered JSONL lifecycle events and redacts secrets", async () => {
    const output: string[] = [];
    const exitCode = await runCli(
      ["run", "hello", "--jsonl", "--session", "jsonl"],
      {
        pi: {
          factory: async () => ({
            async execute({ emit }) {
              await emit({ type: "status", data: { phase: "progress", token: "secret-value" } });
              return { text: "finished token=secret-value" };
            },
          }),
        },
      },
      { stdout: (text) => output.push(text) },
    );

    expect(exitCode).toBe(0);
    const events = output.join("").trim().split("\n").map((line) => JSON.parse(line));
    expect(events.map((event) => event.event)).toEqual(["started", "progress", "terminal"]);
    expect(events[2]).toMatchObject({ type: "run.completed", state: "completed" });
    expect(output.join("")).not.toContain("secret-value");
  });

  test("returns timeout exit code and terminal JSONL event", async () => {
    const output: string[] = [];
    const exitCode = await runCli(
      ["run", "wait", "--jsonl", "--timeout", "10"],
      { executor: async () => new Promise<never>((_, reject) => setTimeout(() => reject(new Error("late token=timeout-secret")), 100)) },
      { stdout: (text) => output.push(text) },
    );

    expect(exitCode).toBe(3);
    expect(output.join("")).toContain('"event":"terminal"');
    expect(output.join("")).not.toContain("timeout-secret");
  });

  test("returns explicit cancellation exit code", async () => {
    const controller = new AbortController();
    const output: string[] = [];
    const pending = runCli(
      ["run", "cancel", "--json"],
      { executor: async () => new Promise<never>((_, reject) => controller.signal.addEventListener("abort", () => reject(new Error("cancelled token=cancel-secret")), { once: true })), signal: controller.signal },
      { stdout: (text) => output.push(text) },
    );
    controller.abort();

    expect(await pending).toBe(4);
    expect(JSON.parse(output.join(""))).toMatchObject({ ok: false, error: { code: "CLI_CANCELLED" } });
    expect(output.join("")).not.toContain("cancel-secret");
  });
});
