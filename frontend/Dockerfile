# syntax=docker/dockerfile:1
# Frontend SPA image. Build context MUST be the repo root (Railway service:
# Root Directory "/", Dockerfile Path "frontend/Dockerfile") — the build needs the
# pnpm workspace (shared-types). Used instead of Railpack because Railpack detects
# the root Cargo.toml and installs ONLY Rust, dropping Node/pnpm for this service.

FROM node:22-bookworm-slim AS builder
RUN corepack enable && corepack prepare pnpm@10.30.0 --activate
WORKDIR /app
COPY . .

# Vite inlines VITE_* at build time. Railway passes service variables as build
# args for Dockerfile builds; re-export to ENV so `vite build` reads them.
ARG VITE_API_URL
ARG VITE_ENVIRONMENT
ARG VITE_GOOGLE_CLIENT_ID
ARG VITE_POSTHOG_HOST
ARG VITE_POSTHOG_KEY
ENV VITE_API_URL=$VITE_API_URL \
    VITE_ENVIRONMENT=$VITE_ENVIRONMENT \
    VITE_GOOGLE_CLIENT_ID=$VITE_GOOGLE_CLIENT_ID \
    VITE_POSTHOG_HOST=$VITE_POSTHOG_HOST \
    VITE_POSTHOG_KEY=$VITE_POSTHOG_KEY

RUN pnpm install --frozen-lockfile \
    && pnpm build:types \
    && pnpm --filter draft-simulator-frontend build

FROM node:22-bookworm-slim AS runtime
WORKDIR /app
RUN npm install -g serve
COPY --from=builder /app/frontend/dist ./frontend/dist
# serve auto-applies frontend/dist/serve.json (disables cleanUrls); -s = SPA fallback.
CMD ["sh", "-c", "serve -s frontend/dist -l tcp://0.0.0.0:$PORT"]
