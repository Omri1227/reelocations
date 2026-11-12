# Reel Maps — hosted app (Railway). Node 24 runs the TypeScript sources directly (type stripping).
FROM node:24-bookworm-slim
# chromium: headless read of the public Reel caption (INSTAGRAM_PAGE_CAPTION); fonts so pages render; ca-certificates for HTTPS.
RUN apt-get update \
 && apt-get install -y --no-install-recommends chromium fonts-noto-core fonts-noto-cjk ca-certificates \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
# Production deps incl. optional ones (local Whisper); ffmpeg-static downloads its Linux binary in postinstall.
RUN npm ci --omit=dev --foreground-scripts && npm cache clean --force
COPY src ./src
COPY scripts ./scripts
ENV NODE_ENV=production \
    CHROME_PATH=/usr/bin/chromium \
    REEL_MAPS_DATA_DIR=/data \
    HF_HOME=/data/models \
    PORT=8080
EXPOSE 8080
CMD ["node", "src/server.ts"]
