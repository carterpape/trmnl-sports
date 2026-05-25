# Observability queries

The worker emits one telemetry record per request from `emit()` in `index.js`, to two sinks:

- **Workers Logs** — a structured `console.log` line tagged `"evt":"req"`. Best for debugging individual requests. Query it in the Cloudflare dashboard's **Logs / Query Builder**, via `npx wrangler tail`, or the `cloudflare-observability` MCP (`query_worker_observability`). Cloudflare parses the JSON into **top-level structured fields**, so filter and group by keys directly (`outcome`, `cache`, `endpoint`, `evt`, …) — matching the raw `$metadata.message` string will *not* work. Example (MCP, calculations view): count grouped by `outcome` with filter `evt = req`.
- **Analytics Engine** — one `writeDataPoint` to the dataset `trmnl_sports_requests`. Best for aggregate trends over time (up to 3-month retention). Query it with the SQL API, documented below.

This file is the canonical record of the **AE column contract** plus the canonical queries. The column positions are permanent: AE columns are positional (`blob1..blobN`, `double1..doubleN`), so **never reorder or repurpose a column — append new fields only.** `index.js` `emit()` is the single writer; keep it in sync with the table below.

## Column contract

| Column | Field | Meaning |
| --- | --- | --- |
| `index1` | endpoint | sampling key: `teams` / `next-game` / `other` |
| `blob1` | endpoint | same value as `index1` (kept as a blob for uniform `GROUP BY`) |
| `blob2` | outcome | `ok` / `stale` / `short_query` / `missing_team` / `upstream_fail` / `rate_limited` / `cors_preflight` / `method_not_allowed` / `not_found` / `error` (`stale` = served last-known-good because upstream failed) |
| `blob3` | cache | `none` / `hit` / `miss` / `stale` / `rebuild` (`stale` = served a durable entry past its freshness window; `rebuild` = this request paid the ~20-call team-index fan-out) |
| `blob4` | upstream | `none` / `ok` / `fail` / `partial` |
| `blob5` | method | `GET` / `POST` / `OPTIONS` |
| `blob6` | team | configured team ID, `next-game` only (public ID, not PII) |
| `blob7` | type | `any` / `home` / `away` |
| `blob8` | tz | parsed IANA time zone |
| `blob9` | locale | parsed locale |
| `blob10` | client | **descriptive** UA bucket: `faraday` / `ruby` / `curl` / `browser` / `other`. ⚠️ NOT provenance — TRMNL polls with both `ruby` (device-checkin, the bulk of real traffic) and `faraday` (preview/`team=0`), and our local tooling shares those UAs. Do not infer test/real from this. |
| `blob11` | source | `test` / `prod` — `test` **only** when `?test=1` is present (our tools/manual hits set it); everything else is `prod`. (Earlier this also auto-tagged the `ruby`/`curl` buckets as test, which hid real TRMNL device traffic — removed.) |
| `blob12` | device | `trmnl.device.friendly_id` (e.g. `93B2E9`), `next-game` only. **Populated only by real TRMNL device polls** — local `trmnlp` sends the literal `{{...}}` placeholder (not interpolated) and curl sends nothing, both stored as `''`. This is the reliable real-install signal. |
| `double1` | latencyMs | wall-clock request duration |
| `double2` | status | HTTP status code |
| `double3` | upstreamCalls | primary SportsDB calls issued (0, 1, or ~20 on a teams rebuild) |
| `double4` | upstreamFails | how many of those calls failed |

Extension point: new dimensions append at `blob13+` / `double5+` (e.g. sub-fetch volume from `fetchTeamMeta`/`shouldInvertBadge`, deliberately not tracked in v1).

**Reading real (non-test) traffic — use `device`, not `client`/`source`.** The UA buckets cannot separate real TRMNL polls from our own tooling (both use `ruby`/`faraday`), so the gold-standard real-install filter on `next-game` is **`AND blob12 != ''`** (a populated friendly_id ⇒ a real device poll; excludes our local trmnlp/curl, which lack one). `AND blob11 = 'prod'` additionally drops anything explicitly `?test=1`-marked, but on its own it now *includes* our un-tagged local tooling — so prefer the `device` filter, or combine both. The Workers Logs line carries the raw `ua` + `device` so buckets can be refined later without redeploying.

## Running a query

Queries go to the SQL API via `POST`. You need a Cloudflare API token with the **Account Analytics → Read** permission.

```bash
curl "https://api.cloudflare.com/client/v4/accounts/$CF_ACCOUNT_ID/analytics_engine/sql" \
  --header "Authorization: Bearer $CF_API_TOKEN" \
  --data "SELECT SUM(_sample_interval) AS requests FROM trmnl_sports_requests WHERE timestamp > NOW() - INTERVAL '1' DAY"
```

Always weight counts by `_sample_interval` (it is `1` until AE down-samples at high volume; weighting keeps results correct if it ever does). At this plugin's volume sampling will not trigger, but the queries below are written sample-correct anyway.

## Canonical queries

### Cache-hit ratio, per endpoint (last 24h)

The headline number for roadmap item B. `next-game`'s ratio shows how often a poll re-fetches SportsDB. `stale` serves are deliberately excluded from both the numerator and the denominator — they're an outage signal, not a cache outcome; watch them via the degradation query below.

```sql
SELECT
    index1 AS endpoint,
    SUM(IF(blob3 = 'hit', _sample_interval, 0)) AS hits,
    SUM(IF(blob3 IN ('miss', 'rebuild'), _sample_interval, 0)) AS misses,
    SUM(IF(blob3 = 'hit', _sample_interval, 0))
        / SUM(IF(blob3 IN ('hit', 'miss', 'rebuild'), _sample_interval, 0)) AS hit_ratio
FROM trmnl_sports_requests
WHERE timestamp > NOW() - INTERVAL '1' DAY AND blob3 != 'none'
GROUP BY endpoint
```

### Upstream SportsDB error rate, per endpoint (last 24h)

Uses the call-count doubles so the 20-call teams rebuild is weighted correctly.

```sql
SELECT
    index1 AS endpoint,
    SUM(double4 * _sample_interval) AS failed_calls,
    SUM(double3 * _sample_interval) AS total_calls,
    SUM(double4 * _sample_interval) / NULLIF(SUM(double3 * _sample_interval), 0) AS error_rate
FROM trmnl_sports_requests
WHERE timestamp > NOW() - INTERVAL '1' DAY
GROUP BY endpoint
```

### Daily request/poll volume, per endpoint (last 7 days)

```sql
SELECT
    toStartOfDay(timestamp) AS day,
    index1 AS endpoint,
    SUM(_sample_interval) AS requests
FROM trmnl_sports_requests
WHERE timestamp > NOW() - INTERVAL '7' DAY
GROUP BY day, endpoint
ORDER BY day, endpoint
```

### Distinct devices — unique-install proxy (next-game, last 24h)

The headline adoption number. `blob12` is `trmnl.device.friendly_id`, so distinct devices ≈ unique installs (a multi-device user counts once per device, so this should roughly track TRMNL's "connections" count — a cross-check on a number the worker otherwise can't see). `COUNT(DISTINCT ...)` is a cardinality, exact only while unsampled (true at this volume).

```sql
SELECT COUNT(DISTINCT blob12) AS distinct_devices
FROM trmnl_sports_requests
WHERE timestamp > NOW() - INTERVAL '1' DAY
    AND index1 = 'next-game'
    AND blob12 != ''
```

To see *which* teams the install base follows (popular-team curiosity), group real-device traffic by team:

```sql
SELECT blob6 AS team, COUNT(DISTINCT blob12) AS devices, SUM(_sample_interval) AS polls
FROM trmnl_sports_requests
WHERE timestamp > NOW() - INTERVAL '7' DAY AND index1 = 'next-game' AND blob12 != ''
GROUP BY team ORDER BY devices DESC, polls DESC
```

(The older config-tuple proxy — `COUNT(DISTINCT concat(blob6,'|',blob7,'|',blob8,'|',blob9))` filtered on `blob6 != ''` — predates `device` and is a weaker stand-in; prefer `blob12` now that it exists.)

### Latency p50 / p95, per endpoint (last 24h)

```sql
SELECT
    index1 AS endpoint,
    quantileExactWeighted(0.5)(double1, _sample_interval) AS p50_ms,
    quantileExactWeighted(0.95)(double1, _sample_interval) AS p95_ms,
    SUM(_sample_interval) AS n
FROM trmnl_sports_requests
WHERE timestamp > NOW() - INTERVAL '1' DAY
GROUP BY endpoint
```

### Team-index rebuild frequency (teams, last 7 days)

Confirms the "~21 rebuilds/day/POP" assumption and surfaces SportsDB-outage bursts (repeated `rebuild` + `upstream=fail`).

```sql
SELECT
    toStartOfDay(timestamp) AS day,
    SUM(IF(blob3 = 'rebuild', _sample_interval, 0)) AS rebuilds
FROM trmnl_sports_requests
WHERE timestamp > NOW() - INTERVAL '7' DAY AND index1 = 'teams'
GROUP BY day
ORDER BY day
```

### Error / degradation watch (last 24h)

Watches the degradation paths: `stale` (served last-known-good because upstream was down — the screen survived the outage), `upstream_fail` (upstream was down with nothing usable to serve — the device showed "Schedule unavailable"), and `error` (a caught exception, a deliberate recorded 500). A rising `stale` count means outages are happening but being absorbed; a rising `upstream_fail` means outages are reaching the screen.

```sql
SELECT
    blob2 AS outcome,
    SUM(_sample_interval) AS n
FROM trmnl_sports_requests
WHERE timestamp > NOW() - INTERVAL '1' DAY
    AND blob2 IN ('error', 'upstream_fail', 'stale')
GROUP BY outcome
```

### Traffic by client + source + has-device (last 24h)

Descriptive breakdown only — remember `client`/`source` do NOT cleanly separate real TRMNL from our tooling (that's what `device` is for). Real TRMNL device polls land in `client = 'ruby'` (and some `faraday`) with a populated `device`; a row with `device_present = 1` is genuine regardless of `source`. Use this to eyeball UA distribution and confirm `device` is populating after a deploy.

```sql
SELECT
    blob10 AS client,
    blob11 AS source,
    IF(blob12 != '', 1, 0) AS device_present,
    SUM(_sample_interval) AS n
FROM trmnl_sports_requests
WHERE timestamp > NOW() - INTERVAL '1' DAY
GROUP BY client, source, device_present
ORDER BY n DESC
```
