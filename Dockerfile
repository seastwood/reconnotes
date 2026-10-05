# ReconNotes server + web app in one image.
#   docker build -t reconnotes .
#   docker run -d -p 8787:8787 -v reconnotes-data:/data -e RECON_TOKEN=... reconnotes

FROM node:22-bookworm-slim AS build
WORKDIR /src
COPY package.json package-lock.json ./
COPY packages/core/package.json packages/core/
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
RUN npm ci --ignore-scripts=false
COPY . .
RUN npm run build

FROM node:22-bookworm-slim
ENV NODE_ENV=production \
    RECON_DATA_DIR=/data \
    RECON_WEB_DIR=/app/web \
    RECON_PORT=8787
WORKDIR /app
# ffmpeg converts recordings for Wyoming (Home Assistant) speech-to-text servers
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg && rm -rf /var/lib/apt/lists/*
# Install only the server's runtime dependencies (core is bundled into dist/).
COPY apps/server/package.json ./package.json
RUN npm pkg delete devDependencies "dependencies.@reconnotes/core" scripts \
 && npm install --omit=dev --no-audit --no-fund \
 && npm cache clean --force
COPY --from=build /src/apps/server/dist ./dist
COPY --from=build /src/apps/web/dist ./web
VOLUME /data
EXPOSE 8787
USER node
CMD ["node", "dist/index.js", "serve"]
