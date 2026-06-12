# Multi-stage build for the CompanyOS `core` modular monolith (HTTP API + MCP).
# Build context MUST be the repo root (workspace deps): from the repo root run
#   docker build -f apps/core/Dockerfile -t ghcr.io/arielshad/the-company-core:dev .

# ---------- builder ----------
FROM node:22-slim AS builder
ENV CI=true
RUN corepack enable
WORKDIR /repo

COPY . .
RUN pnpm install --frozen-lockfile

# Bundle the server fully (no --packages=external so workspace + npm deps are
# all inlined). ESM output + a require-shim banner lets CJS packages like
# @openfga/sdk use require('util') without hitting esbuild's dynamic-require
# limitation; the shim also gives node:sqlite's createRequire a valid URL.
RUN pnpm --filter @companyos/core exec \
      esbuild src/index.ts --bundle --platform=node --format=esm \
        --outfile=server-dist/core.mjs \
        --banner:js="import { createRequire as __cjsRequire } from 'module'; const require = __cjsRequire(import.meta.url);" \
 && pnpm --filter @companyos/core exec \
      esbuild src/db/migrate.ts --bundle --platform=node --format=esm \
        --outfile=server-dist/migrate.mjs --packages=external || true

# ---------- runtime ----------
FROM node:22-slim AS runtime
ENV NODE_ENV=production \
    PORT=8080
WORKDIR /app

# Self-contained bundle — no node_modules needed at runtime.
COPY --from=builder /repo/apps/core/server-dist ./dist
COPY --from=builder /repo/apps/core/migrations ./migrations

# Pre-create the SQLite data directory so the `node` user can write to it
# when the core-data volume is mounted at /data.
RUN mkdir -p /data && chown node:node /data

EXPOSE 8080
USER node
HEALTHCHECK --interval=30s --timeout=3s --start-period=8s \
  CMD node -e "fetch('http://localhost:'+(process.env.PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/core.mjs"]
