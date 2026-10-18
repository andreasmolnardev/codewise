# Resolve only the ACP bridge's production dependency graph. Copy workspace
# manifests too so pnpm sees the same peer dependency topology as the lockfile.
FROM node:24-bookworm-slim AS subpolar-runtime

WORKDIR /workspace
RUN npm install --global pnpm@11.10.0

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY patches/ ./patches/
COPY --parents apps/*/package.json apps/mobile/modules/*/package.json infra/*/package.json packages/*/package.json oxlint-plugin-t3code/package.json scripts/package.json ./

RUN pnpm install --filter '@subpolar/acp...' --prod --frozen-lockfile --ignore-scripts

COPY packages/effect-acp/src ./packages/effect-acp/src
COPY packages/subpolar-acp/src ./packages/subpolar-acp/src
COPY packages/subpolar-contracts/src ./packages/subpolar-contracts/src
COPY packages/subpolar-core/src ./packages/subpolar-core/src
COPY packages/subpolar-core-pi/src ./packages/subpolar-core-pi/src
COPY packages/subpolar-environments/src ./packages/subpolar-environments/src
COPY packages/subpolar-runtime-host/src ./packages/subpolar-runtime-host/src
COPY packages/subpolar-tools/src ./packages/subpolar-tools/src

FROM oven/bun:1.3.14 AS bun-runtime

FROM node:24-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends bash ca-certificates git openssh-client \
  && rm -rf /var/lib/apt/lists/* \
  && mkdir -p /tmp/home /var/lib/subpolar /usr/local/lib/subpolar \
  && chown 1000:1000 /tmp/home /var/lib/subpolar

COPY --from=bun-runtime /usr/local/bin/bun /usr/local/bin/bun
COPY --from=subpolar-runtime /workspace/node_modules /opt/subpolar/node_modules
COPY --from=subpolar-runtime /workspace/packages/effect-acp /opt/subpolar/packages/effect-acp
COPY --from=subpolar-runtime /workspace/packages/effect-acp/node_modules /opt/subpolar/packages/effect-acp/node_modules
COPY --from=subpolar-runtime /workspace/packages/subpolar-acp /opt/subpolar/packages/subpolar-acp
COPY --from=subpolar-runtime /workspace/packages/subpolar-acp/node_modules /opt/subpolar/packages/subpolar-acp/node_modules
COPY --from=subpolar-runtime /workspace/packages/subpolar-contracts /opt/subpolar/packages/subpolar-contracts
COPY --from=subpolar-runtime /workspace/packages/subpolar-core /opt/subpolar/packages/subpolar-core
COPY --from=subpolar-runtime /workspace/packages/subpolar-core/node_modules /opt/subpolar/packages/subpolar-core/node_modules
COPY --from=subpolar-runtime /workspace/packages/subpolar-core-pi /opt/subpolar/packages/subpolar-core-pi
COPY --from=subpolar-runtime /workspace/packages/subpolar-core-pi/node_modules /opt/subpolar/packages/subpolar-core-pi/node_modules
COPY --from=subpolar-runtime /workspace/packages/subpolar-environments /opt/subpolar/packages/subpolar-environments
COPY --from=subpolar-runtime /workspace/packages/subpolar-runtime-host /opt/subpolar/packages/subpolar-runtime-host
COPY --from=subpolar-runtime /workspace/packages/subpolar-runtime-host/node_modules /opt/subpolar/packages/subpolar-runtime-host/node_modules
COPY --from=subpolar-runtime /workspace/packages/subpolar-tools /opt/subpolar/packages/subpolar-tools

COPY docker/subpolar-worker/worker.mjs /usr/local/lib/subpolar/worker.mjs
COPY docker/subpolar-worker/terminal-supervisor.mjs /usr/local/lib/subpolar/terminal-supervisor.mjs
RUN printf '%s\n' \
  '#!/bin/sh' \
  'export SUBPOLAR_ACP_EXECUTION=local' \
  'export SUBPOLAR_ACP_WORKER_MODE=1' \
  'exec bun /opt/subpolar/packages/subpolar-acp/src/cli.ts' \
  > /usr/local/bin/subpolar-acp-worker \
  && chmod 0555 /usr/local/lib/subpolar/worker.mjs \
    /usr/local/lib/subpolar/terminal-supervisor.mjs \
    /usr/local/bin/subpolar-acp-worker

ENV HOME=/tmp/home TMPDIR=/tmp
USER 1000:1000
WORKDIR /workspace
CMD ["node", "-e", "setInterval(() => {}, 3600000)"]
