# Local, throwaway NEAR sandbox (neard 2.14.0, protocol 88 — same as testnet in Nov 2026).
# Used only by `pnpm --filter @near-sentinel/guard test:sandbox`. Fresh chain on every start.
FROM node:24-trixie-slim
RUN apt-get update -qq && apt-get install -y -qq --no-install-recommends ca-certificates curl && rm -rf /var/lib/apt/lists/*
WORKDIR /opt/sandbox
RUN npm init -y >/dev/null && npm install --silent near-sandbox@0.3.5 && npx near-sandbox --version
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh
EXPOSE 3030
HEALTHCHECK --interval=3s CMD curl -fs http://127.0.0.1:3030/status >/dev/null || exit 1
ENTRYPOINT ["/entrypoint.sh"]
