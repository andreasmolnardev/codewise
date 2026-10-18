#!/usr/bin/env node
import * as Layer from "effect/Layer";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { layerStdio } from "../../packages/subpolar-acp/src/index.ts";

const tool = {
  id: "test.echo",
  namespace: "test",
  description: "Echo a value after T3 approval",
  inputSchema: {
    type: "object",
    properties: { value: { type: "string" } },
    required: ["value"],
    additionalProperties: false,
  },
  enabled: true,
  risk: "low",
} as const;

const agent = layerStdio({
  toolDefinitions: [tool],
  resolveToolPolicy: () => ({ allow: true }),
  executeTool: async (call) => ({ ok: true, value: call.input }),
  executorFactory: async () => ({
    async execute(request) {
      const toolResult = await request.tools!.call({
        callId: "mock-pi-tool-call",
        toolId: "test.echo",
        input: { value: "approved" },
      });
      await request.emit({ type: "text", data: { text: `mock Pi answered: ${request.prompt}` } });
      return { text: `mock Pi answered: ${request.prompt}; tool result: ${JSON.stringify(toolResult)}` };
    },
  }),
});

Layer.launch(Layer.provide(agent, NodeServices.layer)).pipe(NodeRuntime.runMain);
