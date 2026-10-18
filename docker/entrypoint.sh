#!/bin/sh
set -eu

state_dir=/var/lib/codewise
workspace_dir=/workspaces

if [ "${T3CODE_HOME:-$state_dir}" != "$state_dir" ] || [ "${T3CODE_CONTAINER:-}" != "true" ]; then
  echo "container startup requires T3CODE_CONTAINER=true and T3CODE_HOME=$state_dir" >&2
  exit 64
fi

for target in "$state_dir" "$workspace_dir" /home/codewise/.codex /home/codewise/.config/opencode /home/codewise/.config/gh /home/codewise/.ssh; do
  mkdir -p "$target"
done
chmod 700 /home/codewise/.ssh

# Validate mounted paths as the service account before the listener starts.
if [ "$(id -u)" -ne 1000 ] || [ "$(id -g)" -ne 1000 ]; then
  echo "container startup requires UID:GID 1000:1000" >&2
  exit 64
fi

for target in "$state_dir" "$workspace_dir"; do
  probe="$target/.codewise-write-probe-$$"
  if ! ( : > "$probe" && rm -f "$probe" ); then
    echo "container user cannot write to $target" >&2
    exit 73
  fi
done

# A live database must be owned by one application instance. flock is held by
# the exec'd server process and released automatically on SIGTERM/exit.
exec flock -n "$state_dir/.server.lock" "$@"
