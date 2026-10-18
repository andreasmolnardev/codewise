import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";

const workerPath = fileURLToPath(new URL("../../../docker/subpolar-worker/worker.mjs", import.meta.url));

async function startWorker() {
  const root = await mkdtemp(path.join(os.tmpdir(), "subpolar-worker-"));
  const worker = spawn(process.execPath, [workerPath], { shell: false, stdio: ["pipe", "pipe", "pipe"] });
  const reader = createInterface({ input: worker.stdout, crlfDelay: Infinity });
  const events = reader[Symbol.asyncIterator]();
  return {
    root,
    worker,
    async nextEvent() {
      let timeout: ReturnType<typeof setTimeout> | undefined;
      let next: IteratorResult<string>;
      try {
        next = await Promise.race([
          events.next(),
          new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error("worker event timed out")), 5000); }),
        ]);
      } finally {
        if (timeout) clearTimeout(timeout);
      }
      if (next.done) throw new Error("worker ended before returning its result");
      return JSON.parse(next.value) as Record<string, unknown>;
    },
    async close() {
      worker.stdin.end();
      await new Promise<void>((resolve) => worker.once("close", () => resolve()));
      reader.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

test("worker runs argv without a shell and reports separate output streams", async () => {
  const runtime = await startWorker();
  try {
    runtime.worker.stdin.write(`${JSON.stringify({
      type: "execute",
      command: [process.execPath, "-e", "process.stdout.write('out');process.stderr.write('err');process.exit(4)"],
      worktreeDirectory: runtime.root,
      workingDirectory: runtime.root,
      environment: { WORKER_TEST: "safe" },
    })}\n`);

    const events: Record<string, unknown>[] = [];
    while (events.at(-1)?.type !== "exit") events.push(await runtime.nextEvent());
    const output = events.filter((event) => event.type === "output");
    expect(output.map((event) => [event.stream, Buffer.from(String(event.data), "base64").toString("utf8")]).sort()).toEqual([
      ["stdout", "out"],
      ["stderr", "err"],
    ].sort());
    expect(events.at(-1)).toMatchObject({ type: "exit", exitCode: 4, cancelled: false });
  } finally {
    await runtime.close();
  }
});

test("worker cancellation terminates the owned process group", async () => {
  const runtime = await startWorker();
  try {
    runtime.worker.stdin.write(`${JSON.stringify({
      type: "execute",
      command: [process.execPath, "-e", "setInterval(() => {}, 1000)"],
      worktreeDirectory: runtime.root,
      workingDirectory: runtime.root,
      environment: {},
    })}\n`);
    expect(await runtime.nextEvent()).toMatchObject({ type: "started" });
    runtime.worker.stdin.write(`${JSON.stringify({ type: "terminate" })}\n`);

    let result: Record<string, unknown> | undefined;
    while (result?.type !== "exit") result = await runtime.nextEvent();
    expect(result).toMatchObject({ type: "exit", exitCode: null, cancelled: true });
  } finally {
    await runtime.close();
  }
});

test("worker rejects a working directory symlink that escapes the worktree", async () => {
  const runtime = await startWorker();
  const outside = await mkdtemp(path.join(os.tmpdir(), "subpolar-worker-outside-"));
  try {
    const link = path.join(runtime.root, "outside-link");
    await symlink(outside, link, "dir");
    runtime.worker.stdin.write(`${JSON.stringify({
      type: "execute",
      command: [process.execPath, "-e", "process.exit(99)"],
      worktreeDirectory: runtime.root,
      workingDirectory: link,
      environment: {},
    })}\n`);
    expect(await runtime.nextEvent()).toMatchObject({ type: "error", code: "PROCESS_REQUEST_INVALID" });
  } finally {
    await runtime.close();
    await rm(outside, { recursive: true, force: true });
  }
});
