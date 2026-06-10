# Multi-stage build for the CompanyOS web app.
# Build context MUST be the repo root (workspace deps): from the repo root run
#   docker build -f apps/web/Dockerfile -t ghcr.io/companyos/web:dev .
# Produces a small runtime image: a single bundled Node server + static SPA.

# ---------- builder ----------
FROM node:22-slim AS builder
ENV CI=true
RUN corepack enable
WORKDIR /repo

# Install deps against the full workspace (lockfile-frozen for reproducibility).
COPY . .
RUN pnpm install --frozen-lockfile

# Build the SPA (-> apps/web/dist) and bundle the Node server (-> server-dist/serve.mjs).
RUN pnpm --filter @companyos/web build \
 && pnpm --filter @companyos/web build:server

# ---------- runtime ----------
FROM node:22-slim AS runtime
ENV NODE_ENV=production \
    PORT=3000 \
    WEB_DIST=/app/dist
WORKDIR /app

# Only the static bundle + the self-contained server are needed at runtime —
# no node_modules, no source, no package manager.
COPY --from=builder /repo/apps/web/dist ./dist
COPY --from=builder /repo/apps/web/server-dist/serve.mjs ./serve.mjs

EXPOSE 3000
USER node
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD node -e "fetch('http://localhost:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "serve.mjs"]
