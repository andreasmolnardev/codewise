#!/bin/sh
set -eu

state_dir=/var/lib/codewise
workspace_dir=/workspaces

for target in "$state_dir" "$workspace_dir" /home/codewise/.codex /home/codewise/.config/opencode /home/codewise/.config/gh /home/codewise/.ssh; do
  mkdir -p "$target"
  chown 1000:1000 "$target"
done
chmod 700 /home/codewise/.ssh

# Vite's optimized dependency URLs are invalid after image or lockfile changes.
# These directories are generated caches, so recreate them for every dev start.
rm -rf /src/apps/web/node_modules/.vite /src/apps/web/node_modules/.vite-temp
mkdir -p /src/apps/web/node_modules/.vite-temp
chown 1000:1000 /src/apps/web/node_modules /src/apps/web/node_modules/.vite-temp

exec setpriv --reuid=1000 --regid=1000 --init-groups sh -ceu '
  for target in /var/lib/codewise /workspaces; do
    probe="$target/.codewise-write-probe-$$"
    : > "$probe"
    rm -f "$probe"
  done

  flock -n /var/lib/codewise/.server.lock sh -ceu '\''
    trap "kill 0" INT TERM EXIT
    pnpm --filter @t3tools/web dev --host 0.0.0.0 --force &
    pnpm --filter t3 dev &
    wait
  '\''
'
