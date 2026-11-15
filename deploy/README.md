# Deploying the Missing Works voting API

Deployed on November 15, 2026 at `https://lost-compositions.exe.xyz` using the user-provided VM. The API runs as a hardened systemd service; a daily timer makes consistent local SQLite backups. The instructions below also describe rebuilding the deployment.

The entire public site and JSON API now run at `https://lost-compositions.exe.xyz/`. GitHub is the source repository; `assets/legacy-host.js` redirects old GitHub Pages web links to the VM.

```
browser --HTTPS--> exe.dev proxy --> nginx :8000
                                      |-- /api/ --> node 127.0.0.1:3000 --> SQLite
                                      `-- public files in /var/www/missing-works/current
```

**HTTPS is required.** A page served over HTTPS cannot call a plain `http://` API (mixed content), so `config.json`'s `apiBaseUrl` must be an `https://` origin. exe.dev provides managed HTTPS. On a plain VM, use Caddy instead (`Caddyfile.example`).

## Files

| File | Install as |
|---|---|
| `missing-works-api.service` | `/etc/systemd/system/missing-works-api.service` |
| `api.env.example` | `/etc/missing-works/api.env` (root:missingworks, 0640) |
| `missing-works-admin` | `/usr/local/bin/missing-works-admin` (0755) |
| `backup.sh` | `/usr/local/bin/missing-works-backup` (0755) |
| `missing-works-backup.service`, `.timer` | `/etc/systemd/system/` |
| `nginx-exe.conf` | `/etc/nginx/sites-available/missing-works` (exe.dev) |
| `Caddyfile.example` | optional, non-exe.dev hosts only |

## 1. User, Node and code

```sh
sudo useradd --system --home-dir /nonexistent --shell /usr/sbin/nologin missingworks   # already done on the VM
node --version   # must be v24 or later (node:sqlite DatabaseSync)
sudo mkdir -p /opt/missing-works /var/backups/missing-works
sudo install -d -m 0750 -o root -g missingworks /etc/missing-works
# Copy only: server/ data/catalog.json deploy/  (no var/, .git/, tests or databases)
sudo rsync -a --delete server data deploy /opt/missing-works/   # from a checkout
sudo chown -R root:root /opt/missing-works        # code is read-only to the service
sudo chown missingworks:missingworks /var/backups/missing-works && sudo chmod 0700 /var/backups/missing-works
sudo install -m 0640 -o root -g missingworks deploy/api.env.example /etc/missing-works/api.env
sudo install -m 0755 deploy/missing-works-admin /usr/local/bin/missing-works-admin
sudo install -m 0755 deploy/backup.sh /usr/local/bin/missing-works-backup
```

Node 24.22.3 is installed at `/usr/local/bin/node` on the VM. If that path changes, edit `ExecStart` and the two scripts.

## 2. Service

```sh
sudo install -m 0644 deploy/missing-works-api.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now missing-works-api
curl -s http://127.0.0.1:3000/api/health            # {"ok":true}
```

The service runs as `missingworks`; only `/var/lib/missing-works` is writable (`StateDirectory`, mode 0700). The first start creates and seeds the database (144 open requests plus the completed Beethoven quartet round). Restarts never reseed, reset statuses or erase votes. SIGTERM shuts it down gracefully.

## 3. Reverse proxy and HTTPS

### exe.dev (current deployment)

```sh
sudo apt-get install -y nginx
sudo install -m 0644 deploy/nginx-exe.conf /etc/nginx/sites-available/missing-works
sudo ln -s /etc/nginx/sites-available/missing-works /etc/nginx/sites-enabled/
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t && sudo systemctl reload nginx
```

Then point the exe.dev HTTPS proxy at port 8000 and make that web port public (SSH and alternate ports remain private):

```sh
ssh exe.dev share port lost-compositions 8000
ssh exe.dev share set-public lost-compositions
```

Only `/api/` is proxied to Node. nginx serves the website from a separate, curated public release directory. No application access logs or request-level nginx error logs are retained. exe.dev itself may retain infrastructure logs under its own policy.

### Publish the website

`deploy/public-files.txt` is the explicit allowlist. Update it when adding new public scores, notebooks, or assets. It excludes all backend code, tests, raw logs, credentials and databases.

```sh
# From the source checkout:
tar -czf /tmp/missing-works-public.tgz -T deploy/public-files.txt
scp /tmp/missing-works-public.tgz lost-compositions.exe.xyz:/tmp/
ssh lost-compositions.exe.xyz
release=$(date -u +%Y%m%dT%H%M%SZ)
sudo install -d -m 0755 /var/www/missing-works/releases/$release
sudo tar -xzf /tmp/missing-works-public.tgz -C /var/www/missing-works/releases/$release
sudo chown -R root:root /var/www/missing-works/releases/$release
sudo find /var/www/missing-works/releases/$release -type d -exec chmod 755 {} +
sudo find /var/www/missing-works/releases/$release -type f -exec chmod 644 {} +
sudo ln -s /var/www/missing-works/releases/$release /var/www/missing-works/current.new
sudo mv -Tf /var/www/missing-works/current.new /var/www/missing-works/current
```

The symlink swap is atomic. Keep the prior release for rollback; switch the symlink back if a new release fails. Updating public files does not touch the vote database.

nginx proxies `/api/*` and serves the curated static website from `/var/www/missing-works/current`; unknown paths return 404. It keeps no access log. Production never sets `SERVE_STATIC`, so Node itself serves no files.

The exe.dev proxy appends the real client as the **last** `X-Forwarded-For` entry. nginx passes it through unchanged, and the API (`TRUST_PROXY=true`, loopback peer) uses that rightmost entry for rate limiting. Earlier entries are client-supplied and ignored. If port 8000 were reachable without going through exe.dev, a client could forge that header. The global write cap (`GLOBAL_RATE_LIMIT_PER_MINUTE`) would still apply.

### Plain VM with Caddy (alternative)

Replace the **placeholder hostname `api.example.com`** in `Caddyfile.example`. Point DNS at the VM and install it as `/etc/caddy/Caddyfile`. Caddy obtains certificates automatically on ports 80/443. Keep `TRUST_PROXY=true`.

## 4. Firewall

On a conventional VM, allow inbound 22, 80 and 443 only. The API listens on 127.0.0.1:3000 and is never exposed directly. Do not apply a generic firewall rule set blindly on exe.dev: its managed proxy reaches the VM over private networking.

```sh
sudo ufw default deny incoming
sudo ufw allow 22/tcp && sudo ufw allow 80/tcp && sudo ufw allow 443/tcp
sudo ufw enable
```

On exe.dev, check how the proxy reaches port 8000. If that traffic passes through the VM firewall, allow 8000 **only** from the proxy's source. This VM has a private `10.42.0.0/16` address, not a directly routed public address. External plain-HTTP probes to ports 3000/8000 were rejected by the HTTPS edge, and HTTPS access to the alternate port 3000 required exe.dev login. Node itself binds only loopback. Repeat these checks if the network or hosting arrangement changes.

## 5. Production checks

```sh
API=https://<api-host>
curl -s $API/api/health
curl -si $API/api/requests -H 'Origin: https://akrentsel.github.io' | grep -i -E '^(access-control|vary)'
curl -si $API/api/requests -H 'Origin: https://evil.example' | head -1        # 403
```

Set `config.json` → `{"apiBaseUrl": "https://<api-host>"}` in the public site only after these pass.

## 6. Administration (SSH only; there is no web admin)

```sh
sudo -u missingworks missing-works-admin queue            # or: queue --json
sudo -u missingworks missing-works-admin start <composer:form:round>
sudo -u missingworks missing-works-admin reopen <composer:form:round>
# after the new work is published in data/catalog.json with the same composer/form/round and copied to /opt:
sudo -u missingworks missing-works-admin complete <composer:form:round> <workId>
```

`complete` keeps the votes and opens round N+1. Before publishing the new work, add it to `catalog.json` with `"round": N` and deploy that file to the VM.

## Live composition drafts

Draft history is stored under `DRAFT_ROOT=/var/lib/missing-works/drafts`, not inside a public website release. `GET /api/drafts` and the per-work/revision read routes expose only validated metadata and ABC snapshots. The same nginx `/api/` proxy already covers them; do not add a filesystem alias for the private draft root.

```sh
sudo install -d -m 0700 -o missingworks -g missingworks /var/lib/missing-works/drafts
sudo install -m 0755 deploy/missing-works-draft /usr/local/bin/missing-works-draft
# Ensure the current server/ code (including vendor parser/license files) is installed.
sudo systemctl restart missing-works-api
curl -fsS https://lost-compositions.exe.xyz/api/drafts
```

The composing agent uses `node tools/publish-draft.mjs --manifest path.json --message '…'` from the source checkout. The helper sends JSON on SSH stdin to the owner-only wrapper; there is no public upload API. See `docs/live-drafts.md`. A successful website release never overwrites or removes this history.

## 7. Backups

```sh
sudo install -m 0644 deploy/missing-works-backup.service deploy/missing-works-backup.timer /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now missing-works-backup.timer
sudo systemctl start missing-works-backup && ls -l /var/backups/missing-works
```

Each run writes `votes-YYYYMMDDTHHMMSSZ.sqlite` using `VACUUM INTO`. That gives a consistent copy while the server keeps running, and the script runs an integrity check and never overwrites an existing file. Copies are kept for `RETENTION_DAYS` (30 by default), and the newest is never deleted. Backups on the same VM do not survive loss of the VM, so copy them off-host from time to time (for example `scp` to your machine). They contain only request statuses and SHA-256 hashes of browser tokens: no IPs, names or raw tokens.

Restore:

```sh
sudo systemctl stop missing-works-api
sudo -u missingworks cp /var/backups/missing-works/votes-<stamp>.sqlite /var/lib/missing-works/votes.sqlite.new
sudo -u missingworks sh -c 'cd /var/lib/missing-works && rm -f votes.sqlite-wal votes.sqlite-shm && mv votes.sqlite.new votes.sqlite'
sudo systemctl start missing-works-api
```

## Privacy and limits

- The server stores only a SHA-256 hash of each browser's random UUID. It does not persist or log IPs, raw tokens, request bodies or headers. Rate-limit state is in memory and bounded.
- Anonymous tokens are best-effort deduplication, **not authentication**. Clearing storage or scripting new UUIDs creates "new voters", limited only by per-IP (30/min default) and global write caps.
- Origin and Content-Type checks reduce cross-site browser abuse. They are not authentication, since non-browser clients can send any header.
