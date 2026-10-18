import { spawn } from "node:child_process";
import { mkdir, readFile, realpath, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

const SESSION_ROOT = "/tmp/subpolar-terminal-supervisor";
const STOP_GRACE_MS = 1_500;
const TOKEN_PATTERN = /^[a-f0-9-]{36}$/;

function sessionFile(token) {
  if (!TOKEN_PATTERN.test(token)) throw new Error("Invalid terminal session token");
  return path.join(SESSION_ROOT, `${token}.json`);
}

async function terminate(token) {
  const file = sessionFile(token);
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const saved = JSON.parse(await readFile(file, "utf8"));
      if (saved.token !== token || !Number.isSafeInteger(saved.pid) || saved.pid <= 1) throw new Error("Invalid terminal session record");
      const commandLine = await readFile(`/proc/${saved.pid}/cmdline`, "utf8").catch(() => "");
      if (!commandLine.includes(token)) return;
      process.kill(saved.pid, "SIGTERM");
      return;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  throw new Error("Terminal supervisor did not become available");
}

async function start(token, encodedRequest, pipeStdin) {
  const file = sessionFile(token);
  if (typeof encodedRequest !== "string" || encodedRequest.length > 1_500_000 || !/^[A-Za-z0-9_-]+$/.test(encodedRequest)) {
    throw new Error("Invalid terminal process request");
  }
  const request = JSON.parse(Buffer.from(encodedRequest, "base64url").toString("utf8"));
  const { command, worktreeDirectory, workingDirectory, environment } = request ?? {};
  if (!Array.isArray(command) || command.length === 0 || command.length > 256 ||
      command.some((part) => typeof part !== "string" || !part || part.includes("\0")) ||
      typeof worktreeDirectory !== "string" || !path.isAbsolute(worktreeDirectory) ||
      typeof workingDirectory !== "string" || !path.isAbsolute(workingDirectory) ||
      !environment || typeof environment !== "object" || Array.isArray(environment) ||
      Object.values(environment).some((value) => typeof value !== "string" || value.includes("\0"))) {
    throw new Error("Invalid terminal process request");
  }
  const environmentKeys = Object.keys(environment);
  if (environmentKeys.some((key) => !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(key))) throw new Error("Invalid terminal process environment");
  const [resolvedWorktree, resolvedWorkingDirectory] = await Promise.all([realpath(worktreeDirectory), realpath(workingDirectory)]);
  const relativeWorkingDirectory = path.relative(resolvedWorktree, resolvedWorkingDirectory);
  if (relativeWorkingDirectory === ".." || relativeWorkingDirectory.startsWith(`..${path.sep}`) || path.isAbsolute(relativeWorkingDirectory)) {
    throw new Error("Terminal working directory escapes its worktree");
  }

  await mkdir(SESSION_ROOT, { recursive: true, mode: 0o700 });
  await writeFile(file, JSON.stringify({ token, pid: process.pid }), { mode: 0o600, flag: "wx" });

  const child = spawn(command[0], command.slice(1), {
    cwd: resolvedWorkingDirectory,
    env: { ...process.env, ...environment },
    shell: false,
    detached: true,
    stdio: pipeStdin ? ["pipe", "inherit", "inherit"] : "inherit",
    windowsHide: true,
  });
  let finished = false;
  let stopTimer;
  let exitCode = 1;

  const signalGroup = (signal) => {
    if (!child.pid) return;
    try { process.kill(-child.pid, signal); } catch { /* The process group may already have exited. */ }
  };
  const hasProcessGroup = () => {
    if (!child.pid) return false;
    try { process.kill(-child.pid, 0); return true; } catch { return false; }
  };
  const finish = async () => {
    if (finished) return;
    finished = true;
    if (stopTimer) clearTimeout(stopTimer);
    await unlink(file).catch(() => undefined);
    process.exitCode = exitCode;
  };
  const escalate = () => {
    if (finished) return;
    signalGroup("SIGKILL");
    stopTimer = setTimeout(() => { void finish(); }, 50);
  };
  const stop = (signal) => {
    if (finished) return;
    signalGroup(signal);
    if (!stopTimer) {
      stopTimer = setTimeout(escalate, STOP_GRACE_MS);
    }
  };

  process.on("SIGINT", () => stop("SIGINT"));
  process.on("SIGTERM", () => stop("SIGTERM"));
  process.on("SIGHUP", () => stop("SIGTERM"));
  process.on("SIGQUIT", () => stop("SIGQUIT"));
  if (pipeStdin) {
    process.stdin.pipe(child.stdin);
    process.stdin.once("end", () => stop("SIGTERM"));
  }
  child.once("error", () => {
    exitCode = 1;
    void finish();
  });
  child.once("close", (code, signal) => {
    exitCode = Number.isInteger(code) ? code : signal === "SIGKILL" ? 137 : signal === "SIGINT" ? 130 : 143;
    if (hasProcessGroup()) {
      if (!stopTimer) stopTimer = setTimeout(escalate, STOP_GRACE_MS);
    } else {
      void finish();
    }
  });
}

const [mode, first, second, third] = process.argv.slice(2);
try {
  if (mode === "--terminate") await terminate(first ?? "");
  else if (mode === "--stdio") await start(first ?? "", second ?? "", true);
  else await start(mode ?? "", first ?? "", false);
} catch {
  process.exitCode = 1;
}
