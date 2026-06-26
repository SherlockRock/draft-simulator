# syntax=docker/dockerfile:1
# Build context MUST be the repo root (Railway service: Root Directory "/",
# Dockerfile Path "backend/Dockerfile") — the Rust build needs the whole monorepo.

FROM rust:1.95-bookworm AS builder

# pnpm pinned: there is no packageManager field, so plain `corepack enable` would
# pick a version that rejects the lockfile under --frozen-lockfile.
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && corepack enable \
    && corepack prepare pnpm@10.30.0 --activate \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY . .

# Order is load-bearing: engine-protocol emits schema.json, which engine-core's
# build.rs reads (and panics without). napi build then emits
# packages/engine-node/index.node, after which the root target/ is safe to drop.
RUN pnpm install --frozen-lockfile \
    && pnpm build:types \
    && pnpm --filter @draft-sim/engine-protocol build \
    && pnpm --filter @draft-sim/engine-node build \
    && rm -rf target

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=builder /app /app
WORKDIR /app/backend

# Run pending DB migrations on boot (idempotent — Sequelize skips applied ones), then start.
CMD ["sh", "-c", "npx sequelize-cli db:migrate && node index.js"]
