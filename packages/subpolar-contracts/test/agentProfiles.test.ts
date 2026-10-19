import { describe, expect, it } from "bun:test";
import { resolveAgentProfile, selectAgentProfile } from "../src/index.ts";

describe("selectAgentProfile", () => {
  const profiles = [
    { id: "balanced", name: "Balanced", model: "model-balanced" },
    { id: "fast", name: "Fast", model: "model-fast" },
  ] as const;

  it("uses the configured default when no profile is explicitly requested", () => {
    expect(selectAgentProfile({ profiles, defaultProfileId: "balanced" })).toEqual({
      kind: "selected",
      profile: profiles[0],
    });
  });

  it("lets an explicit profile selection override the configured default", () => {
    const selection = selectAgentProfile({ profiles, defaultProfileId: "balanced" }, "fast");
    expect(selection).toEqual({ kind: "selected", profile: profiles[1] });
    if (selection.kind === "selected") {
      expect(resolveAgentProfile({ selectedProfile: selection.profile }).model).toBe("model-fast");
    }
  });

  it("distinguishes no selection from an unknown configured profile", () => {
    expect(selectAgentProfile({ profiles })).toEqual({ kind: "none" });
    expect(selectAgentProfile({ profiles, defaultProfileId: "missing" })).toEqual({
      kind: "not-found",
      profileId: "missing",
    });
  });
});

describe("resolveAgentProfile", () => {
  it("resolves runtime preferences from defaults through runtime overrides", () => {
    expect(
      resolveAgentProfile({
        defaults: { model: "default" },
        environment: { model: "environment" },
        project: { model: "project", preferredHarness: "project-harness" },
        selectedProfile: {
          model: "profile",
          preferredHarness: "profile-harness",
          thinkingLevel: "high",
          instructions: "profile instructions",
        },
        runtime: { model: "runtime", thinkingLevel: "low" },
      }),
    ).toMatchObject({
      model: "runtime",
      preferredHarness: "profile-harness",
      thinkingLevel: "low",
      instructions: "profile instructions",
    });
  });

  it("intersects tool allowlists so a more specific layer cannot widen access", () => {
    expect(
      resolveAgentProfile({
        defaults: { allowedToolIds: ["files/read", "files/write"] },
        selectedProfile: { allowedToolIds: ["files/read", "web/search"] },
        runtime: { allowedToolIds: ["files/read", "files/write", "web/search"] },
      }).allowedToolIds,
    ).toEqual(["files/read"]);
  });

  it("keeps the strongest tool policy across configuration layers", () => {
    expect(
      resolveAgentProfile({
        defaults: { toolPolicies: { "files/write": { allow: true } } },
        project: { toolPolicies: { "files/write": { requiresApproval: true } } },
        runtime: { toolPolicies: { "files/write": { deny: true, reason: "locked" } } },
      }).toolPolicies["files/write"],
    ).toEqual({ deny: true, reason: "locked" });
  });
});
