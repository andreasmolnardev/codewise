import * as Schema from "effect/Schema";

const MAX_CONFIG_BYTES = 256_000;
const MAX_PROFILES = 64;
const MAX_TOOL_IDS = 256;

export const SubpolarAgentProfile = Schema.Struct({
  id: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128)),
  name: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
  preferredHarness: Schema.optional(Schema.String.check(Schema.isMaxLength(128))),
  model: Schema.optional(Schema.String.check(Schema.isMaxLength(256))),
  thinkingLevel: Schema.optional(Schema.String.check(Schema.isMaxLength(32))),
  instructions: Schema.optional(Schema.String.check(Schema.isMaxLength(32_000))),
  allowedToolIds: Schema.optional(
    Schema.Array(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256))).check(
      Schema.isMaxLength(MAX_TOOL_IDS),
    ),
  ),
  toolPolicies: Schema.optional(
    Schema.Record(
      Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
      Schema.Struct({
        allow: Schema.optional(Schema.Boolean),
        deny: Schema.optional(Schema.Boolean),
        requiresApproval: Schema.optional(Schema.Boolean),
        reason: Schema.optional(Schema.String.check(Schema.isMaxLength(1_024))),
      }),
    ),
  ),
});

const ProviderProfiles = Schema.Struct({
  profiles: Schema.Array(SubpolarAgentProfile).check(Schema.isMaxLength(MAX_PROFILES)),
  selectedProfileId: Schema.optional(
    Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128)),
  ),
});

export const SubpolarAgentProfilesConfig = Schema.Struct({
  version: Schema.Literal(1),
  providers: Schema.Record(
    Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
    ProviderProfiles,
  ),
});

export type SubpolarAgentProfile = typeof SubpolarAgentProfile.Type;
export type SubpolarAgentProfilesConfig = typeof SubpolarAgentProfilesConfig.Type;

const decodeConfig = Schema.decodeUnknownSync(SubpolarAgentProfilesConfig);
const PROFILE_KEYS = new Set([
  "id",
  "name",
  "preferredHarness",
  "model",
  "thinkingLevel",
  "instructions",
  "allowedToolIds",
  "toolPolicies",
]);

function assertKeys(
  value: unknown,
  allowed: ReadonlySet<string>,
  label: string,
): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object.`);
  }
  const unexpected = Object.keys(value).find((key) => !allowed.has(key));
  if (unexpected !== undefined) throw new Error(`Unsupported ${label} field: ${unexpected}`);
}

/** Parse and enforce cross-field constraints shared by the host CLI and ACP loader. */
export function parseSubpolarAgentProfilesConfig(raw: string): SubpolarAgentProfilesConfig {
  if (Buffer.byteLength(raw, "utf8") > MAX_CONFIG_BYTES) {
    throw new Error("The private Subpolar agent profile configuration exceeds its size limit.");
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("The private Subpolar agent profile configuration is invalid.");
  }
  let config: SubpolarAgentProfilesConfig;
  try {
    config = decodeConfig(value);
  } catch {
    throw new Error("The private Subpolar agent profile configuration is invalid.");
  }
  for (const provider of Object.values(config.providers)) {
    const ids = new Set<string>();
    for (const profile of provider.profiles) {
      if (ids.has(profile.id)) {
        throw new Error(
          "The private Subpolar agent profile configuration contains duplicate profile IDs.",
        );
      }
      ids.add(profile.id);
      if (
        profile.allowedToolIds &&
        new Set(profile.allowedToolIds).size !== profile.allowedToolIds.length
      ) {
        throw new Error(`Subpolar agent profile ${profile.id} contains duplicate tool IDs.`);
      }
      if (profile.toolPolicies && Object.keys(profile.toolPolicies).length > MAX_TOOL_IDS) {
        throw new Error(`Subpolar agent profile ${profile.id} exceeds its tool policy limit.`);
      }
    }
    if (provider.selectedProfileId && !ids.has(provider.selectedProfileId)) {
      throw new Error(
        "The selected Subpolar agent profile does not exist for this provider instance.",
      );
    }
  }
  return config;
}

export function parseSubpolarAgentProfile(raw: string): SubpolarAgentProfile {
  if (Buffer.byteLength(raw, "utf8") > 48_000) {
    throw new Error("The Subpolar agent profile exceeds its size limit.");
  }
  const input: unknown = JSON.parse(raw);
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("A Subpolar agent profile must be a JSON object.");
  }
  assertKeys(input, PROFILE_KEYS, "Subpolar agent profile");
  return Schema.decodeUnknownSync(SubpolarAgentProfile)(input);
}
