import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import type { ProviderMcpRegistryOptions } from "@subpolar/mcp";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as ServerConfig from "../config.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import { makeProviderMcpAdminService } from "./ProviderMcpAdminService.ts";

const layerServerSettings = () =>
  ServerSettings.layer.pipe(
    Layer.provide(ServerSecretStore.layer),
    Layer.provideMerge(Layer.fresh(SqlitePersistence.layerMemory)),
    Layer.provideMerge(
      Layer.fresh(ServerConfig.layerTest(process.cwd(), { prefix: "t3code-provider-mcp-test-" })),
    ),
  );

it.layer(NodeServices.layer)("provider MCP admin service", (it) => {
  it.effect("scopes credentials and allowed hosts to the selected provider instance", () =>
    Effect.gen(function* () {
      const settings = yield* ServerSettings.ServerSettingsService;
      const path = yield* Path.Path;
      const providerInstanceId = ProviderInstanceId.make("codex_mcp_test");
      yield* settings.updateSettings({
        providerInstances: {
          [providerInstanceId]: {
            driver: ProviderDriverKind.make("codex"),
            environment: [
              { name: "MCP_TEST_TOKEN", value: "secret-value", sensitive: true },
              { name: "UNRELATED_TOKEN", value: "must-not-leak", sensitive: true },
            ],
            config: {},
          },
        },
      });

      let registryOptions: ProviderMcpRegistryOptions | undefined;
      const service = makeProviderMcpAdminService({
        settings,
        path,
        createRegistry: (options) => {
          registryOptions = options;
          return {
            connect: async () => ({
              listTools: async () => [],
              callTool: async () => ({ content: [] }),
              close: async () => undefined,
            }),
            closeServer: async () => undefined,
            close: async () => undefined,
          } as unknown as ReturnType<typeof import("@subpolar/mcp").createProviderMcpRegistry>;
        },
      });

      const result = yield* service.execute({
        operation: "configureServer",
        providerInstanceId,
        config: {
          id: "docs",
          url: "https://mcp.example.com/v1",
          headers: { Authorization: { env: "MCP_TEST_TOKEN" } },
        },
      });

      assert.deepEqual(result, {
        operation: "configureServer",
        server: {
          id: "docs",
          url: "https://mcp.example.com/v1",
          namespace: "docs",
          timeoutMs: undefined,
          headerNames: ["Authorization"],
        },
      });
      assert.deepEqual(registryOptions, {
        providerInstanceId,
        allowedHosts: ["mcp.example.com"],
        environment: { MCP_TEST_TOKEN: "secret-value" },
      });
      assert.isFalse(JSON.stringify(result).includes("secret-value"));
      assert.isFalse(JSON.stringify(registryOptions).includes("must-not-leak"));
    }).pipe(Effect.provide(layerServerSettings())),
  );

  it.effect("rejects requests for provider instances absent from this server", () =>
    Effect.gen(function* () {
      const settings = yield* ServerSettings.ServerSettingsService;
      const path = yield* Path.Path;
      const service = makeProviderMcpAdminService({ settings, path });
      const result = yield* service
        .execute({
          operation: "listServers",
          providerInstanceId: ProviderInstanceId.make("missing"),
        })
        .pipe(Effect.flip);
      assert.equal(result.reason, "not_found");
    }).pipe(Effect.provide(layerServerSettings())),
  );

  it.effect("removes malformed stored URLs without constructing a network registry", () =>
    Effect.gen(function* () {
      const settings = yield* ServerSettings.ServerSettingsService;
      const path = yield* Path.Path;
      const providerInstanceId = ProviderInstanceId.make("codex_mcp_remove");
      yield* settings.updateSettings({
        providerInstances: {
          [providerInstanceId]: {
            driver: ProviderDriverKind.make("codex"),
            config: {},
          },
        },
      });
      yield* settings.putProviderInstanceMcpServer(providerInstanceId, {
        id: "legacy",
        url: "http://127.0.0.1/private",
      });

      const service = makeProviderMcpAdminService({
        settings,
        path,
        createRegistry: () => {
          throw new Error("remove should not create a network registry");
        },
      });
      const result = yield* service.execute({
        operation: "removeServer",
        providerInstanceId,
        serverId: "legacy",
      });

      assert.deepEqual(result, { operation: "removeServer", removed: true });
      assert.deepEqual(yield* settings.listProviderInstanceMcpServers(providerInstanceId), []);
    }).pipe(Effect.provide(layerServerSettings())),
  );
});
