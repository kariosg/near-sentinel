# Deployment

## Docker Compose (VPS or any Docker host)

```bash
cp .env.example .env            # optional; set API_KEYS_SHA256 to enable protected endpoints
docker compose up -d --build
curl -s http://127.0.0.1:8080/ready
```

- **Port:** 8080 is published on **127.0.0.1 only**. To serve publicly, put a TLS reverse proxy (Caddy, nginx, Traefik) in front, then set `TRUST_PROXY=1` so rate limits use the real client IP.
- **Data:** SQLite lives in the named volume `sentinel-data` at `/data/sentinel.db`.
- **Health:** the image has a `HEALTHCHECK` on `/health`. Use `/ready` for load-balancer readiness.
- **Shutdown:** Node runs as PID 1 (exec-form `CMD`) and handles SIGTERM: it stops the prober, drains requests, closes SSE and the DB, and exits 0. Verified: `docker compose stop` → exit 0 in ~0.65 s. `stop_grace_period` is 15 s.
- **User:** the container runs as the non-root `node` user.
- **Metrics:** Prometheus listens on `127.0.0.1:9464` **inside** the container and is not published. To scrape it, run Prometheus in the same network namespace, or set `METRICS_HOST=0.0.0.0` and publish the port only on a private network.

## Without Docker

```bash
pnpm install --frozen-lockfile && pnpm build
cp .env.example .env              # optional
pnpm start                        # loads ../../.env if present (node --env-file-if-exists)
```

Run it under a process manager (systemd, pm2) that sends SIGTERM on stop.

## Backups

SQLite in WAL mode supports online backups:

```bash
# Docker
docker compose exec sentinel node -e "const {DatabaseSync}=require('node:sqlite');const d=new DatabaseSync('/data/sentinel.db');d.exec(\"VACUUM INTO '/data/backup-$(date +%F).db'\")"
docker compose cp sentinel:/data/backup-$(date +%F).db ./
```

Or stop the container and copy the volume. Retention is automatic: samples are kept 7 days, reports 30 days.

## Configuration

Every variable is documented in [`.env.example`](../../.env.example) and validated at boot. The process refuses to start on invalid values: bad port, non-hex key digests, unknown network.

## Vultr VPS (step by step)

For a hardened single-server setup with Caddy and automatic HTTPS, see [VULTR.md](VULTR.md) (files in [`deploy/vultr/`](../../deploy/vultr/)).
