# RenOS – Produktionsimage (App-/API-Server + Game-Host in einem Node-Prozess)
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
RUN npm ci --ignore-scripts
COPY . .
RUN npm run build && npm prune --omit=dev --ignore-scripts

FROM node:22-bookworm-slim
ENV NODE_ENV=production \
    RENOS_HOST=0.0.0.0 \
    RENOS_PORT=8787 \
    RENOS_GAME_HOST=0.0.0.0 \
    RENOS_GAME_PORT=8788 \
    RENOS_DATA_DIR=/data \
    RENOS_WEB_DIST=/app/apps/web/dist
WORKDIR /app
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages/shared/package.json packages/shared/
COPY --from=build /app/packages/shared/dist packages/shared/dist
COPY --from=build /app/apps/server/package.json apps/server/
COPY --from=build /app/apps/server/dist apps/server/dist
COPY --from=build /app/apps/web/dist apps/web/dist
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME ["/data"]
EXPOSE 8787 8788
CMD ["node", "--disable-warning=ExperimentalWarning", "apps/server/dist/index.js"]
