import * as Config from "effect/Config";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { Argument, Command, Flag } from "effect/cli";
import * as CliError from "effect/cli/CliError";
import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";
import {
  parseSubpolarAgentProfile,
  parseSubpolarAgentProfilesConfig,
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
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const { raw, config } = yield* readConfig(filePath);
    let next: SubpolarAgentProfilesConfig;
    try {
      next = update(config);
    } catch (cause) {
      return yield* Effect.fail(
        cause instanceof CliError.UserError
          ? cause
          : userError("Could not update profiles.", cause),
      );
    }
    const contents = `${JSON.stringify(next, null, 2)}\n`;
    const current = yield* fs.readFileString(filePath).pipe(
      Effect.catchIf(
        (error) => error.reason._tag === "NotFound",
        () => Effect.succeed(undefined),
      ),
      Effect.mapError((cause) => userError(`Could not re-read ${filePath} before saving.`, cause)),
    );
    if (current !== raw) continue;
    yield* writeFileStringAtomically({ filePath, contents }).pipe(
      Effect.mapError((cause) => userError(`Could not save ${filePath}.`, cause)),
    );
    return next;
  }
  return yield* Effect.fail(userError(`${filePath} kept changing while saving. Try again.`));
});

function withProvider(config: SubpolarAgentProfilesConfig, providerInstanceId: string) {
  return config.providers[providerInstanceId] ?? { profiles: [] };
}

function selectedView(provider: {
  profiles: readonly SubpolarAgentProfile[];
  selectedProfileId?: string;
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
          ? JSON.stringify(result, null, 2)
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
          ? JSON.stringify({
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
          ? JSON.stringify({
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
          ? JSON.stringify({
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
