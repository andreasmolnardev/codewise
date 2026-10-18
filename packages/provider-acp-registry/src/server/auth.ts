import {
  ProviderSetupError,
  type ProviderAuthMethod,
  type ProviderInstanceId,
} from "@t3tools/contracts";
import type { AcpRegistrySettings } from "../settings.ts";
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Semaphore from "effect/Semaphore";
import * as Scope from "effect/Scope";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import type * as AcpSchema from "effect-acp/compat";

import * as PtyAdapter from "@t3tools/shared/PtyAdapter";
import * as ProviderAuthFlow from "@t3tools/provider-core/server/providerAuthFlow";
import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import { normalizeAcpRegistryAuthMethods, normalizeAcpRegistryWebUrl } from "./probe.ts";
import * as AcpRegistrySupport from "./AcpRegistrySupport.ts";
import * as AcpRegistryRuntimeCoordinator from "./AcpRegistryRuntimeCoordinator.ts";
import * as AcpSessionRuntime from "@t3tools/provider-acp/server/AcpSessionRuntime";
import {
  isPiCredential,
  isPiProviderId,
  removePiCredential,
  setPiCredential,
} from "./subpolarCredentials.ts";

type Runtime = Pick<
  AcpSessionRuntime.AcpSessionRuntime["Service"],
  "initialize" | "authenticate" | "start" | "handleElicitation" | "logout"
>;

const MAX_AUTH_FORM_PAYLOAD_BYTES = 256 * 1024;
const SUBPOLAR_PI_CREDENTIAL_METHOD = "t3-subpolar-pi-credential";

export const makeAcpRegistryAuth = Effect.fn("makeAcpRegistryAuth")(function* (options: {
  readonly instanceId: ProviderInstanceId;
  readonly settings: AcpRegistrySettings;
  readonly cwd: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly host?: ProviderHost.ProviderHost["Service"];
  readonly onChanged: (authenticated: boolean) => Effect.Effect<void>;
  readonly makeRuntime?: (
    spawn: AcpSessionRuntime.AcpSpawnInput,
  ) => Effect.Effect<Runtime, ProviderSetupError, Scope.Scope>;
}) {
  const catalog = yield* AcpRegistrySupport.AcpRegistryCatalog;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const crypto = yield* Crypto.Crypto;
  const pty = yield* Effect.serviceOption(PtyAdapter.PtyAdapter);
  const coordinator = yield* Effect.serviceOption(
    AcpRegistryRuntimeCoordinator.AcpRegistryRuntimeCoordinator,
  );
  const agentKey =
    options.settings.source === "local" ? `local:${options.instanceId}` : options.settings.agentId;
  const failure = (operation: string, detail: string, cause?: unknown) =>
    new ProviderSetupError({ instanceId: options.instanceId, operation, detail, cause });
  const resolve = catalog
    .resolve(options.settings, options.cwd, options.environment)
    .pipe(
      Effect.mapError((cause) =>
        failure("start", "Could not prepare the selected ACP agent.", cause),
      ),
    );
  const makeRuntime =
    options.makeRuntime ??
    ((spawn) =>
      Effect.gen(function* () {
        const context = yield* Layer.build(
          AcpSessionRuntime.layer({
            spawn,
            cwd: options.cwd,
            authenticateOnAuthRequired: false,
            clientCapabilities: {
              auth: { terminal: Option.isSome(pty) },
              elicitation: { form: {}, url: {} },
              fs: { readTextFile: false, writeTextFile: false },
              terminal: false,
            },
            clientInfo: { name: "t3-code-provider-auth", version: "0.0.0" },
          }).pipe(
            Layer.provide(
              Layer.mergeAll(
                Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
                Layer.succeed(Crypto.Crypto, crypto),
              ),
            ),
          ),
        );
        return yield* Effect.service(AcpSessionRuntime.AcpSessionRuntime).pipe(
          Effect.provide(context),
        );
      }).pipe(
        Effect.mapError((cause) =>
          failure("start", "Could not start the selected ACP agent.", cause),
        ),
      ));

  let knownMethods:
    | { readonly version: string | null; readonly methods: ReadonlyArray<ProviderAuthMethod> }
    | undefined;
  const discoverMethods = Effect.scoped(
    Effect.gen(function* () {
      const inspected = yield* catalog
        .inspect(options.settings, options.environment)
        .pipe(
          Effect.mapError((cause) =>
            failure("methods", "Could not inspect the selected ACP agent.", cause),
          ),
        );
      if (inspected.status !== "ready")
        return yield* failure("methods", "Prepare this ACP agent before signing in.");
      // An unversioned command (a path override) can change in place, so only
      // registry versions reuse earlier discovery.
      if (inspected.version !== null && knownMethods?.version === inspected.version)
        return knownMethods.methods;
      const resolved = yield* resolve;
      const runtime = yield* makeRuntime(resolved.spawn);
      const initialized = yield* runtime
        .initialize()
        .pipe(
          Effect.mapError((cause) =>
            failure("methods", "Could not discover this agent's sign-in methods.", cause),
          ),
        );
      const advertised = normalizeAcpRegistryAuthMethods(initialized.authMethods)
        .filter(
          (method) => method.id.length <= 128 && (method.type !== "terminal" || Option.isSome(pty)),
        )
        .slice(0, 32)
        .map((method) => ({
          id: method.id,
          name: method.name,
          description: method.description,
          type: method.type === "env_var" ? ("credentials" as const) : method.type,
        }));
      knownMethods = { version: inspected.version, methods: advertised };
      return advertised;
    }),
  ).pipe(
    Effect.timeoutOrElse({
      duration: "30 seconds",
      orElse: () =>
        Effect.fail(failure("methods", "The ACP agent did not advertise sign-in methods in time.")),
    }),
  );

  const discoveredMethods = Option.isSome(coordinator)
    ? coordinator.value
        .runBackgroundProbe(agentKey, discoverMethods)
        .pipe(
          Effect.flatMap((result) =>
            Option.isSome(result)
              ? Effect.succeed(result.value)
              : Effect.fail(
                  failure(
                    "methods",
                    "Sign-in discovery was interrupted by an active provider session. Try again.",
                  ),
                ),
          ),
        )
    : discoverMethods;

  const configuredPiProviderId = options.settings.subpolarCredentialProviderId;
  const canConfigurePiCredential =
    options.settings.enableSubpolarCredentialBroker &&
    options.host !== undefined &&
    isPiProviderId(configuredPiProviderId);
  const methods = discoveredMethods.pipe(
    Effect.map((advertised) => {
      if (!canConfigurePiCredential) return advertised;
      return [
        ...advertised.filter((method) => method.id !== SUBPOLAR_PI_CREDENTIAL_METHOD),
        {
          id: SUBPOLAR_PI_CREDENTIAL_METHOD,
          name: "Pi provider credential",
          description: `Enter a Pi credential for ${configuredPiProviderId}. The credential is stored securely by T3 for this provider instance.`,
          type: "credentials" as const,
        },
      ];
    }),
  );

  const runTerminal = Effect.fnUntraced(function* (
    resolved: AcpRegistrySupport.ResolvedAcpRegistryAgent,
    method: Extract<AcpSchema.AuthMethod, { readonly type: "terminal" }>,
    context: ProviderAuthFlow.ProviderAuthFlowContext,
  ) {
    if (Option.isNone(pty))
      return yield* failure(
        "start",
        "Interactive provider login is unavailable on this environment.",
      );
    const exited = yield* Deferred.make<number>();
    const output = yield* Queue.sliding<string>(64);
    const process = yield* pty.value
      .spawn({
        shell: resolved.spawn.command,
        args: [...resolved.spawn.args, ...(method.args ?? [])],
        cwd: options.cwd,
        cols: 80,
        rows: 24,
        env: { ...options.environment, ...resolved.spawn.env, ...method.env },
      })
      .pipe(
        Effect.mapError((cause) =>
          failure("start", "Could not open the provider sign-in terminal.", cause),
        ),
      );
    const detachData = process.onData((data) => {
      Queue.offerUnsafe(output, data.slice(-16_384));
    });
    const detachExit = process.onExit(({ exitCode }) => {
      Deferred.doneUnsafe(exited, Effect.succeed(exitCode));
    });
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        detachData();
        detachExit();
        try {
          process.kill();
        } catch {}
      }),
    );
    let transcript = "";
    let outputOffset = 0;
    const update = () =>
      context.setInteraction(
        { type: "terminal", id: "terminal", output: transcript, outputOffset },
        (response) =>
          response.type === "terminal"
            ? Effect.try({
                try: () => {
                  if (response.size) process.resize(response.size.cols, response.size.rows);
                  if (response.data) process.write(response.data);
                },
                catch: () =>
                  failure("respond", "The provider sign-in terminal is no longer available."),
              })
            : Effect.void,
      );
    yield* update();
    yield* Queue.take(output).pipe(
      Effect.flatMap((data) => {
        outputOffset += data.length;
        transcript = (transcript + data).slice(-16_384);
        return update();
      }),
      Effect.forever,
      Effect.forkScoped,
    );
    if ((yield* Deferred.await(exited)) !== 0)
      return yield* failure("start", "The provider login command did not finish successfully.");
  });

  const authenticate = (methodId: string, context: ProviderAuthFlow.ProviderAuthFlowContext) =>
    Effect.gen(function* () {
      if (!options.settings.enabled)
        return yield* failure("start", "Enable this provider before signing in.");
      if (methodId === SUBPOLAR_PI_CREDENTIAL_METHOD) {
        if (!canConfigurePiCredential || !options.host) {
          return yield* failure(
            "start",
            "Configure an allowlisted Pi provider ID before entering its credential.",
          );
        }
        const values = yield* Deferred.make<Readonly<Record<string, string>> | null>();
        yield* context.setInteraction(
          {
            type: "credentials",
            id: context.flowId,
            fields: [{ name: "credentialJson", label: "Pi credential JSON", secret: true }],
          },
          (response) =>
            response.type === "credentials"
              ? Deferred.succeed(values, response.values).pipe(Effect.asVoid)
              : Effect.void,
        );
        const submitted = yield* Deferred.await(values);
        const credentialText = submitted?.credentialJson?.trim();
        if (!credentialText) return yield* failure("start", "A Pi credential is required.");
        const credential = yield* Effect.try({
          try: () => JSON.parse(credentialText) as unknown,
          catch: () => failure("start", "The Pi credential must be valid JSON."),
        });
        if (!isPiCredential(credential)) {
          return yield* failure(
            "start",
            'Use a Pi credential object with type "api_key" or type "oauth".',
          );
        }
        yield* context.verifying;
        yield* setPiCredential({
          host: options.host,
          instanceId: options.instanceId,
          providerId: configuredPiProviderId,
          credential,
        }).pipe(
          Effect.mapError(() => failure("start", "T3 could not save the Pi credential securely.")),
        );
        yield* options.onChanged(true);
        return;
      }
      const login = Effect.scoped(
        Effect.gen(function* () {
          const resolved = yield* resolve;
          const runtimeScope = yield* Scope.make();
          yield* Effect.addFinalizer(() => Scope.close(runtimeScope, Exit.void));
          const runtime = yield* makeRuntime(resolved.spawn).pipe(
            Effect.provideService(Scope.Scope, runtimeScope),
          );
          const elicitationLock = yield* Semaphore.make(1);
          let formInteractionOrdinal = 0;
          yield* runtime.handleElicitation((request) =>
            elicitationLock.withPermit(
              Effect.gen(function* () {
                if (request.mode === "form" && "requestedSchema" in request) {
                  const properties = request.requestedSchema.properties ?? {};
                  const entries = Object.entries(properties);
                  const requiredNames = request.requestedSchema.required ?? [];
                  const propertyNames = new Set(entries.map(([name]) => name));
                  if (
                    entries.length === 0 ||
                    entries.length > 16 ||
                    requiredNames.some((name) => !propertyNames.has(name)) ||
                    entries.some(
                      ([name, property]) =>
                        !isAuthFieldName(name) ||
                        property.type !== "string" ||
                        (property.enum != null && property.enum.length > 0) ||
                        (property.oneOf != null && property.oneOf.length > 0),
                    )
                  )
                    return { action: "decline" } as const;

                  const required = new Set(requiredNames);
                  const fields = entries.map(([name, property]) => {
                    const title = property.title?.trim();
                    const label = `${title || name}${required.has(name) ? " (required)" : ""}`;
                    return {
                      name,
                      label: label.slice(0, 256),
                      secret: isSecretAuthField(
                        name,
                        property.title,
                        property.description,
                        property.format,
                      ),
                    };
                  });
                  const id = `acp-form-${++formInteractionOrdinal}`;
                  const values = yield* Deferred.make<Readonly<Record<string, string>> | null>();
                  yield* context.setInteraction(
                    { type: "credentials", id, fields },
                    (response) =>
                      response.type === "credentials"
                        ? Deferred.succeed(values, response.values).pipe(Effect.asVoid)
                        : Effect.void,
                  );
                  const submitted = yield* Deferred.await(values);
                  if (submitted === null) return { action: "decline" } as const;
                  if (requiredNames.some((name) => !submitted[name]?.trim()))
                    return { action: "decline" } as const;
                  const content = Object.fromEntries(
                    entries.flatMap(([name]) =>
                      typeof submitted[name] === "string" ? [[name, submitted[name]]] : [],
                    ),
                  );
                  if (
                    Buffer.byteLength(JSON.stringify(content), "utf8") >
                    MAX_AUTH_FORM_PAYLOAD_BYTES
                  )
                    return { action: "decline" } as const;
                  return { action: "accept", content } as const;
                }
                if (
                  request.mode !== "url" ||
                  !("url" in request) ||
                  !("elicitationId" in request) ||
                  typeof request.url !== "string" ||
                  typeof request.elicitationId !== "string"
                )
                  return { action: "decline" } as const;
                const url = normalizeAcpRegistryWebUrl(request.url);
                const id = request.elicitationId.trim();
                if (!url || !id || id.length > 128) return { action: "decline" } as const;
                const consent = yield* Deferred.make<boolean>();
                yield* context.setInteraction(
                  { type: "browser", id, url, requiresConsent: true },
                  (response) =>
                    response.type === "browser"
                      ? Deferred.succeed(consent, response.action === "accept").pipe(
                          Effect.asVoid,
                        )
                      : Effect.void,
                );
                return (yield* Deferred.await(consent))
                  ? ({ action: "accept" } as const)
                  : ({ action: "decline" } as const);
              }),
            ),
          );
          const initialized = yield* runtime
            .initialize()
            .pipe(
              Effect.mapError((cause) =>
                failure("start", "Could not initialize the selected ACP agent.", cause),
              ),
            );
          const method = initialized.authMethods?.find((method) => method.id === methodId);
          if (!method)
            return yield* failure("start", "The agent no longer advertises this sign-in method.");
          if (method.type === "terminal") {
            yield* Scope.close(runtimeScope, Exit.void);
            yield* runTerminal(resolved, method, context).pipe(Effect.scoped);
            // Terminal login is a separate invocation. Reconnect after it exits so
            // the ACP process reads the credentials its login command persisted.
            const verifiedRuntime = yield* makeRuntime(resolved.spawn);
            yield* context.verifying;
            yield* verifiedRuntime
              .start()
              .pipe(
                Effect.mapError((cause) =>
                  failure(
                    "verify",
                    "The provider could not create a session after terminal sign-in.",
                    cause,
                  ),
                ),
              );
          } else {
            if (method.type === undefined || method.type === "agent") {
              if (!runtime.authenticate)
                return yield* failure(
                  "start",
                  "This runtime does not support explicit ACP sign-in.",
                );
              yield* runtime
                .authenticate(methodId)
                .pipe(
                  Effect.mapError((cause) =>
                    failure("start", "The ACP agent could not complete sign-in.", cause),
                  ),
                );
            }
            // Legacy env_var methods use the secret-backed environment fields in
            // provider settings. Never send their ID to authenticate.
            yield* context.verifying;
            yield* runtime
              .start()
              .pipe(
                Effect.mapError((cause) =>
                  failure(
                    "verify",
                    "The provider could not create a session after sign-in.",
                    cause,
                  ),
                ),
              );
          }
        }),
      );
      yield* Option.isSome(coordinator)
        ? coordinator.value.withForegroundStartup(agentKey, login)
        : login;
      yield* options.onChanged(true);
    });
  const logout = Effect.scoped(
    Effect.gen(function* () {
      if (canConfigurePiCredential && options.host) {
        yield* removePiCredential({
          host: options.host,
          instanceId: options.instanceId,
          providerId: configuredPiProviderId,
        }).pipe(
          Effect.mapError(() => failure("logout", "T3 could not remove the Pi credential securely.")),
        );
      }
      const resolved = yield* resolve;
      const runtime = yield* makeRuntime(resolved.spawn);
      yield* runtime.logout.pipe(
        Effect.mapError((cause) =>
          failure(
            "logout",
            "This ACP agent could not sign out. It may not advertise logout support.",
            cause,
          ),
        ),
      );
    }),
  ).pipe(
    Effect.timeoutOrElse({
      duration: "60 seconds",
      orElse: () =>
        Effect.fail(failure("logout", "The ACP agent did not finish signing out in time.")),
    }),
  );
  const signOut = (
    Option.isSome(coordinator) ? coordinator.value.withForegroundStartup(agentKey, logout) : logout
  ).pipe(Effect.andThen(options.onChanged(false)));
  return yield* ProviderAuthFlow.make({
    instanceId: options.instanceId,
    // ACP doesn't advertise its credential scope. Conservatively treat all
    // instances of the same agent on this environment as sharing credentials.
    credentialBinding: { owner: "provider", key: `acp:${agentKey}` },
    methods,
    ...(options.settings.authMethodId ? { defaultMethodId: options.settings.authMethodId } : {}),
    authenticate,
    logout: signOut,
  });
});

function isAuthFieldName(value: string) {
  return value.length > 0 && value.length <= 128 && value.trim() === value;
}

function isSecretAuthField(
  name: string,
  title: string | null | undefined,
  description: string | null | undefined,
  format: string | null | undefined,
) {
  const hint = `${name} ${title ?? ""} ${description ?? ""}`;
  if (
    /(?:password|passphrase|secret|token|credential|api[ _-]?key|private[ _-]?key|access[ _-]?key)/iu.test(
      hint,
    )
  )
    return true;
  if (format === "email" || format === "uri") return false;
  return !/(?:^|[^a-z])(?:user(?:name)?|login|email|account|organization|workspace|host|url)(?:$|[^a-z])/iu.test(
    `${name} ${title ?? ""}`,
  );
}
