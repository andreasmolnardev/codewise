#!/bin/sh
set -eu

state_dir=/var/lib/codewise
workspace_dir=/workspaces
runtime_user=codewise

if [ "${T3CODE_HOME:-$state_dir}" != "$state_dir" ] || [ "${T3CODE_CONTAINER:-}" != "true" ]; then
  echo "container startup requires T3CODE_CONTAINER=true and T3CODE_HOME=$state_dir" >&2
  exit 64
fi

for target in "$state_dir" "$workspace_dir" /home/codewise/.codex /home/codewise/.config/opencode /home/codewise/.config/gh /home/codewise/.ssh; do
  mkdir -p "$target"
  chown 1000:1000 "$target"
done
chmod 700 /home/codewise/.ssh

# Validate writes as the service account, not root. This catches accidentally
# attached read-only or incorrectly-owned volumes before the listener starts.
setpriv --reuid=1000 --regid=1000 --init-groups sh -ceu '
  for target in /var/lib/codewise /workspaces; do
    probe="$target/.codewise-write-probe-$$"
    : > "$probe"
    rm -f "$probe"
  done
'

# A live database must be owned by one application instance. flock is held by
# the exec'd server process and released automatically on SIGTERM/exit.
exec flock -n "$state_dir/.server.lock" setpriv --reuid=1000 --regid=1000 --init-groups "$@"
