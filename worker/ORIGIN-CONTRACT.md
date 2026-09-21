# Origin contract for the status probes -- PINNED

Implement exactly this. Every path, parameter name, header name and failure rule below is the
value the Worker actually uses; nothing here has to be guessed. The enforcing code is
`worker/src/probe.mjs` (`probeFresh`), and the live check is
`node worker/verify-freshness.mjs`.

## 1. The request the Worker makes

* Method: **GET**.
* URL: the configured target with **one query parameter added**:
  `?nonce=<32 lowercase hex>`.
  Implementation is `const u = new URL(target); u.searchParams.set('nonce', nonce)` -- it
  preserves any other query parameters and overwrites an existing `nonce`. The value comes
  from `crypto.randomUUID()` with hyphens removed (32 hex characters), fresh for every probe.
* Request headers:
  * `User-Agent: KiraStatus/1.0 (+https://status.kiramyao.com)`
  * `Cache-Control: no-cache`
  * `Pragma: no-cache`
* Worker-runtime only (cannot be sent by curl/Node): `cf: { cacheTtl: 0, cacheEverything: false }`.

## 2. The exact targets

| component | target URL | wrangler var | echo required |
|---|---|---|---|
| comments_api | `https://api.kiramyao.com/comments/health` | `COMMENTS_HEALTH_URL` | **yes** |
| hrt_api | `https://api.kiramyao.com/hrt/health` | `HRT_HEALTH_URL` | **yes** |
| hrt_mcp | `https://api.kiramyao.com/hrt/mcp/health` | `HRT_MCP_HEALTH_URL` | **yes** |
| hrt_web | `https://hrt.kiramyao.com/.well-known/status-probe.txt` | `HRT_WEB_URL` | no |
| site_overseas | `https://kiramyao.com/.well-known/status-probe.txt` | `SITE_URL` | no |

The two static files must exist and contain a tiny body (for example `ok\n`). The body is
not parsed; only the status line and headers matter. A dedicated path is used so the real
site's caching is not disabled at `/`.

## 3. The response every target must give

1. Status **2xx or 3xx**.
2. A non-reusable `Cache-Control`:
   * required: `no-store, no-cache, must-revalidate`
   * also accepted: `public, max-age=0, must-revalidate` (what Cloudflare Pages already
     sends). `max-age=0` forbids serving a stored copy without contacting the origin.
   * rejected: `public, max-age=N` with N > 0, and any response with no `Cache-Control`.
3. `Pragma: no-cache`. Requested; recorded by the probe but **not** the gate (legacy header).
4. **Not** `cf-cache-status: HIT`, `STALE` or `UPDATING`, and **no** `Age > 0`.

## 4. The nonce echo (the three API endpoints)

The response must return the exact `nonce` value it received, either:

* response header `X-Probe-Nonce: <nonce>` (preferred), **or**
* anywhere in the response body (for example the JSON field `"nonce"`).

A missing or different value fails the probe with
`nonce not echoed: the response was not generated for this request`.

## 5. The exact pass/fail judgement

Checked in this order; the first failure is the recorded reason:

| # | condition | failure text |
|---|---|---|
| 1 | status not 2xx/3xx | `HTTP <status>` |
| 2 | `cf-cache-status` is HIT/STALE/UPDATING | `cached copy answered (cf-cache-status: ...)` |
| 3 | `Age > 0` | `cached copy answered (Age: Ns)` |
| 4 | `Cache-Control` not non-reusable | `origin did not declare a non-reusable response (Cache-Control: ...)` |
| 5 | echo required and not returned | `nonce not echoed: ...` |

`ok: true` only when all applicable checks pass. `worker/test/probe.test.mjs` pins each row.

## 6. Node patch (comments_api, hrt_api, hrt_mcp)

Three lines at the end of each health handler, before the response is written:

```js
const nonce = new URL(req.url, 'http://localhost').searchParams.get('nonce')
res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate')
res.setHeader('Pragma', 'no-cache')
if (nonce) res.setHeader('X-Probe-Nonce', nonce)
// for a JSON body, also include it:
res.end(JSON.stringify({ ok: true, ...(nonce ? { nonce } : {}) }))
```

(Express equivalents: `req.query.nonce` and `res.set(...)`. The header alone is enough.)

## 7. Caddy patch for hrt.kiramyao.com (static)

Publish `/.well-known/status-probe.txt` containing `ok` and add to the
`hrt.kiramyao.com` site block:

```caddy
@status_probe path /.well-known/status-probe.txt
header @status_probe Cache-Control "no-store, no-cache, must-revalidate"
header @status_probe Pragma "no-cache"
```

A static file cannot echo a nonce; that limitation is stated in `worker/README.md` and is
expected.

## 8. Cloudflare Pages patch for kiramyao.com (static)

Publish `/.well-known/status-probe.txt` containing `ok` and add a Pages `_headers`
entry:

```
/.well-known/status-probe.txt
  Cache-Control: no-store, no-cache, must-revalidate
  Pragma: no-cache
```

Pages already sends `public, max-age=0, must-revalidate`, which the Worker accepts, so this
is optional reinforcement rather than a requirement. No nonce echo is possible.

## 9. Verify after deploying the patch

One command, against the real hosts:

```bash
node worker/verify-freshness.mjs
```

It sends two probes per target (the nonces must differ), prints the observed `Cache-Control`,
`cf-cache-status`, `Age` and whether the nonce came back, and exits non-zero if any layer
fails. To eyeball a single endpoint:

```bash
curl -sS -D - -o /dev/null "https://api.kiramyao.com/comments/health?nonce=abc123"
```

Expect `X-Probe-Nonce: abc123` and `Cache-Control: no-store, no-cache, must-revalidate`.

## 10. The external prober (the Worker cannot probe its own zone)

A Worker subrequest to a hostname in the SAME zone that proxies to a real origin times out
(`timeout after 4000ms`). Measured from D1 with `source = 'local'`, `site_overseas` --
answered by Cloudflare itself -- was the only row that came back, while `hrt_web`,
`hrt_api`, `hrt_mcp` and `comments_api` all timed out. The owner refused a grey-cloud
record (it would publish the origin IP), so the inbound probe has to run outside the zone.
The cron no longer runs a probe round at all; an external prober runs it and reports
through `POST /ingest/probe`.

The prober is sections 1-5, executed from a shell instead of from `probeFresh`. Per
component, per round:

1. Mint a fresh nonce: 32 lowercase hex characters, new for every probe. The query string
   is part of the cache key, so this is what makes the URL unique.
2. Request the target with `?nonce=<nonce>`, asking for no cache with
   `Cache-Control: no-cache` and `Pragma: no-cache`. A shell cannot send the Worker-only
   `cf: { cacheTtl: 0 }`; the unique URL and these headers are the layers it can send.
3. Judge the response in the order of section 5: status 2xx/3xx; not
   `cf-cache-status: HIT|STALE|UPDATING`; no `Age > 0`; a non-reusable `Cache-Control`
   (`no-store`, or `max-age=0`); and, for `hrt_api`, `hrt_mcp` and `comments_api`, the
   exact nonce echoed in `X-Probe-Nonce` or the body. The first failure is the recorded
   `error`; nothing is a pass unless every applicable layer passes.
4. POST the five rows to `POST /ingest/probe` (section 11). Run it every 10 minutes.

### The curl script

`openssl rand -hex 16` mints the nonce; `curl -D` captures the headers and `-w` the status
and elapsed seconds. Every judgement below is the section 5 order.

```bash
#!/usr/bin/env bash
set -euo pipefail

STATUS="https://status.kiramyao.com"
TOKEN="${PROBE_TOKEN:?set PROBE_TOKEN}"
UA="KiraStatus/1.0 (+https://status.kiramyao.com)"

targets=(
  "site_overseas|https://kiramyao.com/.well-known/status-probe.txt"
  "hrt_web|https://hrt.kiramyao.com/.well-known/status-probe.txt"
  "hrt_api|https://api.kiramyao.com/hrt/health"
  "hrt_mcp|https://api.kiramyao.com/hrt/mcp/health"
  "comments_api|https://api.kiramyao.com/comments/health"
)

# The three app endpoints must echo the nonce; the two static ones cannot (section 4).
needs_echo() { case "$1" in hrt_api|hrt_mcp|comments_api) return 0;; *) return 1;; esac; }
json_esc() { printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g'; }
header_value() { grep -i "^$2:" "$1" | head -n1 | tr -d '\r' | sed 's/^[^:]*:[[:space:]]*//'; }

rows="" ; first=1
for entry in "${targets[@]}"; do
  component="${entry%%|*}" ; url="${entry#*|}"
  nonce="$(openssl rand -hex 16)"
  headers="$(mktemp)" ; body="$(mktemp)"

  status=000 ; elapsed=0
  read -r status elapsed < <(curl -sS --max-time 4 -o "$body" -D "$headers" \
    -w '%{http_code} %{time_total}' \
    -H "User-Agent: $UA" -H 'Cache-Control: no-cache' -H 'Pragma: no-cache' \
    "${url}?nonce=${nonce}") || true

  cache_control="$(header_value "$headers" cache-control)"
  cf_cache="$(header_value "$headers" cf-cache-status)"
  age="$(header_value "$headers" age)"
  x_nonce="$(header_value "$headers" x-probe-nonce)"

  status_code=null
  [ "$status" != "000" ] && status_code="$status"

  ok=true ; error=""
  if [ "$status" -lt 200 ] || [ "$status" -ge 400 ]; then
    error="HTTP $status"
  elif printf '%s' "$cf_cache" | grep -Eqi '^(HIT|STALE|UPDATING)$'; then
    error="cached copy answered (cf-cache-status: $cf_cache)"
  elif [ -n "$age" ] && [ "$age" -gt 0 ] 2>/dev/null; then
    error="cached copy answered (Age: ${age}s)"
  elif ! printf '%s' "$cache_control" | grep -Eqi '(^|[[:space:],])no-store([[:space:],]|$)|(^|[[:space:],])max-age[[:space:]]*=[[:space:]]*0([[:space:],]|$)'; then
    error="origin did not declare a non-reusable response (Cache-Control: ${cache_control:-absent})"
  elif needs_echo "$component" && [ "$x_nonce" != "$nonce" ] && ! grep -qF "$nonce" "$body"; then
    error="nonce not echoed: the response was not generated for this request"
  fi
  [ -n "$error" ] && ok=false
  error="${error:0:200}"
  rm -f "$headers" "$body"

  error_json=null
  [ -n "$error" ] && error_json="\"$(json_esc "$error")\""
  latency_ms="$(awk -v t="$elapsed" 'BEGIN { printf "%.1f", t*1000 }')"

  [ "$first" -eq 1 ] || rows="$rows,"
  first=0
  rows="$rows{\"component\":\"$component\",\"ok\":$ok,\"status_code\":$status_code,\"latency_ms\":$latency_ms,\"error\":$error_json}"
done

curl -sS -X POST "$STATUS/ingest/probe" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  --data "[$rows]"
```

Cron it every ten minutes: `*/10 * * * * /usr/local/bin/kira-status-prober`.

## 11. Reporting the round: POST /ingest/probe

* Auth: `Authorization: Bearer <PROBE_TOKEN>` (a Worker secret). A wrong or missing token
  is a **401 response, never a redirect**; an unconfigured `PROBE_TOKEN` is a 503.
* Body: a JSON **array** of rows. Each row has exactly these five keys:

  | field | type | range |
  |---|---|---|
  | `component` | string | one of the ids in `lib/components.mjs` -- the five local targets plus `site_cn`, which the prober's daily boce round reports |
  | `ok` | boolean | required |
  | `status_code` | integer or null | 100..599 |
  | `latency_ms` | number or null | 0..120000 |
  | `error` | string or null | at most 200 characters |

  An unknown key is a 400; the array holds at most 50 rows. `error` is the only free-text
  field, and it is capped, so a stolen token cannot put unbounded content on the page.
* Response 200:

```json
{ "ok": true, "at": 1787000000000, "count": 5 }
```

  `at` is the round boundary: the Worker rounds its own clock down to the
  `PROBE_INTERVAL_MINUTES` cadence. Each POST deletes the `source='external'` rows at that
  `at` and re-inserts, so a retry inside the same ten minutes is a no-op rather than a
  second round. `region` is written NULL -- the closed row schema has no field for it, and
  `region` is boce's per-node dimension.

### The boce rows

The same prober takes one `site_cn` sample per Beijing day (28 boce nodes) and appends
those per-node rows to the round, which is why `site_cn` is accepted here alongside the
five local ids. The verdict is boce's own: a node reached the site only when
`error_code == 0` AND `http_code > 0`, and a node answering `not found node` is skipped
rather than billed as a failure. The round summary in `error` is capped at this
endpoint's 200 characters. `region` has no field in the closed row schema and is written
NULL; see `deploy/BOCE.md`.

