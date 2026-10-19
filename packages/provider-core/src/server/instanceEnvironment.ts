import type { ProviderInstanceEnvironment } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";

import { expandHomePath } from "./pathExpansion.ts";

export const mergeProviderInstanceEnvironment = Effect.fn(function* (
  environment: ProviderInstanceEnvironment | undefined,
  baseEnv: NodeJS.ProcessEnv = process.env,
) {
  const next: NodeJS.ProcessEnv = { ...baseEnv };
  if (!environment || environment.length === 0) {
    delete next.SUBPOLAR_MANAGER_TOKEN;
    return next;
  }

  const home = yield* HostProcess.HomeDirectory;
  for (const variable of environment) {
    // Child processes do not apply shell expansion to environment values.
    next[variable.name] =
      variable.name === "CODEX_HOME" || variable.name === "CLAUDE_CONFIG_DIR"
        ? expandHomePath(variable.value, home)
        : variable.value;
  }
  // The gateway uses this admin token to reach Subpolar's manager. It must
  // never cross into a provider or terminal child process.
  delete next.SUBPOLAR_MANAGER_TOKEN;
  return next;
});
