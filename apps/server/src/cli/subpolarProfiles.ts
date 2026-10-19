import * as Config from "effect/Config";
import * as Console from "effect/Console";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { Argument, Command, Flag } from "effect/cli";
import * as CliError from "effect/cli/CliError";
import { resolveSymlinkTarget } from "@t3tools/shared/symlink";
import {
  parseSubpolarAgentProfile,
  parseSubpolarAgentProfilesConfig,
  SubpolarAgentProfilesConfig as SubpolarAgentProfilesConfigSchema,
  type SubpolarAgentProfile,
  type SubpolarAgentProfilesConfig,
} from "@t3tools/provider-acp-registry/server/subpolarAgentProfileConfig";
import * as ServerConfig from "../config.ts";
import { resolveBaseDir } from "../os-jank.ts";
import { baseDirFlag } from "./config.ts";

const providerInstanceFlag = Flag.String("provider-instance").pipe(
  Flag.withSchema(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256))),
  Flag.withDescription("ACP provider instance ID that owns this profile catalog."),
);
const jsonFlag = Flag.Boolean("json").pipe(
  Flag.withDescription("Emit JSON instead of human-readable output."),
  Flag.withDefault(false),
);
const profileFileFlag = Flag.String("file").pipe(
  Flag.withDescription("JSON file containing one Subpolar agent profile."),
);

const stateFilePath = Effect.fn(function* (baseDirOption: Option.Option<string>) {
  const envHome = yield* Config.String("T3CODE_HOME").pipe(Config.option);
  const configuredBaseDir = Option.orElse(baseDirOption, () => envHome);
  const baseDir = yield* resolveBaseDir(
    Option.getOrUndefined(Option.filter(configuredBaseDir, (value) => value.trim().length > 0)),
  );
  const paths = yield* ServerConfig.deriveServerPaths(baseDir, undefined, {
    baseDirIsExplicit: Option.isSome(configuredBaseDir),
  });
  const path = yield* Path.Path;
  return path.join(paths.stateDir, "subpolar-agent-profiles.json");
});

const userError = (message: string, cause?: unknown) =>
  new CliError.UserError({ cause: cause ?? message, userMessage: message });

const ProfileLock = Schema.Struct({ pid: Schema.Int, token: Schema.String });
const ProfileLockJson = Schema.fromJsonString(ProfileLock);
const decodeProfileLock = Schema.decodeUnknownSync(ProfileLockJson);
const encodeProfileLock = Schema.encodeSync(ProfileLockJson);
const encodePrettyJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown, { space: 2 }));
const encodeProfilesConfig = Schema.encodeSync(
  Schema.fromJsonString(SubpolarAgentProfilesConfigSchema, { space: 2 }),
);

function parseProfileLock(raw: string) {
  try {
    return decodeProfileLock(raw);
  } catch {
    return undefined;
  }
}

const LOCK_RETRY_COUNT = 600;
const LOCK_RETRY_DELAY = "50 millis";

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(error instanceof Error && "code" in error && error.code === "ESRCH");
  }
}

const readLockOwner = Effect.fn(function* (lockPath: string) {
  const fs = yield* FileSystem.FileSystem;
  return yield* fs.readFileString(lockPath).pipe(
    Effect.map((raw) => {
      const lock = parseProfileLock(raw);
      return lock === undefined ? undefined : { pid: lock.pid };
    }),
    Effect.catchIf(
      (error) => error.reason._tag === "NotFound",
      () => Effect.succeed(undefined),
    ),
    Effect.mapError((cause) => userError(`Could not inspect profile lock ${lockPath}.`, cause)),
  );
});

const tryAcquireLockFile = Effect.fn(function* (lockPath: string, token: string) {
  const fs = yield* FileSystem.FileSystem;
  return yield* fs
    .writeFileString(lockPath, encodeProfileLock({ pid: process.pid, token }), { flag: "wx" })
    .pipe(
      Effect.as(true),
      Effect.catch((error) =>
        error.reason._tag === "AlreadyExists" ? Effect.succeed(false) : Effect.fail(error),
      ),
    );
});

const acquireRecoveryGuard = Effect.fn(function* (lockPath: string) {
  const guardPath = `${lockPath}.recovery`;
  const crypto = yield* Crypto.Crypto;
  const token = yield* crypto
    .randomUUIDv4()
    .pipe(Effect.mapError((cause) => userError("Could not create profile recovery lock.", cause)));
  for (let attempt = 0; attempt < LOCK_RETRY_COUNT; attempt += 1) {
    if (yield* tryAcquireLockFile(guardPath, token)) return { lockPath: guardPath, token };
    yield* Effect.sleep(LOCK_RETRY_DELAY);
  }
  return yield* Effect.fail(
    userError(
      `Timed out waiting for profile lock recovery guard ${guardPath}. If no T3 process is changing profiles, remove this stale guard and retry.`,
    ),
  );
});

const acquireConfigLock = Effect.fn(function* (filePath: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const lockPath = `${filePath}.lock`;
  const crypto = yield* Crypto.Crypto;
  const token = yield* crypto
    .randomUUIDv4()
    .pipe(Effect.mapError((cause) => userError("Could not create profile lock.", cause)));
  yield* fs.makeDirectory(path.dirname(filePath), { recursive: true });
  for (let attempt = 0; attempt < LOCK_RETRY_COUNT; attempt += 1) {
    const acquired = yield* tryAcquireLockFile(lockPath, token);
    if (acquired) {
      return {
        lockPath,
        token,
      };
    }

    const lock = yield* readLockOwner(lockPath);
    if (lock !== undefined && !isProcessAlive(lock.pid)) {
      const guard = yield* acquireRecoveryGuard(lockPath);
      yield* Effect.gen(function* () {
        // Another reaper may have replaced the stale lock while this process waited for the guard.
        const current = yield* readLockOwner(lockPath);
        if (current !== undefined && !isProcessAlive(current.pid)) {
          const abandonedToken = yield* crypto
            .randomUUIDv4()
            .pipe(Effect.mapError((cause) => userError("Could not recover profile lock.", cause)));
          const abandonedPath = `${lockPath}.abandoned-${abandonedToken}`;
          yield* fs.rename(lockPath, abandonedPath).pipe(
            Effect.catchIf(
              (error) => error.reason._tag === "NotFound",
              () => Effect.void,
            ),
            Effect.flatMap(() => fs.remove(abandonedPath, { force: true }).pipe(Effect.ignore)),
            Effect.mapError((cause) =>
              userError(`Could not recover profile lock ${lockPath}.`, cause),
            ),
          );
        }
      }).pipe(Effect.ensuring(releaseConfigLock(guard).pipe(Effect.ignore({ log: true }))));
      if (lock !== undefined && !isProcessAlive(lock.pid)) {
        // Retry the main lock acquisition after inspecting or removing the stale owner under guard.
        const current = yield* readLockOwner(lockPath);
        if (current === undefined || !isProcessAlive(current.pid)) continue;
      }
    }
    yield* Effect.sleep(LOCK_RETRY_DELAY);
  }
  return yield* Effect.fail(userError(`Timed out waiting for profile lock ${lockPath}.`));
});

const releaseConfigLock = Effect.fn(function* (lock: { lockPath: string; token: string }) {
  const fs = yield* FileSystem.FileSystem;
  const raw = yield* fs.readFileString(lock.lockPath).pipe(
    Effect.catchIf(
      (error) => error.reason._tag === "NotFound",
      () => Effect.succeed(undefined),
    ),
    Effect.mapError((cause) =>
      userError(`Could not inspect profile lock ${lock.lockPath}.`, cause),
    ),
  );
  if (raw === undefined) return;
  const owner = parseProfileLock(raw);
  if (owner?.token === lock.token) {
    yield* fs
      .remove(lock.lockPath)
      .pipe(
        Effect.mapError((cause) =>
          userError(`Could not release profile lock ${lock.lockPath}.`, cause),
        ),
      );
  }
});

const writePrivateConfigAtomically = Effect.fn(function* (filePath: string, contents: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = path.dirname(filePath);
  yield* fs.makeDirectory(directory, { recursive: true });
  yield* Effect.scoped(
    Effect.gen(function* () {
      const temporaryDirectory = yield* Effect.acquireRelease(
        fs.makeTempDirectory({ directory, prefix: `${path.basename(filePath)}.` }),
        (tempDir) => fs.remove(tempDir, { recursive: true }).pipe(Effect.ignore({ log: true })),
      );
      const temporaryFile = path.join(temporaryDirectory, "contents.tmp");
      yield* fs.writeFileString(temporaryFile, contents);
      // Protect instructions and other private profile contents before the atomic rename publishes it.
      yield* fs.chmod(temporaryFile, 0o600);
      yield* fs.rename(temporaryFile, filePath);
    }),
  ).pipe(Effect.mapError((cause) => userError(`Could not save ${filePath}.`, cause)));
});

const readConfig = Effect.fn(function* (filePath: string) {
  const fs = yield* FileSystem.FileSystem;
  const exists = yield* fs
    .exists(filePath)
    .pipe(Effect.mapError((cause) => userError(`Could not inspect ${filePath}.`, cause)));
  if (!exists) return { raw: undefined, config: { version: 1 as const, providers: {} } };
  const raw = yield* fs
    .readFileString(filePath)
    .pipe(Effect.mapError((cause) => userError(`Could not read ${filePath}.`, cause)));
  try {
    return { raw, config: parseSubpolarAgentProfilesConfig(raw) };
  } catch (cause) {
    return yield* Effect.fail(
      userError(`${filePath} is malformed or invalid. Fix it before changing profiles.`, cause),
    );
  }
});

const saveConfig = Effect.fn(function* (
  filePath: string,
  update: (config: SubpolarAgentProfilesConfig) => SubpolarAgentProfilesConfig,
) {
  const fs = yield* FileSystem.FileSystem;
  const targetPath = yield* resolveSymlinkTarget(filePath);
  const lock = yield* acquireConfigLock(targetPath);
  return yield* Effect.gen(function* () {
    const { raw, config } = yield* readConfig(targetPath);
    let next: SubpolarAgentProfilesConfig;
    try {
      next = update(config);
    } catch (cause) {
      return yield* Effect.fail(
        Schema.is(CliError.UserError)(cause)
          ? cause
          : userError("Could not update profiles.", cause),
      );
    }
    const contents = `${encodeProfilesConfig(next)}\n`;
    if (raw === undefined) {
      const exists = yield* fs
        .exists(targetPath)
        .pipe(Effect.mapError((cause) => userError(`Could not inspect ${targetPath}.`, cause)));
      if (exists) {
        return yield* Effect.fail(userError(`${targetPath} changed while saving. Try again.`));
      }
    }
    yield* writePrivateConfigAtomically(targetPath, contents);
    return next;
  }).pipe(Effect.ensuring(releaseConfigLock(lock).pipe(Effect.ignore({ log: true }))));
});

function withProvider(
  config: SubpolarAgentProfilesConfig,
  providerInstanceId: string,
): SubpolarAgentProfilesConfig["providers"][string] {
  return config.providers[providerInstanceId] ?? { profiles: [] };
}

function selectedView(provider: {
  profiles: readonly SubpolarAgentProfile[];
  selectedProfileId?: string | undefined;
}) {
  return provider.profiles.map(({ id, name }) => ({
    id,
    name,
    selected: id === provider.selectedProfileId,
  }));
}

const listCommand = Command.make("list", {
  baseDir: baseDirFlag,
  providerInstance: providerInstanceFlag,
  json: jsonFlag,
}).pipe(
  Command.withDescription("List profiles for one ACP provider instance."),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const filePath = yield* stateFilePath(flags.baseDir);
      const { config } = yield* readConfig(filePath);
      const provider = withProvider(config, flags.providerInstance);
      const profiles = selectedView(provider);
      const result = {
        providerInstanceId: flags.providerInstance,
        selectedProfileId: provider.selectedProfileId ?? null,
        profiles,
      };
      yield* Console.log(
        flags.json
          ? encodePrettyJson(result)
          : profiles.length
            ? profiles
                .map((profile) => `${profile.selected ? "*" : " "} ${profile.id}\t${profile.name}`)
                .join("\n")
            : "No profiles configured for this provider instance.",
      );
    }),
  ),
);

const addCommand = Command.make("add", {
  baseDir: baseDirFlag,
  providerInstance: providerInstanceFlag,
  file: profileFileFlag,
  json: jsonFlag,
}).pipe(
  Command.withDescription("Add a profile from a JSON file."),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const fs = yield* FileSystem.FileSystem;
      const inputPath = path.resolve(flags.file);
      const rawProfile = yield* fs
        .readFileString(inputPath)
        .pipe(
          Effect.mapError((cause) => userError(`Could not read profile file ${inputPath}.`, cause)),
        );
      let profile: SubpolarAgentProfile;
      try {
        profile = parseSubpolarAgentProfile(rawProfile);
      } catch (cause) {
        return yield* Effect.fail(
          userError("Profile file is invalid or contains unsupported fields.", cause),
        );
      }
      const filePath = yield* stateFilePath(flags.baseDir);
      const next = yield* saveConfig(filePath, (config) => {
        const provider = withProvider(config, flags.providerInstance);
        if (provider.profiles.some((candidate) => candidate.id === profile.id)) {
          throw userError(`Profile ${profile.id} already exists for this provider instance.`);
        }
        return {
          ...config,
          providers: {
            ...config.providers,
            [flags.providerInstance]: { ...provider, profiles: [...provider.profiles, profile] },
          },
        };
      });
      const added = next.providers[flags.providerInstance]!.profiles.find(
        ({ id }) => id === profile.id,
      )!;
      yield* Console.log(
        flags.json
          ? encodePrettyJson({
              ok: true,
              providerInstanceId: flags.providerInstance,
              profile: { id: added.id, name: added.name },
            })
          : `Added profile ${added.id} (${added.name}).`,
      );
    }),
  ),
);

const selectCommand = Command.make("select", {
  baseDir: baseDirFlag,
  providerInstance: providerInstanceFlag,
  profileId: Argument.String("profile-id"),
  json: jsonFlag,
}).pipe(
  Command.withDescription("Select the profile used by one ACP provider instance."),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const filePath = yield* stateFilePath(flags.baseDir);
      const next = yield* saveConfig(filePath, (config) => {
        const provider = withProvider(config, flags.providerInstance);
        if (!provider.profiles.some(({ id }) => id === flags.profileId)) {
          throw userError(`Profile ${flags.profileId} does not exist for this provider instance.`);
        }
        return {
          ...config,
          providers: {
            ...config.providers,
            [flags.providerInstance]: { ...provider, selectedProfileId: flags.profileId },
          },
        };
      });
      yield* Console.log(
        flags.json
          ? encodePrettyJson({
              ok: true,
              providerInstanceId: flags.providerInstance,
              selectedProfileId: next.providers[flags.providerInstance]!.selectedProfileId,
            })
          : `Selected profile ${flags.profileId} for ${flags.providerInstance}.`,
      );
    }),
  ),
);

const removeCommand = Command.make("remove", {
  baseDir: baseDirFlag,
  providerInstance: providerInstanceFlag,
  profileId: Argument.String("profile-id"),
  json: jsonFlag,
}).pipe(
  Command.withDescription("Remove a profile from one ACP provider instance."),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const filePath = yield* stateFilePath(flags.baseDir);
      const next = yield* saveConfig(filePath, (config) => {
        const provider = withProvider(config, flags.providerInstance);
        if (!provider.profiles.some(({ id }) => id === flags.profileId)) {
          throw userError(`Profile ${flags.profileId} does not exist for this provider instance.`);
        }
        const profiles = provider.profiles.filter(({ id }) => id !== flags.profileId);
        const { selectedProfileId: _selected, ...unselected } = provider;
        return {
          ...config,
          providers: {
            ...config.providers,
            [flags.providerInstance]: {
              ...unselected,
              profiles,
              ...(provider.selectedProfileId === flags.profileId ||
              provider.selectedProfileId === undefined
                ? {}
                : { selectedProfileId: provider.selectedProfileId }),
            },
          },
        };
      });
      yield* Console.log(
        flags.json
          ? encodePrettyJson({
              ok: true,
              providerInstanceId: flags.providerInstance,
              removedProfileId: flags.profileId,
              selectedProfileId: next.providers[flags.providerInstance]!.selectedProfileId ?? null,
            })
          : `Removed profile ${flags.profileId} from ${flags.providerInstance}.`,
      );
    }),
  ),
);

const profilesCommand = Command.make("profiles").pipe(
  Command.withDescription("Manage Subpolar agent profiles stored in this T3 installation."),
  Command.withSubcommands([listCommand, addCommand, selectCommand, removeCommand]),
);

export const subpolarCommand = Command.make("subpolar").pipe(
  Command.withDescription("Manage Subpolar settings for this T3 installation."),
  Command.withSubcommands([profilesCommand]),
);
