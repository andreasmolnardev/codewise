import { expect, test } from "bun:test";
import { loadPiSdk } from "../src/sdk.ts";

test("loads the installed Pi SDK entry with the runtime exports we use", async () => {
  const sdk = await loadPiSdk();

  expect(sdk.createAgentSession).toBeFunction();
  expect(sdk.SessionManager.create).toBeFunction();
  expect(sdk.SessionManager.findById).toBeFunction();
  expect(sdk.SessionManager.open).toBeFunction();
  expect(sdk.SettingsManager.inMemory).toBeFunction();
  expect(sdk.DefaultResourceLoader).toBeFunction();
});
