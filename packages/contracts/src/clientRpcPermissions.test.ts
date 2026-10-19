import { AuthSettingsWriteScope, WS_METHODS } from "./index.ts";
import { clientRpcRequiredScopes } from "./clientRpcPermissions.ts";
import { assert, it } from "@effect/vitest";

it("guards provider MCP administration with settings-write permission", () => {
  assert.deepEqual(clientRpcRequiredScopes(WS_METHODS.serverManageProviderMcp, {}), [
    AuthSettingsWriteScope,
  ]);
});
