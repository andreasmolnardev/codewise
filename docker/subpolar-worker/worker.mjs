import { spawn } from "node:child_process";
import { realpath } from "node:fs/promises";
import { createInterface } from "node:readline";
import { once } from "node:events";
import path from "node:path";
import { randomUUID } from "node:crypto";

let outputQueue = Promise.resolve();
let child;
let cancelled = false;
let finished = false;
let killTimer;

const send = (message) => {
  outputQueue = outputQueue.then(async () => {
    if (!process.stdout.write(`${JSON.stringify(message)}\n`)) await once(process.stdout, "drain");
  });
  return outputQueue;
};

const stopChild = (signal = "SIGTERM") => {
  if (!child || finished) return;
  cancelled = true;
  try {
    process.kill(-child.pid, signal);
  } catch {
    // The process group may already have exited.
  }
  if (!killTimer && signal !== "SIGKILL") {
    killTimer = setTimeout(() => stopChild("SIGKILL"), 3000);
    killTimer.unref();
  }
};

const reader = createInterface({ input: process.stdin, crlfDelay: Infinity });
reader.on("line", (line) => {
  let message;
  try { message = JSON.parse(line); } catch { return; }
  if (message?.type === "terminate") stopChild("SIGTERM");
  if (message?.type !== "execute" || child) return;
  void start(message).catch(async () => {
    await send({ type: "error", code: "PROCESS_START_FAILED", message: "Managed process could not be started" });
    process.exitCode = 1;
  });
});
reader.on("close", () => stopChild("SIGTERM"));

async function start(message) {
  const command = message.command;
  const worktreeDirectory = message.worktreeDirectory;
  const workingDirectory = message.workingDirectory;
  const environment = message.environment;
  if (
    !Array.isArray(command) || command.length === 0 ||
    command.some((part) => typeof part !== "string" || part.length === 0 || part.includes("\0")) ||
    typeof worktreeDirectory !== "string" || !path.isAbsolute(worktreeDirectory) ||
    typeof workingDirectory !== "string" || !path.isAbsolute(workingDirectory) ||
    !workingDirectory.startsWith(`${path.resolve(worktreeDirectory)}${path.sep}`) && workingDirectory !== path.resolve(worktreeDirectory) ||
    environment === null || typeof environment !== "object" || Array.isArray(environment)
  ) {
    await send({ type: "error", code: "PROCESS_REQUEST_INVALID", message: "Managed process request is invalid" });
    process.exitCode = 1;
    return;
  }

  let resolvedWorktree;
  let resolvedWorkingDirectory;
  try {
    [resolvedWorktree, resolvedWorkingDirectory] = await Promise.all([
      realpath(worktreeDirectory),
      realpath(workingDirectory),
    ]);
  } catch {
    await send({ type: "error", code: "PROCESS_REQUEST_INVALID", message: "Managed process request is invalid" });
    process.exitCode = 1;
    return;
  }
  const relativeDirectory = path.relative(resolvedWorktree, resolvedWorkingDirectory);
  if (relativeDirectory === ".." || relativeDirectory.startsWith(`..${path.sep}`) || path.isAbsolute(relativeDirectory)) {
    await send({ type: "error", code: "PROCESS_REQUEST_INVALID", message: "Managed process request is invalid" });
    process.exitCode = 1;
    return;
  }

  const processId = randomUUID();
  child = spawn(command[0], command.slice(1), {
    cwd: resolvedWorkingDirectory,
    env: { ...process.env, ...environment },
    shell: false,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.once("error", async () => {
    finished = true;
    await send({ type: "error", code: "PROCESS_START_FAILED", message: "Managed process could not be started" });
    process.exitCode = 1;
  });
  for (const [stream, readable] of [["stdout", child.stdout], ["stderr", child.stderr]]) {
    readable.on("data", (data) => {
      readable.pause();
      void send({ type: "output", stream, data: Buffer.from(data).toString("base64") }).finally(() => readable.resume());
    });
  }
  await send({ type: "started", processId });

  const [code, signal] = await once(child, "close");
  finished = true;
  if (killTimer) clearTimeout(killTimer);
  await outputQueue;
  await send({ type: "exit", processId, exitCode: Number.isInteger(code) ? code : null, signal, cancelled });
}
