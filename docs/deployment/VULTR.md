# Deploying NEAR Sentinel on a Vultr VPS

This guide puts NEAR Sentinel on one small Ubuntu server with automatic HTTPS. You end up with:

- **Caddy 2** on ports 80/443. It gets and renews the TLS certificate and adds security headers.
- **The Sentinel app** (API + dashboard + `/docs` + live event stream) on a private Docker network. It is never published directly.
- A firewall that allows only SSH, HTTP and HTTPS.

Sentinel is **read-only**: it never signs or submits transactions. **No private keys ever go on the server.** `GUARD_CONTRACT_ID` is a public account ID, like an address.

All files are in [`deploy/vultr/`](../../deploy/vultr/):

| File | What it is |
|---|---|
| `docker-compose.prod.yml` | App + Caddy, healthcheck, named volumes, hardening |
| `Caddyfile` | HTTPS, SSE-safe proxying, security headers, the temporary "no domain" fallback |
| `env.production.example` | Every setting, with placeholders. Copy it to `.env.production`, which git ignores |
| `setup-server.sh` | One-time server setup, run as root: Docker, deploy user, firewall, fail2ban, swap, SSH hardening |
| `deploy.sh` | Run as the deploy user: `deploy`, `update`, `rollback`, `status`, `logs`, `down` |
| `backup.sh` | Consistent online backup of the SQLite database to a `.tar.gz` |

Placeholders used below: `<server-ip>` (your instance's IPv4), `<your-domain>` (e.g. `sentinel.example.com`), `<REPO_URL>` (the repository's clone URL).

---

## 1. Choose a plan

- **Type:** Cloud Compute (shared CPU) is enough.
- **Size:** **2 GB RAM / 1 vCPU** is the comfortable choice. A **1 GB** plan also works, because the setup script adds a 2 GB swap file. The first build is just slower.
  - Measured: building the image (`pnpm install` + TypeScript + Vite build) peaked at about **0.5 GiB** in the build container. The sampling interval was about 2 s, so short spikes may be higher. The OS, Docker and the running app need a few hundred MB on top of that.
  - Running the app on its own needs much less. RAM mainly matters for the build.
- **Disk:** the smallest offered (25 GB or more) is plenty. Images and the database are small.
- **Region:** pick the location closest to you or to your judges/users. Any region works.
- **Image:** **Ubuntu 24.04 LTS x64**.
- **IPv6:** optional. If you enable it, see the AAAA note in step 4.

## 2. Add your SSH key in the Vultr panel

1. If you don't have a key yet, create one **on your own computer** with `ssh-keygen -t ed25519`. The private key stays on your computer.
2. Vultr panel → **Account → SSH Keys → Add SSH Key**. Paste the **public** key (the `.pub` file).
3. When you deploy the instance, tick that SSH key. Vultr puts it in `/root/.ssh/authorized_keys`, and `setup-server.sh` copies it to the deploy user.

## 3. Create a Vultr firewall group (defence in depth)

The server also runs UFW. A Vultr firewall group blocks traffic before it even reaches the VM.

1. Vultr panel → **Network → Firewall → Add Firewall Group**.
2. Add **IPv4** inbound rules:
   - SSH, TCP 22. Ideally restrict the source to your own IP. Otherwise allow anywhere.
   - HTTP, TCP 80. Needed for certificate issuance and the HTTPS redirect.
   - HTTPS, TCP 443.
   - Optional: UDP 443, for HTTP/3.
3. If you enabled IPv6, add the same rules under **IPv6**.
4. **Linked Instances** → link your instance. Everything not listed is dropped.

## 4. (Optional) Point a domain at the server

At your DNS provider, create an **A record**: `<your-domain>` → `<server-ip>`. Wait until `nslookup <your-domain>` returns `<server-ip>`.

- If there is an **AAAA** record for the same name, it must point at this server's IPv6, or be removed. Otherwise certificate issuance can fail.
- **No domain? Use a free `sslip.io` name.** `<ip-with-dashes>.sslip.io` (for example `65-20-1-2.sslip.io`) already resolves to that IP, so Caddy gets a real Let's Encrypt certificate with nothing to buy or configure. The public demo uses this.
- Plain HTTP on the IP is also possible for a quick check. See step 7.

## 5. Run the server setup script (as root, once)

```bash
ssh root@<server-ip>
git clone <REPO_URL> /root/near-sentinel-setup        # or scp deploy/vultr/setup-server.sh to the server
bash /root/near-sentinel-setup/deploy/vultr/setup-server.sh
```

The script is idempotent: re-running it is safe. It prints each step:

1. `apt update` + `upgrade`
2. Docker Engine + Compose plugin from Docker's official apt repository
3. User `sentinel` in the `docker` group, with root's SSH key copied to it
4. UFW allowing only 22/tcp, 80/tcp, 443/tcp, 443/udp
5. Unattended security upgrades (no automatic reboots)
6. fail2ban for sshd: 5 failures in 10 minutes means a 1-hour ban
7. A 2 GB swap file, if the server has none. `SWAP_SIZE=1G` changes the size; `SWAP_SIZE=0` skips it
8. **SSH password login disabled, but only if `sentinel` has an SSH key.** Otherwise it prints a warning and leaves SSH alone, so you can't lock yourself out

**Before closing the root session**, open a second terminal and check that `ssh sentinel@<server-ip>` works. If the script says a reboot is required, run `reboot` once that works.

## 6. Clone the repo as the deploy user

```bash
ssh sentinel@<server-ip>
git clone <REPO_URL> near-sentinel
cd near-sentinel
```

If the repository is private, add a read-only **deploy key** for the server in the repository settings, or clone over HTTPS with a read-only token.

**Low-cost alternative for 1 GB plans: build on your computer, copy only the image.** The server then never builds or needs the source code or GitHub access:

```bash
# on your computer, in the repo
docker build -t near-sentinel:prod .
docker save near-sentinel:prod | gzip -1 | ssh sentinel@<server-ip> 'gunzip | docker load'
ssh sentinel@<server-ip> 'mkdir -p ~/near-sentinel/deploy/vultr'
scp deploy/vultr/docker-compose.prod.yml deploy/vultr/Caddyfile sentinel@<server-ip>:near-sentinel/deploy/vultr/
# then create ~/near-sentinel/deploy/vultr/.env.production on the server (step 7) and start it:
ssh sentinel@<server-ip> 'cd ~/near-sentinel && docker compose -f deploy/vultr/docker-compose.prod.yml --env-file deploy/vultr/.env.production up -d --no-build'
```

To update, repeat the build, `docker save` and `up -d --no-build` lines. This is how the public demo was deployed (1 vCPU / 1 GB, about $5/month).

## 7. Fill in `.env.production`

```bash
cp deploy/vultr/env.production.example deploy/vultr/.env.production
nano deploy/vultr/.env.production
```

Set at least these:

| Variable | Value |
|---|---|
| `SENTINEL_DOMAIN` | `<your-domain>`, or `:80` for the **temporary** no-domain fallback |
| `NEAR_NETWORK` | `testnet` (default) |
| `GUARD_CONTRACT_ID` | optional, a public account ID such as `guard.<your-account>.testnet` |
| `API_KEYS_SHA256` | optional. Only the **SHA-256 digest** of a key, never the key. Leave it empty to keep protected endpoints disabled |

- `HOST`, `PORT`, `DATA_DIR`, `TRUST_PROXY=1`, `METRICS_HOST` and `NODE_ENV` are fixed by the compose file. You don't set them.
- `TRUST_PROXY=1` is safe here because the app is reachable only through Caddy. Caddy replaces any client-sent `X-Forwarded-For` with the real client IP, so rate limits can't be spoofed.

> **No-domain fallback (temporary).** With `SENTINEL_DOMAIN=:80`, Caddy serves **plain, unencrypted HTTP** at `http://<server-ip>/`. Use it only to check that things work. Set a real domain before sharing the URL, then run `deploy.sh` again.

## 8. Deploy

```bash
bash deploy/vultr/deploy.sh
```

The script:

1. Checks that `.env.production` exists and has no example values or anything that looks like a private key
2. Runs `docker compose -f deploy/vultr/docker-compose.prod.yml --env-file deploy/vultr/.env.production up -d --build`
3. Waits for the app's healthcheck
4. Checks `/health` through Caddy, then prints the status and URL

The first build takes a few minutes. On a 1 GB plan it takes longer and uses swap. The first certificate can take up to a minute after the containers are up.

## 9. Verify

```bash
curl -s https://<your-domain>/health          # {"status":"ok",...}
curl -s https://<your-domain>/ready           # "ready":true once a provider probe has succeeded
curl -sN https://<your-domain>/api/v1/events  # prints ": connected" right away, then "event: health" (Ctrl+C to stop)
curl -sI https://<your-domain>/ | grep -iE 'strict-transport|x-frame|content-security'
```

In a browser:

- `https://<your-domain>/` shows the dashboard. Its live/connected indicator should turn on within a few seconds; that is the SSE stream working through Caddy.
- `https://<your-domain>/docs` shows the OpenAPI docs.
- The padlock shows a valid certificate.

In fallback mode, use `http://<server-ip>/...` instead.

Prometheus metrics are **not** public. They listen on `127.0.0.1:9464` inside the container. To read them:

```bash
docker compose -f deploy/vultr/docker-compose.prod.yml --env-file deploy/vultr/.env.production exec sentinel \
  node -e "fetch('http://127.0.0.1:9464/metrics').then(r=>r.text()).then(console.log)"
```

## 10. Update, logs, rollback

```bash
bash deploy/vultr/deploy.sh update        # git pull --ff-only on master, rebuild, restart, health check
bash deploy/vultr/deploy.sh status        # containers + health through Caddy
bash deploy/vultr/deploy.sh logs          # follow all logs; `logs caddy` or `logs sentinel` for one service
bash deploy/vultr/deploy.sh rollback      # re-deploy the previously deployed commit (detached HEAD)
bash deploy/vultr/deploy.sh update        # ...and back to the latest main afterwards
bash deploy/vultr/deploy.sh down          # stop containers; data and certificates are kept
```

Deployed commits are recorded in `.git/sentinel-deploy-history`. Running `rollback` twice switches back and forth between the last two deployed commits.

## 11. Backups

```bash
bash deploy/vultr/backup.sh               # -> ~/sentinel-backups/sentinel-YYYYmmdd-HHMMSS.tar.gz
```

- The script uses SQLite `VACUUM INTO` inside the running container, so the copy is consistent while the app is running.
- It never deletes old backups.
- Copy backups off the server with `scp sentinel@<server-ip>:sentinel-backups/*.tar.gz .`
- Vultr's paid automatic backups or snapshots are an alternative.
- For a daily backup, add a cron entry for the `sentinel` user (`crontab -e`):

  ```
  17 3 * * * bash $HOME/near-sentinel/deploy/vultr/backup.sh >/dev/null 2>&1
  ```

**Restore** (replaces the current database):

```bash
cd ~/near-sentinel
DC="docker compose -f deploy/vultr/docker-compose.prod.yml --env-file deploy/vultr/.env.production"
mkdir -p ~/restore && tar -xzf ~/sentinel-backups/sentinel-<stamp>.tar.gz -C ~/restore
$DC stop sentinel
$DC run --rm --no-deps -v ~/restore:/restore:ro --entrypoint sh sentinel \
  -c 'cp /restore/sentinel.db /data/sentinel.db && rm -f /data/sentinel.db-wal /data/sentinel.db-shm'
$DC up -d
```

The data is not critical. Probe samples are kept for 7 days and reports for 30 days. Losing the database only loses history.

## 12. Troubleshooting

**Certificate is not issued** (browser warning, or `deploy.sh status` shows the HTTPS check failing). Run `bash deploy/vultr/deploy.sh logs caddy` and look for `acme` / `challenge` errors. Common causes:

- DNS does not point at `<server-ip>` yet. Check `nslookup <your-domain>`. Propagation can take minutes.
- An AAAA record points elsewhere.
- Port 80 or 443 is blocked. See the next item.
- Let's Encrypt rate limits after many failed attempts. Caddy then falls back to ZeroSSL automatically. Fix the cause and wait.

Don't delete the `caddy-data` volume: it holds the certificates and the ACME account.

**Port 80/443 not reachable.**

- Check the Vultr firewall group (step 3): rules for both 80 and 443 must exist, and the group must be linked to this instance.
- On the server, `sudo ufw status` should list 80/tcp and 443/tcp.
- `docker compose ... ps` should show Caddy publishing `0.0.0.0:80` and `0.0.0.0:443`.
- Some networks block outbound port 80. Test from a phone on mobile data.

**Build killed / out of memory.** Symptoms: `Killed`, exit code 137, or the build hangs.

- Check `swapon --show`. If it's empty, re-run `setup-server.sh` (it adds swap), or resize to a 2 GB plan.
- Alternatively, build on your own computer and copy the image over:

  ```bash
  # on your computer, from the repo root
  docker buildx build --platform linux/amd64 -t near-sentinel:prod --load .
  docker save near-sentinel:prod | gzip | ssh sentinel@<server-ip> 'gunzip | docker load'
  # on the server
  docker compose -f deploy/vultr/docker-compose.prod.yml --env-file deploy/vultr/.env.production up -d --no-build
  ```

**App unhealthy / restarting.** Run `bash deploy/vultr/deploy.sh logs sentinel`. The process refuses to start on invalid configuration and prints which variable is wrong. A typical example is a malformed `GUARD_CONTRACT_ID` or `API_KEYS_SHA256`.

**`/ready` returns 503.** No RPC provider was reachable in the last probe. Check the server's outbound internet access and `RPC_URLS`, if you set it.

**Dashboard shows "offline" / no live updates.** Run `curl -sN https://<your-domain>/api/v1/events`. If that streams but the browser doesn't, check for a browser extension or a corporate proxy that buffers. The Caddyfile already disables buffering and compression for this path.

**Rate-limited (429) unexpectedly.** Each client IP gets `RATE_LIMIT_MAX` requests per minute and `INSPECT_RATE_LIMIT_MAX` inspections per minute. If you put a CDN in front of Caddy, every request appears to come from the CDN. Configure `trusted_proxies` in the Caddyfile for that CDN.

## 13. Cost

Vultr bills hourly up to a monthly cap. The plans above are among the cheapest offered, typically a few dollars to around ten dollars a month. Check the current price in the panel.

- Optional extras cost more: automatic backups, snapshots, extra IPs.
- **A stopped instance is still billed.** Only destroying it stops the charges.
- Bandwidth for this app is tiny compared with the included transfer.

## 14. Take it down after judging

1. Optional: run `bash deploy/vultr/backup.sh` and `scp` the tarball to your computer.
2. Run `bash deploy/vultr/deploy.sh down` to stop the containers.
3. In the Vultr panel: **Instance → Settings → Destroy** (or the trash icon). This deletes the server and its disks, and billing stops.
4. Delete any snapshots or backups you created in the panel, and the firewall group if you no longer need it.
5. Remove the DNS A/AAAA record for `<your-domain>`.
