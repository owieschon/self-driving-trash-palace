FROM node:22.23.1-bookworm-slim@sha256:6c74791e557ce11fc957704f6d4fe134a7bc8d6f5ca4403205b2966bd488f6b3

ENV COREPACK_HOME=/opt/corepack
ENV NEXT_TELEMETRY_DISABLED=1
ENV PNPM_HOME=/home/node/.local/share/pnpm
ENV PATH=${PNPM_HOME}:${PATH}

RUN mkdir -p "${COREPACK_HOME}" "${PNPM_HOME}" /workspace /var/lib/trash-palace/evidence \
    && corepack enable \
    && corepack prepare pnpm@11.7.0 --activate \
    && chown -R node:node /home/node /workspace /var/lib/trash-palace

WORKDIR /workspace
USER node

COPY --chown=node:node package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY --chown=node:node apps/gateway-simulator/package.json ./apps/gateway-simulator/package.json
COPY --chown=node:node apps/web/package.json ./apps/web/package.json
COPY --chown=node:node apps/worker/package.json ./apps/worker/package.json
COPY --chown=node:node packages/agent/package.json ./packages/agent/package.json
COPY --chown=node:node packages/application/package.json ./packages/application/package.json
COPY --chown=node:node packages/core/package.json ./packages/core/package.json
COPY --chown=node:node packages/db/package.json ./packages/db/package.json
COPY --chown=node:node packages/integration/package.json ./packages/integration/package.json
COPY --chown=node:node packages/mcp/package.json ./packages/mcp/package.json
COPY --chown=node:node packages/observability/package.json ./packages/observability/package.json
COPY --chown=node:node packages/testkit/package.json ./packages/testkit/package.json
RUN pnpm install --frozen-lockfile \
    && test -s node_modules/.modules.yaml \
    && test -s node_modules/.pnpm/lock.yaml \
    && test -s apps/web/node_modules/next/package.json \
    && node --import tsx -e "void 0"
COPY --chown=node:node . .
RUN test -s node_modules/.modules.yaml \
    && test -s node_modules/.pnpm/lock.yaml \
    && test -s apps/web/node_modules/next/package.json \
    && node --import tsx -e "void 0"

CMD ["pnpm", "--version"]
