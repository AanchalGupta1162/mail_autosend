# syntax=docker/dockerfile:1
# Base image pinned by digest (multi-arch index of node:22-bookworm-slim, looked up 2026-10-13).
# Refresh with: docker buildx imagetools inspect node:22-bookworm-slim (Dependabot docker ecosystem can bump it).
# Backend (Express API + send worker + reply sweep). The Next.js frontend has its own image:
# see web/Dockerfile. No secrets are baked in: every setting comes from the environment at
# run time (see .env.example); signature.html and the resume are mounted, not copied.

FROM node:22-bookworm-slim@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392 AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

FROM node:22-bookworm-slim@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392 AS runtime
# Security hardening of the runtime layer: pick up Debian security fixes published after the pinned
# base image, and drop npm/npx (not used at runtime; its bundled dependencies trigger scanner findings).
RUN apt-get update && apt-get upgrade -y --no-install-recommends \
    && rm -rf /var/lib/apt/lists/* /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx
ENV NODE_ENV=production
WORKDIR /app
COPY --from=deps --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node package.json ./
COPY --chown=node:node src ./src
COPY --chown=node:node scripts ./scripts
USER node
ENV PORT=3000
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
# Applies pending migrations at start unless MIGRATE_ON_START=false (then run them as a separate step/job:
#   node src/db/migrate.js). Seed the admin once with:
#   docker run --rm --env-file <file> <image> node scripts/seedAdmin.js
CMD ["node", "src/server/server.js"]
