import { expect, test } from "bun:test";
import { runAdminCli } from "../src/admin-cli.ts";

const token = "admin-cli-test-token-with-more-than-thirty-two-characters";
const baseEnvironment = {
  SUBPOLAR_MANAGER_URL: "http://subpolar-manager:8787",
  SUBPOLAR_MANAGER_TOKEN: token,
  SUBPOLAR_MANAGER_ALLOW_PRIVATE_HTTP: "true",
  SUBPOLAR_STORAGE_ROOT: "/workspaces",
  SUBPOLAR_OWNER_ID: "t3-installation-test",
};

function capture() {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return { stdout, stderr, io: { stdout: (text: string) => stdout.push(text), stderr: (text: string) => stderr.push(text) } };
}

test("environment admin CLI lists and inspects environments through the authenticated manager", async () => {
  const calls: Array<{ url: string; authorization: string | null; body: unknown }> = [];
  const environment = {
    id: "environment-a", ownerId: "t3-installation-test", workspaceId: "workspace-a",
    storageRoot: "/workspaces", worktreePath: "/workspaces/repo", backendId: "docker", resourceId: "container-a", status: "ready",
  };
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, authorization: new Headers(init?.headers).get("authorization"), body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (url.endsWith("/admin/list")) return Response.json({ environments: [{ environment, createdAt: "2026-01-01", updatedAt: "2026-01-02" }] });
    if (url.endsWith("/admin/inspect")) return Response.json({ environment });
    return Response.json({ ok: true });
  }) as typeof fetch;
  const output = capture();

  expect(await runAdminCli(["environments", "list", "--json"], {
    environment: baseEnvironment, fetch: fetcher, io: output.io,
  })).toBe(0);
  expect(JSON.parse(output.stdout[0]!)).toMatchObject({ environments: [{ environment: { status: "ready" } }] });

  expect(await runAdminCli(["environments", "inspect", "/workspaces/repo", "--json"], {
    environment: baseEnvironment, fetch: fetcher, io: output.io,
  })).toBe(0);
  expect(JSON.parse(output.stdout[1]!)).toMatchObject({ worktreePath: "/workspaces/repo", status: "ready" });
  expect(calls.every((call) => call.authorization === `Bearer ${token}`)).toBe(true);
  expect(calls[0]?.body).toEqual({ ownerId: "t3-installation-test" });
  expect(calls[1]?.body).toMatchObject({ environment: { ownerId: "t3-installation-test", storageRoot: "/workspaces", worktreePath: "/workspaces/repo" } });
  expect(output.stdout.join(" ")).not.toContain(token);
});

test("environment admin CLI dispatches lifecycle operations and preserves workspace identity", async () => {
  const calls: string[] = [];
  const fetcher = (async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url.split("/").at(-1)!);
    if (url.endsWith("/remove")) return Response.json({ removed: true });
    return Response.json({
      id: "environment-a", ownerId: "t3-installation-test", workspaceId: "workspace-a",
      storageRoot: "/workspaces", worktreePath: "/workspaces/repo", backendId: "docker", resourceId: "container-a", status: "ready",
    });
  }) as typeof fetch;
  const output = capture();

  for (const command of ["start", "stop", "restart", "remove", "rebuild"]) {
    expect(await runAdminCli(["environments", command, "/workspaces/repo"], { environment: baseEnvironment, fetch: fetcher, io: output.io })).toBe(0);
  }
  expect(calls).toEqual(["start", "stop", "restart", "remove", "rebuild"]);
});

test("environment admin CLI reports usage, missing environments, and manager failures with distinct exit codes", async () => {
  const output = capture();
  expect(await runAdminCli(["environments", "nope"], { environment: baseEnvironment, io: output.io })).toBe(2);
  expect(await runAdminCli(["environments", "inspect", "/workspaces/missing"], {
    environment: baseEnvironment,
    fetch: (async () => Response.json({ environment: null })) as typeof fetch,
    io: output.io,
  })).toBe(4);
  expect(await runAdminCli(["status"], {
    environment: baseEnvironment,
    fetch: (async () => Response.json({ error: "UNAUTHORIZED" }, { status: 401 })) as typeof fetch,
    io: output.io,
  })).toBe(1);
  expect(output.stderr.join(" ")).toContain("No environment exists");
});
