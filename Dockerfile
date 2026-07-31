FROM node:22-bookworm-slim

WORKDIR /app
COPY package.json ./
COPY src ./src
COPY public ./public
COPY scripts ./scripts
RUN mkdir -p /app/data && chown -R node:node /app

USER node
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000 DATABASE_PATH=/app/data/planner.db
EXPOSE 3000
VOLUME ["/app/data"]
CMD ["node", "src/server.mjs"]
