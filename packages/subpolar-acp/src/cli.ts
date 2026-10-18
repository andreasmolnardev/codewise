#!/usr/bin/env bun

import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";

import { createManagedExecutionOptions } from "./managedExecution.ts";
import { layerManagedStdio } from "./managedProxy.ts";
import { layerStdio } from "./index.ts";
import { createWorkerExecutionOptions } from "./workerExecution.ts";

const executionMode = process.env.SUBPOLAR_ACP_EXECUTION ?? "local";
if (executionMode !== "local" && executionMode !== "managed") {
  throw new Error("SUBPOLAR_ACP_EXECUTION must be either local or managed");
}

const selectedLayer = executionMode === "managed"
  ? layerManagedStdio({ environment: process.env })
  : layerStdio(process.env.SUBPOLAR_ACP_WORKER_MODE === "1"
    ? createWorkerExecutionOptions(process.env)
    : createManagedExecutionOptions(process.env));
const program = Layer.launch(Layer.provide(selectedLayer, NodeServices.layer));
program.pipe(NodeRuntime.runMain);
