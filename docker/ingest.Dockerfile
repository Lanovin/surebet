# Ingest potřebuje Chromium pro level-5 strategie – oficiální Playwright image (verze = playwright v package.json).
FROM mcr.microsoft.com/playwright:v1.63.0-noble
WORKDIR /app
ENV NODE_ENV=production PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
COPY package.json package-lock.json ./
COPY web/package.json web/
RUN npm ci --include=dev && npm cache clean --force
COPY tsconfig.json ./
COPY config config
COPY db db
COPY src src
COPY fixtures fixtures
CMD ["npx", "tsx", "src/services/ingest/main.ts"]
