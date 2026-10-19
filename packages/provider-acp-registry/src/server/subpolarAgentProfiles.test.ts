import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { subpolarAgentProfileEnvironment } from "./subpolarAgentProfiles.ts";

it.layer(NodeServices.layer)("private Subpolar agent profiles", (it) => {
  it.effect("selects only the profile owned by the matching ACP provider instance", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped();
      yield* fs.writeFileString(
        path.join(root, "subpolar-agent-profiles.json"),
        JSON.stringify({
          version: 1,
          providers: {
            instance_a: {
              selectedProfileId: "reviewer",
              profiles: [
                {
                  id: "reviewer",
                  name: "Reviewer",
                  model: "mock-a",
                  allowedToolIds: ["files/read"],
                  apiKey: "must-not-reach-provider",
                },
                { id: "unused", name: "Unused", model: "mock-unused" },
              ],
            },
            instance_b: {
              selectedProfileId: "writer",
              profiles: [{ id: "writer", name: "Writer", instructions: "write carefully" }],
            },
          },
        }),
      );

      const a = yield* subpolarAgentProfileEnvironment({
        stateDir: root,
        providerInstanceId: "instance_a",
        environment: { SUBPOLAR_AGENT_PROFILE_JSON: "ambient-profile", KEEP: "yes" },
      });
      assert.deepEqual(JSON.parse(a.SUBPOLAR_AGENT_PROFILE_JSON ?? "null"), {
        model: "mock-a",
        allowedToolIds: ["files/read"],
        toolPolicies: {},
      });
      assert.isFalse((a.SUBPOLAR_AGENT_PROFILE_JSON ?? "").includes("must-not-reach-provider"));
      assert.equal(a.KEEP, "yes");

      const b = yield* subpolarAgentProfileEnvironment({
        stateDir: root,
        providerInstanceId: "instance_b",
        environment: {},
      });
      assert.deepEqual(JSON.parse(b.SUBPOLAR_AGENT_PROFILE_JSON ?? "null"), {
        instructions: "write carefully",
        toolPolicies: {},
      });

      const other = yield* subpolarAgentProfileEnvironment({
        stateDir: root,
        providerInstanceId: "instance_c",
        environment: { SUBPOLAR_AGENT_PROFILE_JSON: "ambient-profile" },
      });
      assert.equal(other.SUBPOLAR_AGENT_PROFILE_JSON, undefined);
    }),
  );

  it.effect("fails closed for a missing selection and malformed profile config", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped();
      const file = path.join(root, "subpolar-agent-profiles.json");
      yield* fs.writeFileString(
        file,
        JSON.stringify({
          version: 1,
          providers: { instance_a: { selectedProfileId: "missing", profiles: [] } },
        }),
      );
      const missing = yield* subpolarAgentProfileEnvironment({
        stateDir: root,
        providerInstanceId: "instance_a",
        environment: { SUBPOLAR_AGENT_PROFILE_JSON: "ambient" },
      }).pipe(Effect.flip);
      assert.include(missing.detail, "does not exist");

      yield* fs.writeFileString(file, "{broken");
      const malformed = yield* subpolarAgentProfileEnvironment({
        stateDir: root,
        providerInstanceId: "instance_a",
        environment: {},
      }).pipe(Effect.flip);
      assert.include(malformed.detail, "is invalid");
    }),
  );
});
