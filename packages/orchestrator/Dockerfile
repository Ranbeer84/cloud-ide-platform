# syntax=docker/dockerfile:1

# Orchestrator image for Kubernetes (Phase 10).
#
# Build from the repository root, so the pnpm workspace and lockfile are in the context:
#
#   docker build -f packages/orchestrator/Dockerfile -t live/orchestrator:latest .
#
# Install scripts are skipped on purpose: pnpm 9 installs the whole workspace lockfile here, which
# includes node-pty (sandbox-agent only), and node-gyp cannot compile it on the slim image. The
# orchestrator needs no native build (ssh2 falls back to pure JS without cpu-features).
#
# Same recipe the Docker deployment uses in `app-install`: a production install from the
# frozen lockfile, plus the compiled output. Nothing is installed or compiled at start-up.

ARG NODE_IMAGE=node:20-bookworm-slim

# ---- build: full install and compile --------------------------------------
FROM ${NODE_IMAGE} AS build
WORKDIR /repo
RUN corepack enable && corepack prepare pnpm@9.0.0 --activate

# Manifests first, so dependency installation is cached until a manifest changes. Every
# workspace project's manifest must be present, or the frozen lockfile no longer matches.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/shared-types/package.json packages/shared-types/package.json
COPY packages/orchestrator/package.json packages/orchestrator/package.json
COPY packages/streaming/package.json packages/streaming/package.json
COPY packages/sandbox-agent/package.json packages/sandbox-agent/package.json
COPY packages/web/package.json packages/web/package.json
RUN pnpm install --frozen-lockfile --ignore-scripts --filter "@live/orchestrator..."

COPY packages/shared-types packages/shared-types
COPY packages/orchestrator packages/orchestrator
RUN pnpm --filter "@live/shared-types" run build \
    && pnpm --filter "@live/orchestrator" run build

# ---- runtime: production dependencies and compiled output only ------------
FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@9.0.0 --activate

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/shared-types/package.json packages/shared-types/package.json
COPY packages/orchestrator/package.json packages/orchestrator/package.json
COPY packages/streaming/package.json packages/streaming/package.json
COPY packages/sandbox-agent/package.json packages/sandbox-agent/package.json
COPY packages/web/package.json packages/web/package.json
RUN pnpm install --frozen-lockfile --prod --ignore-scripts --filter "@live/orchestrator..." \
    && rm -rf /root/.cache /root/.local/share/pnpm

COPY --from=build /repo/packages/shared-types/dist packages/shared-types/dist
COPY --from=build /repo/packages/orchestrator/dist packages/orchestrator/dist

# Numeric user, so Kubernetes can verify runAsNonRoot. The Deployment sets the same id.
RUN groupadd --system --gid 10001 live \
    && useradd --system --uid 10001 --gid live --no-create-home --shell /usr/sbin/nologin live
USER 10001:10001

WORKDIR /app/packages/orchestrator
EXPOSE 4100
CMD ["node", "dist/index.js"]