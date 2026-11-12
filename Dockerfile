# The Lanes MCP server (lanes mcp) over stdio, for MCP directories and clients that run servers in containers.
# It starts with no repository and no Lanes server, answers initialize and tools/list, and reports clearly when a tool
# needs a repository (mount one and pass --dir) or a server (set LANES_SERVER and LANES_TOKEN).
FROM node:24-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
COPY packages ./packages
COPY scripts/build.mjs ./scripts/build.mjs
RUN npm ci --no-audit --no-fund && npm run build && npm prune --omit=dev

ENV LANES_AUTOSTART=0
ENTRYPOINT ["node", "/app/dist/lanes.cjs", "mcp"]
