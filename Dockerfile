# better-sqlite3 is a native module. A pinned Node image with build tools
# available means the build does not silently depend on a prebuilt binary
# existing for the host's architecture.
FROM node:22-slim AS build

WORKDIR /app
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
 && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM node:22-slim AS runtime

ENV NODE_ENV=production
WORKDIR /app

# gosu drops privileges without forking, so the app stays PID 1 and still
# receives SIGTERM directly when the platform redeploys.
RUN apt-get update \
 && apt-get install -y --no-install-recommends gosu \
 && rm -rf /var/lib/apt/lists/* \
 && gosu nobody true

COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node package.json ./
COPY --chown=node:node src ./src
COPY --chown=node:node public ./public
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh

# The container starts as root so the entrypoint can take ownership of a
# mounted volume, then drops to the unprivileged `node` user (uid 1000).
EXPOSE 3000
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["node", "src/server.js"]
