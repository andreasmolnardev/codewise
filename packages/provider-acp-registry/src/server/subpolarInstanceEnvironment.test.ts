import { describe, expect, it } from "@effect/vitest";
import { bindSubpolarProviderInstanceEnvironment } from "./subpolarInstanceEnvironment.ts";

describe("bindSubpolarProviderInstanceEnvironment", () => {
  it("binds explicitly configured manager credentials and MCP ownership to the T3 provider instance", () => {
    const environment = bindSubpolarProviderInstanceEnvironment(
      {
        SUBPOLAR_MANAGER_TOKEN: "ambient-admin-token-that-must-not-escape",
        SUBPOLAR_MANAGER_INSTANCE_TOKEN: "ambient-host-token-01234567890123456789",
        SUBPOLAR_OWNER_ID: "forged-owner",
        SUBPOLAR_PROVIDER_INSTANCE_ID: "forged-instance",
      },
      "subpolar_team_a",
      "provider-instance-token-01234567890123456789",
    );

    expect(environment.SUBPOLAR_OWNER_ID).toBe("subpolar_team_a");
    expect(environment.SUBPOLAR_PROVIDER_INSTANCE_ID).toBe("subpolar_team_a");
    expect(environment.SUBPOLAR_MANAGER_TOKEN).toBeUndefined();
    expect(environment.SUBPOLAR_MANAGER_INSTANCE_TOKEN).toBe(
      "provider-instance-token-01234567890123456789",
    );
  });

  it("leaves unrelated ACP environments unchanged", () => {
    const environment = bindSubpolarProviderInstanceEnvironment(
      {
        PATH: "/bin",
        SUBPOLAR_MANAGER_TOKEN: "ambient-admin-token-that-must-not-escape",
        SUBPOLAR_MANAGER_INSTANCE_TOKEN: "ambient-host-token-01234567890123456789",
        SUBPOLAR_OWNER_ID: "forged-owner",
      },
      "acp_other",
    );
    expect(environment.SUBPOLAR_MANAGER_INSTANCE_TOKEN).toBeUndefined();
    expect(environment.SUBPOLAR_MANAGER_TOKEN).toBeUndefined();
    expect(environment.SUBPOLAR_OWNER_ID).toBeUndefined();
    expect(environment.SUBPOLAR_PROVIDER_INSTANCE_ID).toBe("acp_other");
  });
});
