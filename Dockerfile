# syntax=docker/dockerfile:1
# NEAR Sentinel — API + dashboard in one image. Read-only service: it never signs or submits transactions.

FROM node:22-slim AS build
WORKDIR /repo
RUN corepack enable
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json .npmrc tsconfig.base.json ./
COPY packages/sdk/package.json packages/sdk/
COPY packages/mcp/package.json packages/mcp/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY examples/agent-demo/package.json examples/agent-demo/
COPY contracts/guard/package.json contracts/guard/
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm --filter @near-sentinel/sdk build \
 && pnpm --filter @near-sentinel/api build \
 && pnpm --filter @near-sentinel/web build \
 && pnpm --filter @near-sentinel/api deploy --prod /out \
 && cp -r apps/web/dist /out/web

FROM node:22-slim AS runtime
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8080 \
    DATA_DIR=/data \
    WEB_DIST=/app/web \
    METRICS_HOST=127.0.0.1
WORKDIR /app
COPY --from=build --chown=node:node /out /app
RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 8080
VOLUME ["/data"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
# exec form: node is PID 1 and receives SIGTERM directly → graceful shutdown in src/server.ts
CMD ["node", "--no-warnings=ExperimentalWarning", "dist/server.js"]
