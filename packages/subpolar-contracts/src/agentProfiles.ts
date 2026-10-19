import type { PolicyRules } from "./index.ts";

export interface AgentProfileLayer {
  readonly model?: string;
  /** Tool IDs allowed by this layer. Multiple layer allowlists are intersected. */
  readonly allowedToolIds?: readonly string[];
  readonly toolPolicies?: Readonly<Record<string, PolicyRules>>;
}

export interface AgentProfileLayers {
  readonly defaults?: AgentProfileLayer;
  readonly environment?: AgentProfileLayer;
  readonly project?: AgentProfileLayer;
  readonly selectedProfile?: AgentProfileLayer;
  readonly runtime?: AgentProfileLayer;
}

export interface ResolvedAgentProfile {
  readonly model?: string;
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
  let model: string | undefined;

  for (const layer of ordered) {
    if (layer.model !== undefined) model = layer.model;
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
    ...(model === undefined ? {} : { model }),
    ...(allowedToolIds === undefined ? {} : { allowedToolIds: [...allowedToolIds].sort() }),
    toolPolicies,
  };
}
