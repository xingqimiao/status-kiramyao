# kira-status

The status page at <https://status.kiramyao.com>: uptime over a 90-day window, an
incident history, and the "data guardian" figures for the kiramyao services.

**Zero runtime dependencies.** Node plus `node:sqlite`, server-rendered HTML, no
build step, no `node_modules` on the box. Mirrors the layout of the comment service
next door, deliberately, because the same operator deploys both.

```
lib/aggregate.mjs    day cells, uptime, the CN/overseas merge   (pure)
lib/incidents.mjs    contiguous failure runs from probe history  (pure)
lib/components.mjs   the component register — ids shared by config and view
lib/config.mjs       environment only; .env loaded when present
lib/db.mjs           two tables: probes, metrics
lib/probe.mjs        the local checks, the boce adapter, the guardian reads
lib/snapshot.mjs     assembles what the page renders, from storage only
lib/view.mjs         HTML and JSON rendering
server.mjs           two loops and a request handler
bin/probe-once.mjs   run one round by hand (the installer's first check)
```

## Running it

```bash
cp .env.example .env      # fill in BOCE_API_KEY if you want the CN column
node bin/probe-once.mjs   # one round, printed — no server
node server.mjs           # the service
node --test test/*.test.mjs
```

Node 22.5+ is required for `node:sqlite`.

## How it works, and the three decisions worth knowing

**The page reads a cache and never probes.** A request renders from what the probe
loop already wrote. This is not an implementation detail — boce bills per check, and
wiring a probe to a request would make page traffic the monthly bill. `test` asserts
this by handing the service a `fetch` that throws during a render.

**CN and overseas are one component, not two columns.** Each day's cell takes the
*worse* of that day's overseas result and that day's CN sample, so a day China could
not reach reads amber even when Singapore was fine. Where there is a CN sample
missing, the day is capped at amber — never green, because green would assert
reachability from China and the honest statement is that we do not know. This is the
same reason the metric tiles render "—" rather than 0: "we could not read the
number" and "the number is zero" are different claims, and only one belongs here.

**Incidents are derived, not filed.** There is no admin UI in v1; the probes know
when something broke. A run of failed probes is an incident, a short success between
failures is a flapping blip rather than a recovery, and a silence longer than a few
probe intervals ends the run — we cannot claim to have been watching across it. Each
of those rules has a test, because an incident list that has merged two outages into
one reads exactly like one that has not.

## Probing

| target | source | cadence | cost |
|---|---|---|---|
| comment service health | local | 30 min | free |
| HRT Core health | local | 30 min | free |
| tracker web app | local | 30 min | free |
| marketing site (overseas) | local, from Singapore | 30 min | free |
| marketing site (mainland CN) | **boce** | **daily** | ~30 nodes × 1 波点 ≈ 0.06 CNY/day |

The CN probe uses boce's HTTP检测, not PING测速: the question is site reachability,
so HTTP covers the real path (DNS → TCP → TLS/SNI → status) while ICMP would
false-alarm on Cloudflare and is blind to SNI-based blocking. It is also where the
resolved-IP region comes from, which is a DNS signal we get for free rather than
paying 10× for the dedicated 域名污染检测 product. Full detail, including what the
calibration call changed, is in `deploy/BOCE.md`.

Stories preserved is counted from the site's own machine-readable catalogue
(`/.well-known/api-catalog.json`) rather than by walking 125 Markdown files.

## What v1 deliberately does not do

- **No email subscriptions.** `/history.json` and a rendered incident list are the
  v1 interface; anyone who wants to watch the numbers can poll them. A subscription
  backend is a real piece of work and not what a status page needs first.
- **No manual incident filing.** See above — derived from probes. A UI can layer on.
- **No rollup table.** 90 days at a 30-minute cadence is a few thousand rows per
  component and a `GROUP BY` is not work.

## Deployment

`deploy/INSTALL.md` has the whole procedure, `deploy/Caddyfile` the proxy block, and
`deploy/kira-status.service` a hardened systemd unit. Note that a
`status.kiramyao.com` DNS record has to exist before the Caddy block will serve.

## Data

Two SQLite tables in `data/`:

```
probes(source, component, at, ok, status_code, latency_ms, error, region)
metrics(at, key, value)
```

`metrics` holds counts read from the services' own public aggregates, and the probe
rows are our own readings. Nothing here is personal data: the probe rows describe
*services*, not people, and the guardian figures are counts of accounts and records
with no identifiers — the same class of aggregate the trackers publish themselves.

## Licence

Fork of an MIT-licensed project; see the repository's `LICENSE`. The upstream
attribution in the documentation of the sibling services applies here too.
