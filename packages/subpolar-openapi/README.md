# `@subpolar/openapi`

Bounded OpenAPI operation discovery for Subpolar tool registries.

The package accepts an already supplied JSON OpenAPI document, applies host configured exact-origin policy, resolves bounded local schema references, removes credential-shaped fields, and returns normalized tool definitions with read/write/delete and approval metadata. It performs no file or network I/O and does not call provider operations.

Use `registerOpenApiToolDefinitions` to place the definitions in `@subpolar/tools`. Calls still pass through the registry's injected policy and approval gateway. The generated exact HTTPS origin is a destination constraint, not a substitute for execution-time DNS/IP validation; an OpenAPI adapter must use the host's SSRF-resistant network policy and must not accept a target from tool input.

```ts
import { discoverOpenApiTools, registerOpenApiToolDefinitions } from "@subpolar/openapi";

const definitions = discoverOpenApiTools(
  { name: "inventory", document, baseUrl: "https://api.example.test/v1" },
  { allowedOrigins: ["https://api.example.test"] },
);
registerOpenApiToolDefinitions(registry, definitions);
```

Discovery limits are exported as `OPENAPI_LIMITS`. Focused tests run with `bun test packages/subpolar-openapi/test`.
