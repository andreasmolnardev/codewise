import { describe, expect, it } from "bun:test";
import { resolveAgentProfile } from "../src/index.ts";

describe("resolveAgentProfile", () => {
  it("applies model precedence from defaults through runtime overrides", () => {
    expect(
      resolveAgentProfile({
        defaults: { model: "default" },
        environment: { model: "environment" },
        project: { model: "project" },
        selectedProfile: { model: "profile" },
        runtime: { model: "runtime" },
      }).model,
    ).toBe("runtime");
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
