# syntax=docker/dockerfile:1

# Debian rather than Alpine so better-sqlite3's glibc prebuilds work as shipped
# (the musl ones exist, but the glibc path is the one the sibling apps run).
#
# npm is pinned to the major that writes the committed lockfile, same as
# hawk-mod and this repo's CI.
FROM node:22-bookworm-slim AS base
RUN npm install -g npm@11

# --ignore-scripts is load-bearing. better-sqlite3 ships prebuilt binaries for
# linux/darwin/win x64+arm64 inside its tarball and declares no install script,
# but npm runs `node-gyp rebuild` by default for any package carrying a
# binding.gyp — which needs python3 and a C++ toolchain, and would compile from
# source what is already there. Nothing else in this tree needs an install
# script; if that changes, this flag has to be revisited.
FROM base AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts

# Production-only tree for the runtime stage. tsc emits plain JS with no
# bundling, so the runner needs real node_modules.
FROM base AS proddeps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

FROM base AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

FROM node:22-bookworm-slim AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3000
# The single durable location: the SQLite database, and nothing else.
ENV DATA_DIR=/data

RUN groupadd --system --gid 1001 nodejs \
  && useradd --system --uid 1001 --gid nodejs hawkbot

COPY --from=proddeps --chown=hawkbot:nodejs /app/node_modules ./node_modules
COPY --from=builder --chown=hawkbot:nodejs /app/dist ./dist
COPY --chown=hawkbot:nodejs package.json ./
# Applied on boot by src/db/client.ts, which walks up from the module to find
# this directory — so it has to ship alongside dist/.
COPY --chown=hawkbot:nodejs migrations ./migrations

RUN mkdir -p /data && chown -R hawkbot:nodejs /data

USER hawkbot
VOLUME ["/data"]
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/src/index.js"]
