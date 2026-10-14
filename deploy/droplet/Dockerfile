FROM node:22-bookworm-slim AS web-build
WORKDIR /src/web
COPY web/package*.json ./
RUN npm ci
COPY web/ ./
RUN HUB_HOSTED_BUILD=1 VITE_API_BASE= env -u VITE_API_SECRET npm run build

FROM node:22-bookworm-slim AS server-deps
WORKDIR /src/server
COPY server/package*.json ./
RUN npm ci --omit=dev

FROM python:3.13-slim-bookworm
ENV NODE_ENV=production PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends libstdc++6 ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*
COPY --from=web-build /usr/local/bin/node /usr/local/bin/node
COPY --from=server-deps /src/server/node_modules /app/server/node_modules
COPY server/ /app/server/
COPY ingest/requirements.txt /app/ingest/requirements.txt
RUN python3.13 -m pip install --no-cache-dir -r /app/ingest/requirements.txt
COPY ingest/ /app/ingest/
COPY db/ /app/db/
COPY --from=web-build /src/web/dist /app/web/dist
USER 65532:65532
CMD ["node", "server/server.js"]
