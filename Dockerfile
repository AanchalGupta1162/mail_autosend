# syntax=docker/dockerfile:1
# Backend (Express API + send worker + reply sweep). The Next.js frontend has its own image:
# see web/Dockerfile. No secrets are baked in: every setting comes from the environment at
# run time (see .env.example); signature.html and the resume are mounted, not copied.

FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

FROM node:22-bookworm-slim AS runtime
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
# Applies pending migrations at start, then serves. Seed the admin once with:
#   docker run --rm --env-file <file> <image> node scripts/seedAdmin.js
CMD ["node", "src/server/server.js"]
