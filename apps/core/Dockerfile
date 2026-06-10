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

# Bundle the server (-> server-dist/core.mjs) and the migration runner.
RUN pnpm --filter @companyos/core build:server \
 && pnpm --filter @companyos/core exec esbuild src/db/migrate.ts --bundle --platform=node --format=esm --outfile=server-dist/migrate.mjs --packages=external || true

# ---------- runtime ----------
FROM node:22-slim AS runtime
ENV NODE_ENV=production \
    PORT=8080
WORKDIR /app

# The bundle marks workspace+npm deps external, so ship node_modules for runtime
# resolution of fastify/pg/jose/@anthropic-ai/@modelcontextprotocol, etc.
COPY --from=builder /repo/node_modules ./node_modules
COPY --from=builder /repo/apps/core/server-dist ./dist
COPY --from=builder /repo/apps/core/migrations ./migrations

EXPOSE 8080
USER node
HEALTHCHECK --interval=30s --timeout=3s --start-period=8s \
  CMD node -e "fetch('http://localhost:'+(process.env.PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/core.mjs"]
