import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { subpolarMcpEnvironment } from "./subpolarMcpConfig.ts";

it.layer(NodeServices.layer)("private Subpolar MCP config", (it) => {
  it.effect(
    "loads only the selected provider's MCP config and resolves headers from its environment",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped();
        yield* fs.writeFileString(
          path.join(root, "subpolar-mcp.json"),
          JSON.stringify({
            version: 1,
            providers: {
              subpolar_a: [
                {
                  id: "issues",
                  url: "https://mcp.example.com/v1",
                  headers: { Authorization: { env: "ISSUES_TOKEN" } },
                },
              ],
              subpolar_b: [{ id: "docs", url: "https://docs.example.com/mcp" }],
            },
          }),
        );

        const environment = yield* subpolarMcpEnvironment({
          stateDir: root,
          providerInstanceId: "subpolar_a",
          environment: {
            ISSUES_TOKEN: "provider-a-secret",
            SUBPOLAR_MCP_SERVERS: "ambient-server-config",
            SUBPOLAR_MCP_HEADER_0_0: "ambient-secret",
            KEEP: "yes",
          },
        });

        assert.deepEqual(JSON.parse(environment.SUBPOLAR_MCP_SERVERS ?? "null"), [
          {
            id: "issues",
            url: "https://mcp.example.com/v1",
            headers: { Authorization: { env: "SUBPOLAR_MCP_HEADER_0_0" } },
          },
        ]);
        assert.deepEqual(JSON.parse(environment.SUBPOLAR_MCP_ALLOWED_HOSTS ?? "null"), [
          "mcp.example.com",
        ]);
        assert.equal(environment.SUBPOLAR_MCP_HEADER_0_0, "provider-a-secret");
        assert.equal(environment.SUBPOLAR_MCP_HEADER_0_1, undefined);
        assert.equal(environment.KEEP, "yes");
        assert.isFalse(
          JSON.stringify(environment.SUBPOLAR_MCP_SERVERS).includes("provider-a-secret"),
        );
      }),
  );

  it.effect("clears inherited MCP values and fails closed for missing instance credentials", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped();
      yield* fs.writeFileString(
        path.join(root, "subpolar-mcp.json"),
        JSON.stringify({
          version: 1,
          providers: {
            subpolar_a: [
              {
                id: "issues",
                url: "https://mcp.example.com/v1",
                headers: { Authorization: { env: "MISSING_TOKEN" } },
              },
            ],
          },
        }),
      );

      const noConfig = yield* subpolarMcpEnvironment({
        stateDir: path.join(root, "other"),
        providerInstanceId: "subpolar_a",
        environment: { SUBPOLAR_MCP_SERVERS: "ambient", SUBPOLAR_MCP_HEADER_0_0: "secret" },
      });
      assert.equal(noConfig.SUBPOLAR_MCP_SERVERS, undefined);
      assert.equal(noConfig.SUBPOLAR_MCP_HEADER_0_0, undefined);

      const result = yield* subpolarMcpEnvironment({
        stateDir: root,
        providerInstanceId: "subpolar_a",
        environment: {},
      }).pipe(Effect.flip);
      assert.include(result.detail, "missing or invalid provider environment variable");
    }),
  );
});
