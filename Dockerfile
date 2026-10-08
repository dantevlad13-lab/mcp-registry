# Образ реестра MCP-подключений. Зависимостей нет, поэтому сборка — простое копирование исходников.
FROM node:22-alpine

WORKDIR /app
COPY package.json server.js connections.example.json ./
COPY lib ./lib
COPY scripts ./scripts
COPY public ./public

# Данные (список подключений и пользователи) живут в томе, а не в образе.
RUN mkdir -p /data && chown node:node /data
VOLUME /data

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8787 \
    DATA_DIR=/data

USER node
EXPOSE 8787

# По состоянию unhealthy контейнер перезапускает autoheal.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1:8787/health || exit 1

CMD ["node", "server.js"]
