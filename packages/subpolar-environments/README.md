# Subpolar environment administration

The `subpolar` command manages environments through the authenticated Subpolar manager API. It does not open Docker or filesystem access directly. Configure:

- `SUBPOLAR_MANAGER_URL`
- `SUBPOLAR_MANAGER_TOKEN` (at least 32 characters)
- `SUBPOLAR_STORAGE_ROOT`
- optionally `SUBPOLAR_OWNER_ID` (defaults to `t3-installation`)

Manager URLs use HTTPS by default. Plain HTTP is accepted for loopback hosts;
for a private Docker Compose network, set `SUBPOLAR_MANAGER_ALLOW_PRIVATE_HTTP=true`
on the T3 process and use a private IP or the shipped Compose service name
`http://subpolar-manager:8787`. Other DNS names are rejected, including
single-label names and `.internal` or `.local` suffixes. Private IP support
includes RFC1918, loopback, link-local, and CGNAT ranges. Keep this setting
limited to trusted private networks because manager requests carry the bearer
token.

Commands:

```sh
subpolar status [--json]
subpolar environments list [--owner-id ID] [--json]
subpolar environments inspect /workspaces/project/worktree [--json]
subpolar environments start /workspaces/project/worktree [--json]
subpolar environments stop /workspaces/project/worktree [--json]
subpolar environments restart /workspaces/project/worktree [--json]
subpolar environments rebuild /workspaces/project/worktree [--json]
subpolar environments remove /workspaces/project/worktree [--json]
subpolar environments reconcile [--json]
```

`rebuild` replaces the environment container and starts a new one while preserving the T3 worktree and the manager-owned runtime data volume. `remove` deletes the environment registration, container, and that private runtime data volume; it does not delete the T3 worktree. Pi configuration and native session files use the persistent volume, so a T3 ACP session can continue after a worker restart when its saved Pi state is present. T3 remains the history authority; a missing or mismatched Pi session fails closed. Selected Dev Container configurations may define `postCreateCommand` and `postStartCommand` as shell strings or argv arrays. The manager runs them inside the verified worker from the worktree root; successful `postCreateCommand` runs are recorded on the runtime data volume, and a failed hook stops the worker and fails startup. Exit code `2` means invalid command or configuration, `4` means the requested environment was not found, and `1` means the manager request failed or reconciliation reported failures.
