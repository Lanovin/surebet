# Backend služby (detector, gateway) – TypeScript spouštěný přes tsx.
FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
COPY web/package.json web/
RUN npm ci --include=dev && npm cache clean --force
COPY tsconfig.json ./
COPY config config
COPY db db
COPY src src
CMD ["npx", "tsx", "src/services/gateway/main.ts"]
