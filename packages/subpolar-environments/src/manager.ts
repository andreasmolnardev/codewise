import { createEnvironmentManager, type EnvironmentManager } from "./index.ts";
import { createFileEnvironmentRegistrationStore } from "./persistence.ts";
import { createDockerEnvironmentBackend, type DockerEnvironmentConfig, type DockerClient } from "./docker.ts";
import { createDockerEngineClient, type DockerEngineClientOptions } from "./docker-engine.ts";

export interface DockerEnvironmentManagerOptions {
  readonly docker: DockerEnvironmentConfig;
  readonly dockerEngine: DockerEngineClientOptions;
  readonly registrationFile: string;
  readonly dockerClient?: DockerClient;
}

/** Compose the manager-owned Docker backend, durable registry, and coordinator. */
export function createDockerEnvironmentManager(options: DockerEnvironmentManagerOptions): EnvironmentManager {
  const client = options.dockerClient ?? createDockerEngineClient(options.dockerEngine);
  const backend = createDockerEnvironmentBackend(client, options.docker);
  const registrations = createFileEnvironmentRegistrationStore(options.registrationFile);
  return createEnvironmentManager(backend, registrations);
}
