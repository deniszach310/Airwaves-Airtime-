FROM node:24-bookworm-slim
WORKDIR /opt/airwaves
COPY --chown=node:node server/package*.json ./server/
WORKDIR /opt/airwaves/server
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund
COPY --chown=node:node server/src ./src
COPY --chown=node:node server/schema.sql .
COPY --chown=node:node dist ../dist
USER node
ENV NODE_ENV=production BIND_HOST=0.0.0.0
EXPOSE 8787
CMD ["node", "src/index.mjs"]
