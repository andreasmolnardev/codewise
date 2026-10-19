import type { PolicyRules } from "./index.ts";

export interface AgentProfileLayer {
  readonly preferredHarness?: string;
  readonly model?: string;
  readonly thinkingLevel?: string;
  readonly instructions?: string;
  /** Tool IDs allowed by this layer. Multiple layer allowlists are intersected. */
  readonly allowedToolIds?: readonly string[];
  readonly toolPolicies?: Readonly<Record<string, PolicyRules>>;
}

/** Persistence-neutral profile definition consumed by runtime adapters. */
export interface AgentProfileDefinition extends AgentProfileLayer {
  readonly id: string;
  readonly name: string;
}

/** A caller can provide profile definitions from any configuration source. */
export interface AgentProfileSelectionConfig {
  readonly profiles: readonly AgentProfileDefinition[];
  readonly defaultProfileId?: string;
}

export type AgentProfileSelection =
  | { readonly kind: "selected"; readonly profile: AgentProfileDefinition }
  | { readonly kind: "none" }
  | { readonly kind: "not-found"; readonly profileId: string };

/** Explicit selection wins over the configured default; no storage is implied. */
export function selectAgentProfile(
  config: AgentProfileSelectionConfig,
  requestedProfileId?: string,
): AgentProfileSelection {
  const profileId = requestedProfileId ?? config.defaultProfileId;
  if (profileId === undefined) return { kind: "none" };
  const profile = config.profiles.find((candidate) => candidate.id === profileId);
  return profile === undefined ? { kind: "not-found", profileId } : { kind: "selected", profile };
}

export interface AgentProfileLayers {
  readonly defaults?: AgentProfileLayer;
  readonly environment?: AgentProfileLayer;
  readonly project?: AgentProfileLayer;
  readonly selectedProfile?: AgentProfileLayer;
  readonly runtime?: AgentProfileLayer;
}

export interface ResolvedAgentProfile {
  readonly preferredHarness?: string;
  readonly model?: string;
  readonly thinkingLevel?: string;
  readonly instructions?: string;
  readonly allowedToolIds?: readonly string[];
  readonly toolPolicies: Readonly<Record<string, PolicyRules>>;
}

/** Resolve low-to-high configuration while keeping every tool allowlist restrictive. */
export function resolveAgentProfile(layers: AgentProfileLayers): ResolvedAgentProfile {
  const ordered = [
    layers.defaults,
    layers.environment,
    layers.project,
    layers.selectedProfile,
    layers.runtime,
  ].filter((layer): layer is AgentProfileLayer => layer !== undefined);
  let allowedToolIds: Set<string> | undefined;
  const toolPolicies: Record<string, PolicyRules> = {};
  let preferredHarness: string | undefined;
  let model: string | undefined;
  let thinkingLevel: string | undefined;
  let instructions: string | undefined;

  for (const layer of ordered) {
    if (layer.preferredHarness !== undefined) preferredHarness = layer.preferredHarness;
    if (layer.model !== undefined) model = layer.model;
    if (layer.thinkingLevel !== undefined) thinkingLevel = layer.thinkingLevel;
    if (layer.instructions !== undefined) instructions = layer.instructions;
    if (layer.allowedToolIds !== undefined) {
      const current = new Set(layer.allowedToolIds);
      allowedToolIds =
        allowedToolIds === undefined
          ? current
          : new Set([...allowedToolIds].filter((toolId) => current.has(toolId)));
    }
    for (const [toolId, rules] of Object.entries(layer.toolPolicies ?? {}).sort(([a], [b]) =>
      a.localeCompare(b),
    )) {
      const previous = toolPolicies[toolId];
      if (!previous) {
        toolPolicies[toolId] = { ...rules };
        continue;
      }
      const deny =
        previous.deny === true ||
        rules.deny === true ||
        previous.allow === false ||
        rules.allow === false;
      toolPolicies[toolId] = {
        ...(deny ? { deny: true } : {}),
        ...(!deny && (previous.requiresApproval === true || rules.requiresApproval === true)
          ? { requiresApproval: true }
          : {}),
        ...(!deny &&
        previous.requiresApproval !== true &&
        rules.requiresApproval !== true &&
        (previous.allow === true || rules.allow === true)
          ? { allow: true }
          : {}),
        ...((rules.reason ?? previous.reason) === undefined
          ? {}
          : { reason: rules.reason ?? previous.reason }),
      };
    }
  }

  return {
    ...(preferredHarness === undefined ? {} : { preferredHarness }),
    ...(model === undefined ? {} : { model }),
    ...(thinkingLevel === undefined ? {} : { thinkingLevel }),
    ...(instructions === undefined ? {} : { instructions }),
    ...(allowedToolIds === undefined ? {} : { allowedToolIds: [...allowedToolIds].sort() }),
    toolPolicies,
  };
}
