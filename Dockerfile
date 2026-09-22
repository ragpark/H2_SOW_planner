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

# Run as the unprivileged user the base image already provides.
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node package.json ./
COPY --chown=node:node src ./src
COPY --chown=node:node public ./public

USER node
EXPOSE 3000

# The platform sends SIGTERM on redeploy; the app drains and checkpoints SQLite.
CMD ["node", "src/server.js"]
