// @effect-diagnostics nodeBuiltinImport:off -- The opt-in live fixture creates and cleans up its own child process and temporary files.
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as SourceControlProviderRegistry from "../sourceControl/SourceControlProviderRegistry.ts";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as NodeUrl from "node:url";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  EnvironmentId,
  CommandId,
  type ModelSelection,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as ResetCreditCoordinator from "../provider/resetCreditCoordinator.ts";
import { FetchHttpClient } from "effect/http";
import { describe } from "vite-plus/test";

import * as CheckpointStore from "../checkpointing/CheckpointStore.ts";
import * as BackgroundPolicy from "../background/BackgroundPolicy.ts";
import * as HostPowerMonitor from "../background/HostPowerMonitor.ts";
import * as ServerConfig from "../config.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as AntigravityInstallation from "../provider/AntigravityInstallation.ts";
import * as CodexInstallation from "../provider/CodexInstallation.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ModelManifest from "../provider/ModelManifest.ts";
import * as ProviderInstanceRegistryHydration from "../provider/ProviderInstanceRegistryHydration.ts";
import * as ProviderLatestVersions from "@t3tools/provider-core/server/ProviderLatestVersions";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as ProviderEventLoggers from "@t3tools/provider-core/server/ProviderEventLoggers";
import * as OpenCodeRuntime from "@t3tools/provider-opencode/server/OpenCodeRuntime";
import * as OpenCodeServerLedger from "@t3tools/provider-opencode/server/OpenCodeServerLedger";
import * as ServerSettings from "../serverSettings.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as EffectWorker from "./EffectWorker.ts";
import * as ProviderTurnStartServiceTestkit from "./ProviderTurnStartService.testkit.ts";
import * as RuntimeLayer from "./runtimeLayer.ts";
import * as McpSessionRegistryTestkit from "../mcp/McpSessionRegistry.testkit.ts";

const layerPlatformTest = Layer.merge(
  NodeServices.layer,
  Layer.mock(SourceControlProviderRegistry.SourceControlProviderRegistry)({
    resolveLink: () => Effect.die("unused title link"),
  }),
);

const runAntigravityFixture = process.env.T3_ACP_ANTIGRAVITY_LIVE === "1";
const runLocalMock = process.env.T3_ACP_REGISTRY_LIVE_LOCAL_MOCK === "1";
const liveAgentId = runAntigravityFixture
  ? "antigravity-acp"
  : runLocalMock
    ? "local mock ACP agent"
    : process.env.T3_ACP_REGISTRY_LIVE_AGENT_ID?.trim() || "devin";
const liveCommandPath = process.env.T3_ACP_REGISTRY_LIVE_COMMAND?.trim();
const liveCommandArgs = runLocalMock
  ? [
      "--import",
      NodeUrl.fileURLToPath(import.meta.resolve("tsx")),
      NodeUrl.fileURLToPath(new URL("../../scripts/acp-mock-agent.ts", import.meta.url)),
    ]
  : [];
const liveInstanceId = ProviderInstanceId.make("acpRegistry_live");
const liveModelSelection = {
  instanceId: liveInstanceId,
  model: "default",
} satisfies ModelSelection;
const nativeAcpEvents: Array<unknown> = [];

const layerServerConfig = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3-acp-registry-v2-live-",
});

const layerVcsDriverRegistry = VcsDriverRegistry.layer.pipe(
  Layer.provide(VcsProcess.layer),
  Layer.provide(layerServerConfig),
  Layer.provide(layerPlatformTest),
);

const layerCheckpointStore = CheckpointStore.layer.pipe(Layer.provide(layerVcsDriverRegistry));

const layerServerSettings = ServerSettings.layerTest({
  providerInstances: {
    [liveInstanceId]: {
      driver: ProviderDriverKind.make("acpRegistry"),
      displayName: `ACP Registry: ${liveAgentId}`,
      enabled: true,
      config: {
        ...(runLocalMock
          ? {
              source: "local",
              commandPath: liveCommandPath ?? process.execPath,
              commandArgs: liveCommandArgs,
            }
          : {
              agentId: liveAgentId,
              ...(liveCommandPath ? { commandPath: liveCommandPath } : {}),
            }),
      },
    },
  },
});
const layerBackgroundPolicy = BackgroundPolicy.layer.pipe(
  Layer.provide(Layer.effect(HostPowerMonitor.HostPowerMonitor, HostPowerMonitor.make())),
  Layer.provide(layerServerSettings),
);
const layerProviderInstanceRegistry = ProviderInstanceRegistryHydration.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      layerServerConfig.pipe(Layer.provide(layerPlatformTest)),
      layerServerSettings,
      ServerSecretStore.layer.pipe(
        Layer.provide(layerServerConfig),
        Layer.provide(layerPlatformTest),
      ),
      NodeServices.layer,
      FetchHttpClient.layer,
      OpenCodeRuntime.layer.pipe(
        Layer.provide(OpenCodeServerLedger.layerTest),
        Layer.provide(layerPlatformTest),
      ),
      Layer.succeed(ProviderEventLoggers.ProviderEventLoggers, {
        native: {
          filePath: "memory://acp-registry-live",
          write: (event) => Effect.sync(() => nativeAcpEvents.push(event)),
          close: () => Effect.void,
        },
        canonical: undefined,
      }),
      ProviderLatestVersions.layer,
      ModelManifest.layerTest,
      AntigravityInstallation.AntigravityInstallation.layer.pipe(
        Layer.provide(layerServerConfig.pipe(Layer.provide(layerPlatformTest))),
        Layer.provide(FetchHttpClient.layer),
        Layer.provide(layerPlatformTest),
      ),
      Layer.mock(CodexInstallation.CodexInstallation)({
        managedDirectory: "unused-managed-installation",
      }),
      Layer.succeed(ServerEnvironment.ServerEnvironmentIdentity, {
        getEnvironmentId: Effect.succeed(
          EnvironmentId.make("00000000-0000-4000-8000-000000000001"),
        ),
      }),
    ),
  ),
);

const layerLive = RuntimeLayer.layer.pipe(
  Layer.provide(McpSessionRegistryTestkit.layer),
  Layer.provide(SqlitePersistence.layerMemory),
  Layer.provide(layerCheckpointStore),
  Layer.provide(layerServerConfig),
  Layer.provide(layerServerSettings),
  Layer.provide(layerProviderInstanceRegistry),
  Layer.provide(ResetCreditCoordinator.layer),
  Layer.provide(layerBackgroundPolicy),
  Layer.provide(ProviderTurnStartServiceTestkit.layer),
  Layer.provide(layerPlatformTest),
  Layer.provide(McpProviderSessions.layer),
);

const watchProviderTurn = (
  orchestrator: Orchestrator.OrchestratorV2["Service"],
  threadId: ThreadId,
  afterSequence: number,
  status: "running" | "completed",
) =>
  orchestrator.streamStoredEventsFrom({ threadId, afterSequence }).pipe(
    Stream.map((stored) => stored.event),
    Stream.filter(
      (event) => event.type === "provider-turn.updated" && event.payload.status === status,
    ),
    Stream.take(1),
    Stream.runDrain,
    Effect.forkScoped,
  );

const watchRunStatus = (
  orchestrator: Orchestrator.OrchestratorV2["Service"],
  threadId: ThreadId,
  afterSequence: number,
  status: "waiting" | "completed",
) =>
  orchestrator.streamStoredEventsFrom({ threadId, afterSequence }).pipe(
    Stream.map((stored) => stored.event),
    Stream.filter((event) => event.type === "run.updated" && event.payload.status === status),
    Stream.take(1),
    Stream.runDrain,
    Effect.forkScoped,
  );

describe.runIf(
  runAntigravityFixture || runLocalMock || process.env.T3_ACP_REGISTRY_LIVE_ORCHESTRATOR === "1",
)("ACP Registry V2 live orchestrator", () => {
  it.live(
    `runs and resumes ${runAntigravityFixture ? "Google Antigravity" : runLocalMock ? "a local mock agent" : "a real registry agent"} through the production V2 harness`,
    () =>
      Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const projectId = ProjectId.make("project:acp-registry-live");
        const threadId = ThreadId.make("thread:acp-registry-live");
        const marker = "ACP_REGISTRY_LIVE_7H3Q";
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        const workspacePath = mkdtempSync(join(tmpdir(), "t3-acp-registry-live-"));
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => rmSync(workspacePath, { recursive: true, force: true })),
        );
        yield* Effect.sync(() => {
          execFileSync("git", ["init", "--quiet", workspacePath]);
          execFileSync("git", ["-C", workspacePath, "config", "user.name", "T3 ACP test"]);
          execFileSync("git", [
            "-C",
            workspacePath,
            "config",
            "user.email",
            "t3-acp-test@example.invalid",
          ]);
          execFileSync("git", [
            "-C",
            workspacePath,
            "commit",
            "--allow-empty",
            "--quiet",
            "-m",
            "test baseline",
          ]);
        });
        nativeAcpEvents.length = 0;

        yield* orchestrator.dispatch({
          type: "thread.create",
          createdBy: "user",
          creationSource: "web",
          commandId: CommandId.make("command:acp-registry-live:create"),
          threadId,
          projectId,
          title: `ACP Registry live: ${liveAgentId}`,
          modelSelection: liveModelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: workspacePath,
        });
        yield* Console.log(
          `ACP Registry thread created for '${liveAgentId}'; dispatching first prompt.`,
        );
        const firstAfterSequence = yield* orchestrator.getThreadEventSequence(threadId);
        const firstRunning = yield* watchProviderTurn(
          orchestrator,
          threadId,
          firstAfterSequence,
          "running",
        );
        const firstCompleted = yield* watchProviderTurn(
          orchestrator,
          threadId,
          firstAfterSequence,
          "completed",
        );
        const firstRunWaiting = yield* watchRunStatus(
          orchestrator,
          threadId,
          firstAfterSequence,
          "waiting",
        );
        const firstRunCompleted = yield* watchRunStatus(
          orchestrator,
          threadId,
          firstAfterSequence,
          "completed",
        );
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          createdBy: "user",
          creationSource: "web",
          commandId: CommandId.make("command:acp-registry-live:first"),
          threadId,
          messageId: MessageId.make("message:acp-registry-live:first"),
          text: `Remember this opaque marker. Respond with exactly: ${marker}`,
          attachments: [],
          modelSelection: liveModelSelection,
          dispatchMode: { type: "start_immediately" },
        });
        yield* worker.drain();
        yield* Fiber.join(firstRunning);
        yield* Fiber.join(firstCompleted);
        yield* Fiber.join(firstRunWaiting);
        yield* worker.drain();
        yield* Fiber.join(firstRunCompleted);
        const firstProjection = yield* orchestrator.getThreadProjection(threadId);
        const firstAssistant = firstProjection.messages.findLast(
          (message) => message.role === "assistant",
        )?.text;

        assert.deepEqual(
          firstProjection.runs.map((run) => [run.providerInstanceId, run.status]),
          [[liveInstanceId, "completed"]],
        );
        assert.include(firstAssistant ?? "", marker);
        assert.include(JSON.stringify(nativeAcpEvents), "session/prompt");

        yield* Console.log("First ACP turn completed; dispatching continuation prompt.");
        const secondAfterSequence = yield* orchestrator.getThreadEventSequence(threadId);
        const secondRunning = yield* watchProviderTurn(
          orchestrator,
          threadId,
          secondAfterSequence,
          "running",
        );
        const secondCompleted = yield* watchProviderTurn(
          orchestrator,
          threadId,
          secondAfterSequence,
          "completed",
        );
        const secondRunWaiting = yield* watchRunStatus(
          orchestrator,
          threadId,
          secondAfterSequence,
          "waiting",
        );
        const secondRunCompleted = yield* watchRunStatus(
          orchestrator,
          threadId,
          secondAfterSequence,
          "completed",
        );
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          createdBy: "user",
          creationSource: "web",
          commandId: CommandId.make("command:acp-registry-live:second"),
          threadId,
          messageId: MessageId.make("message:acp-registry-live:second"),
          text: "Return the opaque marker from the previous turn. Respond with only the marker.",
          attachments: [],
          modelSelection: liveModelSelection,
          dispatchMode: { type: "start_immediately" },
        });
        yield* worker.drain();
        yield* Fiber.join(secondRunning);
        yield* Fiber.join(secondCompleted);
        yield* Fiber.join(secondRunWaiting);
        yield* worker.drain();
        yield* Fiber.join(secondRunCompleted);
        const finalProjection = yield* orchestrator.getThreadProjection(threadId);
        const finalAssistant = finalProjection.messages.findLast(
          (message) => message.role === "assistant",
        )?.text;

        assert.deepEqual(
          finalProjection.runs.map((run) => [run.providerInstanceId, run.status]),
          [
            [liveInstanceId, "completed"],
            [liveInstanceId, "completed"],
          ],
        );
        assert.include(finalAssistant ?? "", marker);
        const acpLogs = JSON.stringify(nativeAcpEvents);
        assert.equal(acpLogs.match(/"method":"session\/new"/g)?.length, 2);
        assert.equal(acpLogs.match(/"method":"session\/prompt"/g)?.length, 4);
        // The runtime stays attached to this thread, so both turns reuse one ACP session.
        assert.deepEqual(finalProjection.providerSessions.length, 1);
        assert.isAtLeast(finalProjection.providerThreads.length, 1);
        assert.deepEqual(
          finalProjection.providerTurns.map((turn) => turn.status),
          ["completed", "completed"],
        );
        assert.isNotNull(finalProjection.runs[0]?.checkpointId);
        assert.isNotNull(finalProjection.runs[1]?.checkpointId);
      }).pipe(Effect.provide(layerLive), Effect.scoped),
    480_000,
  );
});
