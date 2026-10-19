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
  return {
    stdout,
    stderr,
    io: {
      stdout: (text: string) => stdout.push(text),
      stderr: (text: string) => stderr.push(text),
    },
  };
}

test("status reports the authenticated manager count without exposing credentials", async () => {
  const calls: Array<{ url: string; authorization: string | null; body: unknown }> = [];
  const output = capture();
  expect(
    await runAdminCli(["status", "--json"], {
      environment: baseEnvironment,
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        calls.push({
          url: String(input),
          authorization: new Headers(init?.headers).get("authorization"),
          body: init?.body ? JSON.parse(String(init.body)) : undefined,
        });
        return Response.json({ ok: true, registeredEnvironmentCount: 2 });
      }) as typeof fetch,
      io: output.io,
    }),
  ).toBe(0);

  expect(calls).toEqual([
    {
      url: "http://subpolar-manager:8787/v1/environments/admin/status",
      authorization: `Bearer ${token}`,
      body: {},
    },
  ]);
  expect(JSON.parse(output.stdout[0]!)).toEqual({
    ok: true,
    registeredEnvironmentCount: 2,
  });
  expect(output.stdout.join(" ")).not.toContain(token);
  expect(output.stderr).toEqual([]);
});

test("admin CLI help advertises the supported read-only inspection commands", async () => {
  const output = capture();
  expect(await runAdminCli(["--help"], { io: output.io })).toBe(0);
  expect(output.stdout.join("")).toContain("subpolar status [--json]");
  expect(output.stdout.join("")).toContain("subpolar environments list [--owner-id ID] [--json]");
  expect(output.stdout.join("")).toContain("subpolar environments inspect WORKTREE [--json]");
  expect(output.stderr).toEqual([]);
});

test("environment admin CLI lists and inspects environments through the authenticated manager", async () => {
  const calls: Array<{ url: string; authorization: string | null; body: unknown }> = [];
  const environment = {
    id: "environment-a",
    ownerId: "t3-installation-test",
    workspaceId: "workspace-a",
    storageRoot: "/workspaces",
    worktreePath: "/workspaces/repo",
    backendId: "docker",
    resourceId: "container-a",
    status: "ready",
  };
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({
      url,
      authorization: new Headers(init?.headers).get("authorization"),
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    if (url.endsWith("/admin/list"))
      return Response.json({
        environments: [{ environment, createdAt: "2026-01-01", updatedAt: "2026-01-02" }],
      });
    if (url.endsWith("/admin/inspect")) return Response.json({ environment });
    return Response.json({ ok: true });
  }) as typeof fetch;
  const output = capture();

  expect(
    await runAdminCli(["environments", "list", "--json"], {
      environment: baseEnvironment,
      fetch: fetcher,
      io: output.io,
    }),
  ).toBe(0);
  expect(JSON.parse(output.stdout[0]!)).toMatchObject({
    environments: [{ environment: { status: "ready" } }],
  });

  expect(
    await runAdminCli(["environments", "inspect", "/workspaces/repo", "--json"], {
      environment: baseEnvironment,
      fetch: fetcher,
      io: output.io,
    }),
  ).toBe(0);
  expect(JSON.parse(output.stdout[1]!)).toMatchObject({
    worktreePath: "/workspaces/repo",
    status: "ready",
  });
  expect(calls.every((call) => call.authorization === `Bearer ${token}`)).toBe(true);
  expect(calls[0]?.body).toEqual({ ownerId: "t3-installation-test" });
  expect(calls[1]?.body).toMatchObject({
    environment: {
      ownerId: "t3-installation-test",
      storageRoot: "/workspaces",
      worktreePath: "/workspaces/repo",
    },
  });
  expect(output.stdout.join(" ")).not.toContain(token);
});

test("environment admin CLI dispatches lifecycle operations and preserves workspace identity", async () => {
  const calls: string[] = [];
  const fetcher = (async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url.split("/").at(-1)!);
    if (url.endsWith("/remove")) return Response.json({ removed: true });
    return Response.json({
      id: "environment-a",
      ownerId: "t3-installation-test",
      workspaceId: "workspace-a",
      storageRoot: "/workspaces",
      worktreePath: "/workspaces/repo",
      backendId: "docker",
      resourceId: "container-a",
      status: "ready",
    });
  }) as typeof fetch;
  const output = capture();

  for (const command of ["start", "stop", "restart", "remove", "rebuild"]) {
    expect(
      await runAdminCli(["environments", command, "/workspaces/repo"], {
        environment: baseEnvironment,
        fetch: fetcher,
        io: output.io,
      }),
    ).toBe(0);
  }
  expect(calls).toEqual(["start", "stop", "restart", "remove", "rebuild"]);
});

test("environment admin CLI reports usage, missing environments, and manager failures with distinct exit codes", async () => {
  const output = capture();
  expect(
    await runAdminCli(["environments", "nope"], { environment: baseEnvironment, io: output.io }),
  ).toBe(2);
  expect(
    await runAdminCli(["environments", "inspect", "/workspaces/missing"], {
      environment: baseEnvironment,
      fetch: (async () => Response.json({ environment: null })) as typeof fetch,
      io: output.io,
    }),
  ).toBe(4);
  expect(
    await runAdminCli(["status"], {
      environment: baseEnvironment,
      fetch: (async () =>
        Response.json({ error: "UNAUTHORIZED" }, { status: 401 })) as typeof fetch,
      io: output.io,
    }),
  ).toBe(1);
  expect(output.stderr.join(" ")).toContain("No environment exists");
});

test("doctor checks authenticated manager status without revealing the token", async () => {
  const calls: Array<{ url: string; authorization: string | null }> = [];
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({
      url: String(input),
      authorization: new Headers(init?.headers).get("authorization"),
    });
    return Response.json({ ok: true, registeredEnvironmentCount: 3 });
  }) as typeof fetch;
  const output = capture();

  expect(
    await runAdminCli(["doctor", "--json"], {
      environment: baseEnvironment,
      fetch: fetcher,
      io: output.io,
    }),
  ).toBe(0);
  const result = JSON.parse(output.stdout[0]!);
  expect(result).toMatchObject({
    ok: true,
    checks: [
      { name: "managerUrl", status: "passed" },
      { name: "managerToken", status: "passed" },
      {
        name: "managerAuthentication",
        status: "passed",
        message: expect.stringContaining("3 registered environment(s)"),
      },
    ],
  });
  expect(calls).toEqual([
    {
      url: "http://subpolar-manager:8787/v1/environments/admin/status",
      authorization: `Bearer ${token}`,
    },
  ]);
  expect(output.stdout.join(" ")).not.toContain(token);
  expect(output.stderr).toEqual([]);
});

test("doctor reports rejected credentials and missing configuration safely", async () => {
  const rejected = capture();
  expect(
    await runAdminCli(["doctor"], {
      environment: baseEnvironment,
      fetch: (async () =>
        Response.json({ error: "UNAUTHORIZED" }, { status: 401 })) as typeof fetch,
      io: rejected.io,
    }),
  ).toBe(1);
  expect(rejected.stdout.join(" ")).toContain("manager rejected the configured token");
  expect(rejected.stdout.join(" ")).toContain("Check that SUBPOLAR_MANAGER_TOKEN");
  expect(rejected.stdout.join(" ")).not.toContain(token);

  const missing = capture();
  let requests = 0;
  expect(
    await runAdminCli(["doctor", "--json"], {
      environment: {},
      fetch: (async () => {
        requests += 1;
        return Response.json({});
      }) as typeof fetch,
      io: missing.io,
    }),
  ).toBe(1);
  const result = JSON.parse(missing.stdout[0]!);
  expect(result).toMatchObject({
    ok: false,
    checks: [
      {
        name: "managerUrl",
        status: "failed",
        action: expect.stringContaining("SUBPOLAR_MANAGER_URL"),
      },
      {
        name: "managerToken",
        status: "failed",
        action: expect.stringContaining("SUBPOLAR_MANAGER_TOKEN"),
      },
      { name: "managerAuthentication", status: "skipped" },
    ],
  });
  expect(requests).toBe(0);
  expect(missing.stdout.join(" ")).not.toContain(token);
});
