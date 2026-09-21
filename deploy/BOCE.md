# boce (mainland-China reachability) — the adapter contract

**Status: calibrated against the live API on 2026-09-17.** The request and response
shapes below are copied from real calls, not from the docs. boce's API console sits
behind a login, and guessing the format would have produced an adapter that failed
on its first scheduled run — which, for a once-daily probe, is a day of silence.

The documented shapes were found at <https://www.boce.com/document/api/137/12>
(create) and <https://www.boce.com/document/api/137/42> (fetch). The live calls
agree with them.

## The two calls

### 1. Create a task

```
GET https://api.boce.com/v3/task/create/curl?key=<KEY>&node_ids=<a,b,c>&host=<urlencoded-url>
```

| param | notes |
|---|---|
| `key` | the API key (`BOCE_API_KEY`) |
| `node_ids` | comma-separated node ids. **This is what sets the cost** — 1 波点 per node per check. |
| `host` | the URL to fetch, percent-encoded. One URL only. |
| `node_type` | optional: `1` = datacentre node, `2` = router node. Unset means no restriction. |

Real response (HTTP检测 create, one node):

```json
{"error_code":0,"error":"","data":{"id":"20260917_f16c1d2abede8482f03c465f2afeef7a"}}
```

`error_code` is `0` on success. The task id is `data.id`, and its shape is
`<yyyymmdd>_<32 hex>`.

### 2. Fetch the result

```
GET https://api.boce.com/v3/task/curl/<task_id>?key=<KEY>
```

Poll until `done` is `true`. The docs suggest every 10s, giving up at 2 minutes.
In the calibration run the task was already `done` on the first poll ~5s later, so
the poller should still start immediately rather than after a fixed delay.

Real response, trimmed to the fields we read:

```json
{
  "done": true,
  "id": "20260917_f16c1d2abede8482f03c465f2afeef7a",
  "max_node": 1,
  "list": [{
    "node_id": 6,
    "node_name": "河北电信",
    "http_code": 200,
    "error_code": 0,
    "error": "",
    "time_total": 3.646962,
    "time_namelookup": 0.149566,
    "time_connect": 0.364430,
    "remote_ip": "104.21.79.161",
    "ip_region": "美国",
    "ip_isp": "Cloudflare, Inc.",
    "origin_ip": ""
  }]
}
```

## What the calibration changed

Three things that the docs do not say, and that a from-the-docs adapter gets wrong:

1. **The verdict is `error_code` *and* `http_code` — and `report_source` is neither.**
   The calibrated run came back `error_code: 0` with `http_code: 200`, while
   `report_source` *began* with a node-local complaint about a CA bundle
   (`Error reading ca cert file ... mbedTLS`). That text is noise from the probe
   node's own environment. A parser that scans `report_source` for the word "Error"
   would mark a healthy site down. `error` may contain `not found node`, which means
   the node is offline — and, per the docs, is **not billed**.

   **Correction, 2026-09-18 — `error_code` alone is not enough.** The first
   production run showed that a node which cannot reach the site reports
   `http_code: 0` while still leaving `error_code: 0` **and** `error: ""`; the real
   reason (`curl: (7) ... connection reset by peer`, `curl: (28) operation timed
   out`, `Recv failure: Connection`) appears only inside `report_source`. Three of
   the first fourteen nodes did exactly this, and judging on `error_code` alone
   recorded all three as **green** — a fabricated all-clear on the one row whose
   entire purpose is "can mainland China reach us". The verdict is:

   ```
   reached = (error_code === 0) && (http_code > 0)
   ```

   `report_source` still decides nothing: it is read only to fill in the `error`
   text of a row already judged failed, which is why the CA-bundle noise above stays
   harmless. Both halves are pinned in `test/unit.test.mjs`.

2. **A mainland node can resolve to a non-China IP.** Node 6 is 河北电信 (Hebei
   Telecom) but reported `remote_ip: 104.21.79.161` with `ip_region: 美国` and
   `ip_isp: Cloudflare`. That is Cloudflare anycast doing its job — the request
   reached China, the origin is simply fronted by Cloudflare. The consequence for
   this service is important and is why `ip_region` is stored: **a 200 from a CN
   node does not mean the CN node reached a CN origin**, and the per-node resolved
   region is a DNS signal we get for free (the handoff's point about inferring
   pollution without paying for the dedicated 域名污染检测 product).

3. **`list` is empty until `done`.** The docs say so; the live API confirms the
   array is `[]` on an unfinished task rather than partially populated. So the
   poller must check `done` before reading `list`, not read `list.length`.

## Cost, restated

`1 波点 / node / check`. The settled configuration is **28 nodes once daily**
(`BOCE_AUTO_NODES` — the verified live set, not the nominal 30):
`28 × 1 × 1 = 28 波点/day`. At the platform's rate that is roughly
**0.056 CNY/day ≈ 1.7 CNY/month**.

Node ids are re-verified periodically because boce **retires** nodes: a stale id does
not fail loudly, it makes the create call answer `no task to do` and quietly drops out
of the round. Ask for 30 and get 14 billed and you have neither the coverage nor the
cost you budgeted. To re-verify, probe ids one at a time — a bad id reports per node,
so a single-node call is the honest test — and replace the dead ones.

Not implemented, and each for a stated reason:

- **PING测速 instead of HTTP检测.** Cloudflare deprioritises ICMP, so a ping-based
  read would false-alarm on a site that is actually fine, and ICMP is blind to
  SNI-based blocking. HTTP检测 walks the real path (DNS → TCP → TLS/SNI → status)
  and its resolved IPs answer the DNS question too. Both cost the same per node.
- **The dedicated 域名污染检测.** 10× the cost for a signal `ip_region` already
  approximates.
- **A CN-side probe of `hrt.kiramyao.com`.** Would roughly double the bill for a
  second opinion on a subdomain.

## Where it runs

The Worker cannot run it. A cron invocation is CPU-metered and short-lived, while a
sample is a create call plus an asynchronous poll (up to ~2 minutes), so the adapter runs
on the out-of-zone prober -- the host that already holds `PROBE_TOKEN` and reports
`POST /ingest/probe`. It takes one sample per Beijing day, gated by
`/var/lib/status-probe/last-boce-day`, so a retry cannot buy a second sample, and appends
the rows to the same POST as the five inbound readings: the ingest endpoint replaces every
`source='external'` row at the round's timestamp, so a separate POST would erase the other
half of the round. `site_cn` is on that endpoint's allowed component list for this reason.
The Worker's `BOCE_ENABLED` decides only whether a CN sample is *expected* (the
`cnExpected` cap in `mergeDay`) and which cadence the row goes stale on, not whether a
sample is taken.

## Operating rules the adapter enforces

- **A page view never triggers a boce call.** The adapter runs only from the probe
  loop and writes to the cache; the page reads the cache. If this is broken once,
  page traffic becomes the bill.
- **`BOCE_ENABLED=false` disables CN entirely** — the column disappears rather than
  showing an unknown, because "we chose not to ask" is not the same as "we could
  not find out".
- **A boce failure degrades to "CN sample unavailable", never to green.** See
  `mergeDay` in `lib/aggregate.mjs`, which caps a day at amber when CN was expected
  but produced no sample.
