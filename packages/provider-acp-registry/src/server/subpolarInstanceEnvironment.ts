export function bindSubpolarProviderInstanceEnvironment(
  environment: NodeJS.ProcessEnv,
  instanceId: string,
  configuredInstanceToken?: string,
): NodeJS.ProcessEnv {
  const bound = { ...environment, SUBPOLAR_PROVIDER_INSTANCE_ID: instanceId };
  // Host-level manager tokens would otherwise be inherited by every ACP child.
  // Only an explicit provider-instance token grants manager access.
  delete bound.SUBPOLAR_MANAGER_TOKEN;
  delete bound.SUBPOLAR_MANAGER_INSTANCE_TOKEN;
  delete bound.SUBPOLAR_OWNER_ID;
  if (!configuredInstanceToken?.trim()) return bound;
  bound.SUBPOLAR_MANAGER_INSTANCE_TOKEN = configuredInstanceToken;
  bound.SUBPOLAR_OWNER_ID = instanceId;
  return bound;
}
