# Next.js dashboard. Sdílený kód (src/core, src/shared, config) leží mimo web/, proto kontext = kořen repa.
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY web/package.json web/
RUN npm ci
COPY tsconfig.json ./
COPY config config
COPY src/core src/core
COPY src/shared src/shared
COPY web web
# rewrites /api -> gateway se v Next vyhodnocují při buildu
ARG GATEWAY_URL=http://gateway:3001
ENV GATEWAY_URL=$GATEWAY_URL NEXT_TELEMETRY_DISABLED=1
RUN npm run build -w web

FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1
COPY --from=build /app /app
EXPOSE 3000
CMD ["npm", "run", "start", "-w", "web"]
