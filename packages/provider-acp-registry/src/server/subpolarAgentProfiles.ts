import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { parseSubpolarAgentProfilesConfig } from "./subpolarAgentProfileConfig.ts";

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

export class SubpolarAgentProfilesError extends Schema.TaggedError<SubpolarAgentProfilesError>()(
  "SubpolarAgentProfilesError",
  { detail: Schema.String },
) {}

/**
 * Reads a private, server-owned profile catalog and passes only the selected
 * provider instance's resolved profile to its ACP process. This file contains
 * no credential fields and is never written by the provider adapter.
 */
export function subpolarAgentProfileEnvironment(input: {
  readonly stateDir: string;
  readonly providerInstanceId: string;
  readonly environment: NodeJS.ProcessEnv;
}): Effect.Effect<
  NodeJS.ProcessEnv,
  SubpolarAgentProfilesError,
  FileSystem.FileSystem | Path.Path
> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const inherited = Object.fromEntries(
      Object.entries(input.environment).filter(([name]) => name !== "SUBPOLAR_AGENT_PROFILE_JSON"),
    );
    const configPath = path.join(input.stateDir, "subpolar-agent-profiles.json");
    if (!(yield* fs.exists(configPath))) return inherited;

    const raw = yield* fs.readFileString(configPath).pipe(
      Effect.mapError(
        () =>
          new SubpolarAgentProfilesError({
            detail: "Could not read the private Subpolar agent profile configuration.",
          }),
      ),
    );
    const config = yield* Effect.try({
      try: () => parseSubpolarAgentProfilesConfig(raw),
      catch: (cause) =>
        new SubpolarAgentProfilesError({
          detail:
            cause instanceof Error
              ? cause.message
              : "The private Subpolar agent profile configuration is invalid.",
        }),
    });
    const provider = config.providers[input.providerInstanceId];
    if (provider === undefined || provider.selectedProfileId === undefined) return inherited;

    const selected = provider.profiles.find((profile) => profile.id === provider.selectedProfileId);
    if (selected === undefined) return inherited;
    const { id: _id, name: _name, ...resolved } = selected;
    const profileJson = encodeJson({ ...resolved, toolPolicies: resolved.toolPolicies ?? {} });
    if (Buffer.byteLength(profileJson, "utf8") > 48_000) {
      return yield* new SubpolarAgentProfilesError({
        detail: "The selected Subpolar agent profile exceeds its size limit.",
      });
    }
    return { ...inherited, SUBPOLAR_AGENT_PROFILE_JSON: profileJson };
  }).pipe(
    Effect.mapError((cause) =>
      Schema.is(SubpolarAgentProfilesError)(cause)
        ? cause
        : new SubpolarAgentProfilesError({
            detail: "Could not load the private Subpolar agent profile configuration.",
          }),
    ),
  );
}
