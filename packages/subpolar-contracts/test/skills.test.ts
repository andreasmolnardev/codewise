import { describe, expect, test } from "bun:test";
import { createSkill, DEVELOPMENT_WORKFLOW_SKILL, InMemorySkillRepository, listSkills, resolveEffectiveSkills, SkillConflictError, SkillNotFoundError, SkillValidationError, updateSkill } from "../src/index.ts";

const globalSkill = createSkill({ id: "docs", name: "docs", scope: "global", mode: "always-loaded", body: "global body", metadata: { kind: "guide" } });

describe("skill contracts", () => {
  test("validates stable names, scope requirements, and bounds", () => {
    expect(() => createSkill({ id: "bad id", name: "Bad Name", scope: "agent", mode: "always-loaded", body: "", agentId: "a" })).toThrow(SkillValidationError);
    expect(() => createSkill({ id: "x", name: "x", scope: "project", mode: "disabled", body: "" })).toThrow("project skills require projectId");
  });

  test("stores only canonical tool IDs as non-authoritative references", async () => {
    const repository = new InMemorySkillRepository();
    const skill = await repository.create("alice", { id: "tool-guide", name: "tool-guide", scope: "global", mode: "discoverable", body: "guide", toolIds: ["read", "acme/search"] });
    expect(skill.toolIds).toEqual(["read", "acme/search"]);
    await expect(repository.create("alice", { id: "bad-tool", name: "bad-tool", scope: "global", mode: "discoverable", body: "", toolIds: [" acme/search"] })).rejects.toBeInstanceOf(SkillValidationError);
    await expect(repository.create("alice", { id: "duplicate-tool", name: "duplicate-tool", scope: "global", mode: "discoverable", body: "", toolIds: ["read", "read"] })).rejects.toThrow("toolIds must not contain duplicates");
    await repository.update("alice", { id: "tool-guide", version: 2, toolIds: ["write"] });
    expect((await repository.get("alice", "tool-guide")).toolIds).toEqual(["write"]);
  });

  test("provides the default development workflow without tool grants", () => {
    expect(DEVELOPMENT_WORKFLOW_SKILL).toMatchObject({ id: "development-workflow", scope: "global", mode: "always-loaded", toolIds: [] });
    expect(DEVELOPMENT_WORKFLOW_SKILL.body).toContain("selected worktree");
    expect(DEVELOPMENT_WORKFLOW_SKILL.body).toContain("user-configured project validation-command metadata");
    expect(DEVELOPMENT_WORKFLOW_SKILL.body).toContain("normal tool gateway");
    expect(DEVELOPMENT_WORKFLOW_SKILL.body).toContain("linked tools");
    expect(DEVELOPMENT_WORKFLOW_SKILL.body).toContain("Do not commit or push unless explicitly requested");
  });

  test("requires deterministic monotonic versions", () => {
    expect(globalSkill.version).toBe(1);
    expect(() => updateSkill(globalSkill, { id: "docs", version: 3 })).toThrow("exactly the next version");
    expect(updateSkill(globalSkill, { id: "docs", version: 2, body: "new" }).version).toBe(2);
  });

  test("lists without mutating records", () => {
    const skills = [globalSkill];
    expect(listSkills(skills, { scope: "global" })).toEqual(skills);
    expect(listSkills(skills, { includeDisabled: false })).toHaveLength(1);
  });

  test("applies precedence and project exposure reduction", () => {
    const project = createSkill({ id: "docs", name: "docs", scope: "project", projectId: "p", mode: "discoverable", body: "project body" });
    const agent = createSkill({ id: "docs", name: "docs", scope: "agent", agentId: "a", projectId: "p", mode: "always-loaded", body: "agent body" });
    const source = [globalSkill, project, agent];
    const result = resolveEffectiveSkills({ skills: source, projectId: "p", agentId: "a", explicitSkillIds: ["docs"] });
    expect(result[0]).toMatchObject({ id: "docs", exposure: "discoverable", body: "agent body" });
    expect(source).toEqual([globalSkill, project, agent]);
  });

  test("excludes disabled skills and only exposes bodies when allowed", () => {
    const discoverable = createSkill({ id: "find", name: "find", scope: "global", mode: "discoverable", body: "secret" });
    const disabled = createSkill({ id: "off", name: "off", scope: "global", mode: "disabled", body: "no" });
    const result = resolveEffectiveSkills({ skills: [discoverable, disabled] });
    expect(result).toEqual([{ ...discoverable, metadata: {}, exposure: "discoverable", body: "" }]);
    expect(resolveEffectiveSkills({ skills: [discoverable], explicitSkillIds: ["find"] })[0]?.body).toBe("secret");
  });

  test("isolates owners and keeps duplicate scoped skills at version one", async () => {
    const repository = new InMemorySkillRepository();
    await repository.create("alice", { id: "docs", name: "docs", scope: "global", mode: "always-loaded", body: "alice" });
    await repository.create("bob", { id: "docs", name: "docs", scope: "global", mode: "always-loaded", body: "bob" });
    await repository.create("alice", { id: "docs", name: "docs", scope: "project", projectId: "p", mode: "always-loaded", body: "project" });
    expect((await repository.get("alice", "docs", { scope: "global" })).body).toBe("alice");
    expect((await repository.get("bob", "docs", { scope: "global" })).body).toBe("bob");
    expect((await repository.get("alice", "docs", { scope: "project", projectId: "p" })).version).toBe(1);
  });

  test("versions exact updates, including mode changes, and rejects conflicts", async () => {
    const repository = new InMemorySkillRepository();
    await repository.create("alice", { id: "docs", name: "docs", scope: "global", mode: "discoverable", body: "one" });
    const updated = await repository.update("alice", { id: "docs", version: 2, mode: "disabled" });
    expect(updated).toMatchObject({ version: 2, mode: "disabled" });
    expect((await repository.get("alice", "docs", { version: 1 })).body).toBe("one");
    await expect(repository.update("alice", { id: "docs", version: 2, mode: "always-loaded" })).rejects.toBeInstanceOf(SkillConflictError);
    await expect(repository.get("missing-owner", "docs")).rejects.toBeInstanceOf(SkillNotFoundError);
  });

  test("filters, resolution, body exposure, and copies do not mutate storage", async () => {
    const repository = new InMemorySkillRepository();
    await repository.create("alice", { id: "docs", name: "docs", scope: "global", mode: "discoverable", body: "secret", metadata: { tag: "guide" } });
    await repository.create("alice", { id: "off", name: "off", scope: "global", mode: "disabled", body: "hidden" });
    const copy = await repository.get("alice", "docs");
    (copy.metadata as Record<string, string>).tag = "changed";
    expect((await repository.get("alice", "docs")).metadata.tag).toBe("guide");
    expect(await repository.list("alice", { includeDisabled: false, scope: "global", limit: 1 })).toHaveLength(1);
    expect((await repository.resolve("alice", {}))[0]?.body).toBe("");
    expect((await repository.resolve("alice", { explicitSkillIds: ["docs"] }))[0]?.body).toBe("secret");
  });
});
