# syntax=docker/dockerfile:1
# Base image pinned by digest (multi-arch index of node:22-bookworm-slim, looked up 2026-10-13).
# Refresh with: docker buildx imagetools inspect node:22-bookworm-slim (Dependabot docker ecosystem can bump it).
# Next.js frontend (standalone server). Build from this directory:
#   docker build -f web/Dockerfile --build-arg BACKEND_URL=https://<backend> web
# BACKEND_URL is baked into the routes manifest by `next build` (the /api/* rewrite), so it must be
# given at BUILD time; it is also set in the image for proxy.ts, which reads it at run time.
# No secrets are involved: the browser only holds the backend's httpOnly session cookie.

FROM node:22-bookworm-slim@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392 AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM node:22-bookworm-slim@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392 AS build
WORKDIR /app
ARG BACKEND_URL
RUN test -n "$BACKEND_URL" || (echo "BACKEND_URL build arg is required" >&2; exit 1)
ENV BACKEND_URL=$BACKEND_URL NEXT_TELEMETRY_DISABLED=1
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

FROM node:22-bookworm-slim@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392 AS runtime
ARG BACKEND_URL
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 BACKEND_URL=$BACKEND_URL HOSTNAME=0.0.0.0 PORT=3001
WORKDIR /app
COPY --from=build --chown=node:node /app/.next/standalone ./
COPY --from=build --chown=node:node /app/.next/static ./.next/static
USER node
EXPOSE 3001
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||3001)+'/login',{redirect:'manual'}).then(r=>process.exit(r.status<500?0:1),()=>process.exit(1))"]
CMD ["node", "server.js"]
