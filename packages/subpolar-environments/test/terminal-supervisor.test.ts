import { expect, test } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const supervisorPath = fileURLToPath(new URL("../../../docker/subpolar-worker/terminal-supervisor.mjs", import.meta.url));

async function waitForOutput(child: ChildProcess, marker: string): Promise<string> {
  return new Promise((resolve, reject) => {
    let output = "";
    const timeout = setTimeout(() => reject(new Error(`Timed out waiting for ${marker}; output: ${output}`)), 5_000);
    child.stdout?.on("data", (chunk: Buffer) => {
      output += chunk.toString();
      if (output.includes(marker)) {
        clearTimeout(timeout);
        resolve(output);
      }
    });
    child.once("error", (error) => { clearTimeout(timeout); reject(error); });
    child.once("close", (code) => {
      if (!output.includes(marker)) {
        clearTimeout(timeout);
        reject(new Error(`Supervisor exited (${code}) before ${marker}; output: ${output}`));
      }
    });
  });
}

async function startSupervisor(directory: string, command: string[], stdioMode = false) {
  const request = Buffer.from(JSON.stringify({
    command,
    worktreeDirectory: directory,
    workingDirectory: directory,
    environment: {},
  })).toString("base64url");
  const token = randomUUID();
  const args = stdioMode ? [supervisorPath, "--stdio", token, request] : [supervisorPath, token, request];
  const child = spawn(process.execPath, args, {
    cwd: directory,
    shell: false,
    stdio: ["pipe", "pipe", "pipe"],
  });
  return child;
}

async function readProcessState(pid: number): Promise<string | undefined> {
  try {
    const stat = await readFile(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0];
  } catch {
    return undefined;
  }
}

test("forwards termination signals to the supervised foreground process", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "subpolar-terminal-forward-"));
  const child = await startSupervisor(directory, [process.execPath, "-e", `
    process.on("SIGTERM", () => { process.stdout.write("received-term\\n"); process.exit(0); });
    process.stdout.write("ready\\n");
    setInterval(() => {}, 1000);
  `]);
  try {
    await waitForOutput(child, "ready");
    child.kill("SIGTERM");
    const closed = new Promise<number | null>((resolve) => child.once("close", (code) => resolve(code)));
    const code = await closed;
    expect(code).toBe(0);
  } finally {
    if (child.exitCode === null) child.kill("SIGKILL");
    await rm(directory, { recursive: true, force: true });
  }
});

test("kills the complete process group when the terminal supervisor exits", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "subpolar-terminal-group-"));
  const pidFile = path.join(directory, "pids");
  const child = await startSupervisor(directory, [process.execPath, "-e", `
    const { spawn } = require("node:child_process");
    const fs = require("node:fs");
    const grandchild = spawn(process.execPath, ["-e", 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)'], { stdio: "inherit" });
    process.on("SIGTERM", () => {});
    fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid) + "," + String(grandchild.pid));
    process.stdout.write("group-ready\\n");
    setInterval(() => {}, 1000);
  `]);
  try {
    await waitForOutput(child, "group-ready");
    const pids = (await readFile(pidFile, "utf8")).split(",").map(Number);
    child.kill("SIGHUP");
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Supervisor did not escalate process-group cleanup")), 5_000);
      child.once("close", () => { clearTimeout(timeout); resolve(); });
    });
    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline && (await Promise.all(pids.map(readProcessState))).some((state) => state !== undefined && state !== "Z")) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect((await Promise.all(pids.map(readProcessState))).every((state) => state === undefined || state === "Z")).toBe(true);
  } finally {
    if (child.exitCode === null) child.kill("SIGKILL");
    await rm(directory, { recursive: true, force: true });
  }
});

test("treats non-TTY stdin EOF as cancellation and escalates an ignoring child", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "subpolar-terminal-eof-"));
  const pidFile = path.join(directory, "pid");
  const child = await startSupervisor(directory, [process.execPath, "-e", `
    const fs = require("node:fs");
    process.stdin.on("data", chunk => process.stdout.write("forwarded:" + chunk));
    process.on("SIGTERM", () => {});
    fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
    process.stdout.write("eof-ready\\n");
    setInterval(() => {}, 1000);
  `], true);
  try {
    await waitForOutput(child, "eof-ready");
    const pid = Number(await readFile(pidFile, "utf8"));
    child.stdin?.write("protocol-bytes\n");
    await waitForOutput(child, "forwarded:protocol-bytes\n");
    child.stdin?.end();
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Supervisor did not clean up after stdin EOF")), 5_000);
      child.once("close", () => { clearTimeout(timeout); resolve(); });
    });
    const deadline = Date.now() + 2_000;
    let state = await readProcessState(pid);
    while (Date.now() < deadline && state !== undefined && state !== "Z") {
      await new Promise((resolve) => setTimeout(resolve, 50));
      state = await readProcessState(pid);
    }
    expect(state === undefined || state === "Z").toBe(true);
  } finally {
    if (child.exitCode === null) child.kill("SIGKILL");
    await rm(directory, { recursive: true, force: true });
  }
});
