// @effect-diagnostics nodeBuiltinImport:off - CLI integration exercises the filesystem boundary.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import * as ConfigProvider from "effect/ConfigProvider";
import * as NetService from "@t3tools/shared/Net";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestConsole from "effect/testing/TestConsole";
import { Command } from "effect/cli";

import { cli } from "../binCli.ts";

const runCli = (args: ReadonlyArray<string>) =>
  Command.runWith(cli, { version: "0.0.0" })(args).pipe(
    Effect.provide(Layer.mergeAll(NodeServices.layer, NetService.layer, TestConsole.layer)),
  );

const makeBaseDir = () =>
  NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3code-subpolar-profiles-"));
const configPathFor = (baseDir: string) =>
  NodePath.join(baseDir, "userdata", "subpolar-agent-profiles.json");
const profile = {
  id: "safe",
  name: "Safe profile",
  model: "fake",
  instructions: "Be concise",
  allowedToolIds: ["read"],
};

function writeProfile(baseDir: string, value: unknown = profile, name = "profile.json") {
  const filePath = NodePath.join(baseDir, name);
  NodeFS.writeFileSync(filePath, JSON.stringify(value));
  return filePath;
}

function readConfig(baseDir: string) {
  return JSON.parse(NodeFS.readFileSync(configPathFor(baseDir), "utf8")) as {
    version: number;
    providers: Record<string, { profiles: unknown[]; selectedProfileId?: string }>;
  };
}

const runAt = (baseDir: string, args: readonly string[]) =>
  runCli([...args, "--base-dir", baseDir]).pipe(
    Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env: {} }))),
  );

const runCliProcess = (baseDir: string, args: readonly string[]) =>
  Effect.promise(
    () =>
      new Promise<void>((resolve, reject) => {
        const child = NodeChildProcess.spawn(
          process.execPath,
          [
            "--experimental-transform-types",
            NodePath.resolve("apps/server/src/bin.ts"),
            ...args,
            "--base-dir",
            baseDir,
          ],
          { cwd: NodePath.resolve("."), stdio: "ignore" },
        );
        child.once("error", reject);
        child.once("exit", (code, signal) => {
          if (code === 0) resolve();
          else reject(new Error(`t3 exited with code ${code} and signal ${signal ?? "none"}.`));
        });
      }),
  );

describe("t3 subpolar profiles", () => {
  it.effect("adds, lists, selects, and removes profiles per provider instance", () =>
    Effect.gen(function* () {
      const baseDir = makeBaseDir();
      const profileFile = writeProfile(baseDir);
      yield* runAt(baseDir, [
        "subpolar",
        "profiles",
        "add",
        "--provider-instance",
        "pi-one",
        "--file",
        profileFile,
      ]);
      yield* runAt(baseDir, [
        "subpolar",
        "profiles",
        "add",
        "--provider-instance",
        "pi-two",
        "--file",
        profileFile,
      ]);

      const added = readConfig(baseDir);
      assert.deepEqual(added.providers["pi-one"]?.profiles, [profile]);
      assert.deepEqual(added.providers["pi-two"]?.profiles, [profile]);

      yield* runAt(baseDir, [
        "subpolar",
        "profiles",
        "select",
        "--provider-instance",
        "pi-one",
        "safe",
      ]);
      const selected = readConfig(baseDir);
      assert.equal(selected.providers["pi-one"]?.selectedProfileId, "safe");
      assert.equal(selected.providers["pi-two"]?.selectedProfileId, undefined);

      yield* runAt(baseDir, [
        "subpolar",
        "profiles",
        "list",
        "--provider-instance",
        "pi-one",
        "--json",
      ]);
      const output = yield* TestConsole.logLines;
      assert.include(output.join(""), '"selected": true');

      yield* runAt(baseDir, [
        "subpolar",
        "profiles",
        "remove",
        "--provider-instance",
        "pi-one",
        "safe",
      ]);
      const removed = readConfig(baseDir);
      assert.deepEqual(removed.providers["pi-one"], { profiles: [] });
      assert.deepEqual(removed.providers["pi-two"]?.profiles, [profile]);
    }),
  );

  it.effect("serializes concurrent mutations and keeps the catalog owner-only", () =>
    Effect.gen(function* () {
      const baseDir = makeBaseDir();
      const firstProfile = writeProfile(baseDir, { ...profile, id: "first" }, "first-profile.json");
      const secondProfile = writeProfile(
        baseDir,
        { ...profile, id: "second" },
        "second-profile.json",
      );
      yield* Effect.promise(() =>
        Promise.all(
          [
            runCliProcess(baseDir, [
              "subpolar",
              "profiles",
              "add",
              "--provider-instance",
              "pi-one",
              "--file",
              firstProfile,
            ]),
            runCliProcess(baseDir, [
              "subpolar",
              "profiles",
              "add",
              "--provider-instance",
              "pi-two",
              "--file",
              secondProfile,
            ]),
          ].map((operation) => Effect.runPromise(operation)),
        ),
      );

      const config = readConfig(baseDir);
      assert.deepEqual(config.providers["pi-one"]?.profiles, [{ ...profile, id: "first" }]);
      assert.deepEqual(config.providers["pi-two"]?.profiles, [{ ...profile, id: "second" }]);
      if (process.platform !== "win32") {
        assert.equal(NodeFS.statSync(configPathFor(baseDir)).mode & 0o777, 0o600);
      }
    }),
  );

  it.effect("serializes concurrent recovery of a catalog lock left by a process that exited", () =>
    Effect.gen(function* () {
      const baseDir = makeBaseDir();
      const firstProfile = writeProfile(baseDir, { ...profile, id: "first" }, "first-profile.json");
      const secondProfile = writeProfile(
        baseDir,
        { ...profile, id: "second" },
        "second-profile.json",
      );
      const configPath = configPathFor(baseDir);
      NodeFS.mkdirSync(NodePath.dirname(configPath), { recursive: true });
      NodeFS.writeFileSync(
        `${configPath}.lock`,
        JSON.stringify({ pid: 2_147_483_647, token: "stale" }),
      );

      yield* Effect.promise(() =>
        Promise.all(
          [
            runCliProcess(baseDir, [
              "subpolar",
              "profiles",
              "add",
              "--provider-instance",
              "pi-one",
              "--file",
              firstProfile,
            ]),
            runCliProcess(baseDir, [
              "subpolar",
              "profiles",
              "add",
              "--provider-instance",
              "pi-two",
              "--file",
              secondProfile,
            ]),
          ].map((operation) => Effect.runPromise(operation)),
        ),
      );

      const config = readConfig(baseDir);
      assert.deepEqual(config.providers["pi-one"]?.profiles, [{ ...profile, id: "first" }]);
      assert.deepEqual(config.providers["pi-two"]?.profiles, [{ ...profile, id: "second" }]);
      assert.equal(NodeFS.existsSync(`${configPath}.lock`), false);
      assert.equal(NodeFS.existsSync(`${configPath}.lock.recovery`), false);
    }),
  );

  it.effect("rejects profile input with credential-shaped or unknown fields without writing", () =>
    Effect.gen(function* () {
      const baseDir = makeBaseDir();
      const profileFile = writeProfile(baseDir, { ...profile, apiKey: "must-not-be-stored" });
      const failure = yield* runAt(baseDir, [
        "subpolar",
        "profiles",
        "add",
        "--provider-instance",
        "pi-one",
        "--file",
        profileFile,
      ]).pipe(Effect.flip);
      assert.include(String(failure), "unsupported fields");
      assert.equal(NodeFS.existsSync(configPathFor(baseDir)), false);
    }),
  );

  it.effect("fails closed on a malformed catalog and preserves its bytes", () =>
    Effect.gen(function* () {
      const baseDir = makeBaseDir();
      const configPath = configPathFor(baseDir);
      NodeFS.mkdirSync(NodePath.dirname(configPath), { recursive: true });
      NodeFS.writeFileSync(configPath, "{broken");
      const failure = yield* runAt(baseDir, [
        "subpolar",
        "profiles",
        "select",
        "--provider-instance",
        "pi-one",
        "safe",
      ]).pipe(Effect.flip);
      assert.include(String(failure), "malformed or invalid");
      assert.equal(NodeFS.readFileSync(configPath, "utf8"), "{broken");
    }),
  );

  it.effect("honors T3CODE_HOME and stores profiles under userdata", () =>
    Effect.gen(function* () {
      const baseDir = makeBaseDir();
      const profileFile = writeProfile(baseDir);
      yield* runCli([
        "subpolar",
        "profiles",
        "add",
        "--provider-instance",
        "pi-one",
        "--file",
        profileFile,
      ]).pipe(
        Effect.provide(
          Layer.mergeAll(
            NodeServices.layer,
            NetService.layer,
            TestConsole.layer,
            ConfigProvider.layer(ConfigProvider.fromEnv({ env: { T3CODE_HOME: baseDir } })),
          ),
        ),
      );
      assert.deepEqual(readConfig(baseDir).providers["pi-one"]?.profiles, [profile]);
    }),
  );
});
