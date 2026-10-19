import * as Schema from "effect/Schema";
import type { ResolvedAgentProfile } from "@subpolar/shared";

const MAX_PROFILE_JSON_BYTES = 48_000;
const PolicyRules = Schema.Struct({
  allow: Schema.optional(Schema.Boolean),
  deny: Schema.optional(Schema.Boolean),
  requiresApproval: Schema.optional(Schema.Boolean),
  reason: Schema.optional(Schema.String.check(Schema.isMaxLength(1_024))),
});

const ResolvedProfile = Schema.Struct({
  preferredHarness: Schema.optional(Schema.String.check(Schema.isMaxLength(128))),
  model: Schema.optional(Schema.String.check(Schema.isMaxLength(256))),
  thinkingLevel: Schema.optional(Schema.String.check(Schema.isMaxLength(32))),
  instructions: Schema.optional(Schema.String.check(Schema.isMaxLength(32_000))),
  allowedToolIds: Schema.optional(
    Schema.Array(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256))).check(
      Schema.isMaxLength(256),
    ),
  ),
  toolPolicies: Schema.Record(
    Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
    PolicyRules,
  ),
});
const decodeProfileJson = Schema.decodeUnknownSync(Schema.fromJsonString(ResolvedProfile));
const encodeProfileJson = Schema.encodeSync(Schema.fromJsonString(ResolvedProfile));

export type ResolvedSubpolarAgentProfile = ResolvedAgentProfile;

/** Profiles arrive through a server-generated, non-secret environment value. */
export function readSubpolarAgentProfile(
  environment: NodeJS.ProcessEnv,
): ResolvedSubpolarAgentProfile | undefined {
  const raw = environment.SUBPOLAR_AGENT_PROFILE_JSON;
  if (raw === undefined) return undefined;
  if (Buffer.byteLength(raw, "utf8") > MAX_PROFILE_JSON_BYTES) {
    throw new Error("Subpolar agent profile exceeds its size limit");
  }
  try {
    return decodeProfileJson(raw) as ResolvedAgentProfile;
  } catch {
    throw new Error("Subpolar agent profile is invalid");
  }
}

export function serializeSubpolarAgentProfile(profile: ResolvedSubpolarAgentProfile): string {
  return encodeProfileJson(profile);
}
