# Installing `kira-status`

A status page for the kiramyao services: uptime over a 90-day window, incident
history, and the data-guardian figures. Zero runtime dependencies — Node plus
`node:sqlite`, no build step, no `node_modules` on the box.

This is written to be additive to the box that already runs the comment service,
following the same layout and conventions. Read `../equal-comments/deploy/INSTALL.md`
first if you have not set up that one; the two are deliberately alike.

---

## 1. Prerequisites

- **Node 22.5 or newer.** `node:sqlite` is what this service stores into, and it is
  only present from 22.5. Check with `node --version`.
- **A reverse proxy** already terminating TLS for the box (Caddy, per
  `Caddyfile` in this directory).
- **A DNS record for `status.kiramyao.com`.** This one is easy to forget: the Caddy
  block cannot serve a hostname with no record, and the symptom is a TLS failure
  rather than anything mentioning DNS. Orange-clouded, like `api` and `hrt`.
- **A certificate that covers the hostname.** The box uses one Cloudflare Origin
  certificate, and since 2026-09-17 it is the **wildcard pair for `*.kiramyao.com`
  plus `kiramyao.com`** at `/etc/caddy/certs/origin.pem`. A new subdomain therefore
  needs no certificate work — but if the cert on the box is still an older one
  listing hosts individually, `status` must be added to its SAN or the page fails
  with a Cloudflare 525/526 rather than a DNS error. To swap in a new pair:

  ```bash
  sudo /usr/local/bin/install-origin-cert.sh <new-cert.pem> <new-key.pem>
  ```

  It backs up the current pair, checks the cert and key match, validates, and
  reloads Caddy.

## 2. Create the service user and directory

```bash
sudo useradd --system --home /srv/kira-status --shell /usr/sbin/nologin status
sudo mkdir -p /srv/kira-status/data
sudo chown -R status:status /srv/kira-status
```

`data/` is the only writable path the unit grants, so it must exist before the
service starts — SQLite creates the *file*, not the directory.

## 3. Copy the code

Copy everything except `data/`, `.env` and `node_modules/`:

```bash
sudo rsync -a --exclude data --exclude .env --exclude node_modules \
  ./ /srv/kira-status/
sudo chown -R status:status /srv/kira-status
```

## 4. Configure

```bash
sudo -u status cp /srv/kira-status/.env.example /srv/kira-status/.env
sudo -u status chmod 600 /srv/kira-status/.env
sudo -u status nano /srv/kira-status/.env
```

The values that matter:

| variable | why |
|---|---|
| `PUBLIC_ORIGIN` | `https://status.kiramyao.com` |
| `BOCE_ENABLED` | leave `false` for the first run; see step 7 |
| `BOCE_API_KEY` | the paid credential — only needed when `BOCE_ENABLED=true` |
| `HRT_STATS_URL` | `https://api.kiramyao.com/hrt/stats` |
| `COMMENTS_STATS_URL` | `https://api.kiramyao.com/comments/stats` |

**`COMMENTS_STATS_URL` is live as of 2026-09-17.** The comment service now serves
`GET /comments/stats` returning `{ users, comments }` (counts only, no identifiers),
so both comment tiles show real numbers. The route lives in
`equal-comments/server.mjs` *and* `equal-comments/lib/db.mjs` (`publicCounts()`) —
deploy both, or the handler throws. If the two tiles ever read "—" instead, that
endpoint is down; the page renders correctly with dashes, which is the designed
behaviour rather than a fault.

## 5. Verify before installing the unit

Run one probe round by hand. This is the fastest way to tell a bad config from a
network problem, and it touches the same database the service will:

```bash
cd /srv/kira-status
sudo -u status node bin/probe-once.mjs
```

Every target should print `ok`. A `FAIL` here is a real finding — most often a
target URL that needs no trailing slash, or the box being unable to reach
`api.kiramyao.com` at all.

Then start it in the foreground and look at the page:

```bash
sudo -u status node server.mjs
curl -s localhost:8789/status/health
curl -s localhost:8789/status/ | head -20
```

## 6. Install the unit and the proxy block

```bash
sudo cp deploy/kira-status.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now kira-status
systemctl status kira-status
journalctl -u kira-status -n 40 --no-pager
```

`kira-status.service` already contains the hardening: `ProtectSystem=strict` with
`ReadWritePaths=/srv/kira-status/data` as the only writable path, no capabilities,
loopback-only binding.

Add the Caddy block. This box keeps **one flat `/etc/caddy/Caddyfile`** (there is no
`sites/` directory), so append rather than drop in a fragment:

```bash
sudo cp -a /etc/caddy/Caddyfile /etc/caddy/Caddyfile.bak-$(date +%Y%m%d-%H%M%S)
sudo tee -a /etc/caddy/Caddyfile < deploy/Caddyfile   # or the uncommented half of it
sudo caddy fmt --overwrite /etc/caddy/Caddyfile
sudo caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
sudo systemctl reload caddy
```

The block is the "Option A" half of `deploy/Caddyfile`; the file as committed also
carries a commented-out Option B, so copy only the live half if you append verbatim.

## 7. Turn on the CN probe

Only after everything above is working, and only once the calibration in
`BOCE.md` has been re-read — the cost is per node and the defaults are chosen to be
about **1.8 CNY/month at ~30 nodes once daily**.

```bash
# In .env:
BOCE_ENABLED=true
```

Then verify it once, by hand, so the first paid call is one you are watching:

```bash
sudo -u status node bin/probe-once.mjs --boce
```

A successful run prints `{"ran":true,"ok":30,...}`. If it prints `ran:false`, the
reason is in the string — and the page will show the CN row as "无数据" rather than
inventing a green, which is the designed degradation.

## 8. What "working" looks like

```bash
curl -s https://status.kiramyao.com/status/health
#  -> {"ok":true,"service":"status","newest_probe_age_ms":<small>,"boce_enabled":...}

curl -s https://status.kiramyao.com/status/history.json | head -30
#  -> 90 days of cells per component

# Outside the mount must not be served.
curl -s -o /dev/null -w '%{http_code}\n' https://status.kiramyao.com/health   # 404
```

Load the page and read it, rather than trusting the exit codes: the banner should
state a verdict, each component should have a strip with visible cells, and the
guardian tiles should show numbers or "—" — never a zero standing in for unknown.

## 9. Operating notes

- **The page never triggers a probe.** It renders from what the loop already wrote.
  If you ever wire a probe to a request, page traffic becomes the boce bill. Nothing
  in the code prevents that; only this note and the comment in `server.mjs` do.
- **History is 90 days** and is pruned daily. The CN samples are the only rows here
  that cost money, so do not shorten the window without meaning to discard them.
- **A restart does not reset uptime.** Availability is computed from stored probes,
  not from a counter in memory — deployed with `Restart=always`, a transient crash
  would otherwise wipe the number the page exists to report.
- **To change the cadence**, set `PROBE_INTERVAL_MINUTES`. The staleness and incident
  bounds are expressed in multiples of it, so they follow automatically.
- **No email subscriptions.** v1 publishes `/history.json` and an incident list
  instead; anyone who wants to watch the numbers can poll it.
