FROM node:22-alpine3.22@sha256:cd7807368cf24826297cbad5dca1a44972ccfd770647db52a8c7589eb4599ac8 AS devcontainer-cli

RUN apk add --no-cache curl \
  && mkdir -p /opt/devcontainer-cli \
  && curl -fsSL https://registry.npmjs.org/@devcontainers/cli/-/cli-0.89.0.tgz -o /tmp/devcontainer-cli.tgz \
  && tar -xzf /tmp/devcontainer-cli.tgz -C /opt/devcontainer-cli \
  && rm /tmp/devcontainer-cli.tgz

FROM oven/bun:1.3.14-alpine

RUN apk add --no-cache docker-cli \
  && mkdir -p /var/lib/subpolar \
  && chown bun:bun /var/lib/subpolar

COPY --from=devcontainer-cli /usr/local/bin/node /usr/local/bin/node
COPY --from=devcontainer-cli /opt/devcontainer-cli/package /opt/devcontainer-cli/package
RUN printf '%s\n' '#!/bin/sh' 'exec /usr/local/bin/node /opt/devcontainer-cli/package/devcontainer.js "$@"' > /usr/local/bin/devcontainer \
  && chmod 0755 /usr/local/bin/devcontainer \
  && /usr/local/bin/devcontainer --version | grep -Fx '0.89.0'

WORKDIR /opt/codewise
COPY --chown=bun:bun packages/subpolar-environments/package.json ./packages/subpolar-environments/package.json
COPY --chown=bun:bun packages/subpolar-environments/src ./packages/subpolar-environments/src
RUN cd packages/subpolar-environments \
  && bun install --production --no-save

ENV SUBPOLAR_MANAGER_HOST=0.0.0.0 \
    SUBPOLAR_MANAGER_PORT=8787 \
    SUBPOLAR_REGISTRATION_FILE=/var/lib/subpolar/environments.json

USER bun
EXPOSE 8787
ENTRYPOINT ["bun", "run", "packages/subpolar-environments/src/manager-cli.ts"]
