# TRMNL Sports Plugin

A private TRMNL plugin that shows a team's next game across multiple sports leagues. Powered by a Cloudflare Worker that talks to TheSportsDB v2 API.

For general TRMNL plugin dev guidance (local preview, xhrSelectSearch, etc.) see `../CLAUDE.md`.

## Project structure

```txt
.trmnlp.yml            # Local preview config (not committed — create locally)
src/
  settings.yml         # Plugin config, polling URL, field definitions
  full.liquid          # Full-screen layout
  half_horizontal.liquid
  half_vertical.liquid
  quadrant.liquid
  shared.liquid        # Shared partials (date_time + badge templates)
scripts/
  render-gallery.sh    # Visual contact sheet of every render state (see "Visual gallery")
test/
  fixtures/
    next-game-responses/  # One /next-game JSON per render state, fed to the gallery
cloudflare-worker/     # Backend (deployed at trmnl-sports.carter-pape.workers.dev)
  index.js             # Router + I/O handlers (fetch, cache, telemetry)
  lib/                 # Pure logic, unit-tested (see "Testing")
    constants.js       # SUPPORTED_LEAGUE_IDS, LEAGUE_DISPLAY_NAMES
    localization.js    # locale/tz parse, date/time labels, messages, as-of marker
    schedule.js        # upcoming predicate, selectNextGame, classifyNextGameCache
    format.js          # formatEvent — raw event → /next-game payload
    search.js          # matchRank, searchTeams
    badge.js           # computeBadgeStats (invert + trim pixel math)
  test/                # vitest unit tests (one file per lib module)
    integration/       # fetch-boundary handler tests (Workers pool) — see "Testing"
  vitest.config.js     # Two projects: lib (Node) + integration (Workers pool)
  wrangler.toml        # Wrangler deploy config
  package.json         # Worker npm deps (upng-js; vitest + pool + coverage dev deps)
```

## Publication

- **GitHub:** <https://github.com/CarterPape/trmnl-sports> (public)
- **TRMNL plugin ID:** 271063 (name: "Next Game")

## Cloudflare Worker

Deployed at: `https://trmnl-sports.carter-pape.workers.dev`

**Rate limiting:** 50 requests/minute per IP via Cloudflare Workers Rate Limiting binding (`RATE_LIMITER` in `wrangler.toml`). Tuned high to accommodate `xhrSelectSearch` keystroke fan-out (every keystroke fires a request — TRMNL provides no client-side debounce).

**Response caching:** Both endpoints use `caches.default` with synthetic GET cache keys under the worker's own hostname (so POST `/teams` requests dedupe with each other). TTLs: `/teams` per-query response 24h; team index 24h. `/next-game` uses **stale-while-revalidate**: a single durable entry is stored for `LKG_CACHE_TTL` (7 days) with an `X-Fetched-At` header, but the worker computes its own freshness — within `NEXT_GAME_CACHE_TTL` (10 min) it's served as a fresh hit (re-wrapped to a short client-facing `Cache-Control`); past that it's held as last-known-good while the worker tries to refresh. See "Graceful degradation" below for the outage paths. After the index is warm, `/teams` does zero upstream calls per request — the only SportsDB hits are the ~20 parallel `/list/teams/{id}` calls during a per-POP index refresh.

**Graceful degradation (SportsDB outage):** when the refresh fetch fails, `/next-game` no longer collapses to a misleading "No game found". Instead: if the durable last-known-good is a still-upcoming game (guarded by `isTimestampUpcoming` — never re-serves a game whose start has passed) or a season-over result, it's re-served with `stale: true` + a localized `as_of_label` ("as of 7:00 p.m."), and templates render a subtle staleness marker via the `stale_note` partial. If there's nothing usable to fall back on (cold cache, or a stored game that already started), the response is `{ found: false, outage: true, not_found_message: <localized "Schedule unavailable"> }` — branded with the team's badge/name recovered from the 30-day team-meta cache (`outageTeamMeta`). Degraded responses carry no `Cache-Control` so each poll re-attempts upstream and recovery is prompt. Telemetry: `outcome: "stale"` (LKG saved the screen) vs `outcome: "upstream_fail"` (outage reached the screen); `cache: "stale"` for a served LKG.

**CORS:** Only `/teams` returns CORS headers (it's browser-fetched via xhrSelectSearch). `/next-game` is server-polled by TRMNL and returns no CORS. `OPTIONS /next-game` returns 405.

**Badge analysis (invert + trim):** The worker decodes each badge PNG once (via `upng-js`) in `analyzeBadge`; one pixel pass yields `{ invert, trim }`, cached per badge URL as JSON for 30 days (cache key `/_badge-analysis`, TTL `BADGE_ANALYSIS_CACHE_TTL`). The `/next-game` response carries `*_badge_invert` and `*_badge_trim` for both teams (and `team_badge_*` in the not-found state).

- **`invert`** — mean Rec. 709 luminance of opaque pixels > `WHITE_BADGE_LUMA_THRESHOLD` (200/255). White-on-transparent logos vanish after `image-dither` against the device's white background, so templates apply `filter: invert(1)`.
- **`trim`** — opaque content bounding box as canvas fractions `{x,y,w,h}` (`{0,0,1,1}` = no trim, the decode-failure fallback). TheSportsDB badges are square canvases with varying transparent padding; untrimmed, marks render at inconsistent sizes and the `@` sits asymmetrically between them.

The shared `badge` partial (`shared.liquid`) consumes both: it clips each badge to its content via an `overflow: hidden` wrapper (sized by the layout's `h--`/`w--` class, `aspect-ratio` = content ratio) with the `<img>` scaled (`width: calc(100% / w)`) and `transform: translate`d so only the opaque content shows, plus the invert filter when flagged. Every mark then renders edge-to-edge and hugs the `@`, self-maintaining for any team. `half_vertical` sizes its side-by-side badges by **height** (not width) so trimmed marks stay equal-height and aligned, matching `full`/`half_horizontal`. Full design + rejected alternatives: `pape-docs/0067`.

Why per-pixel, not CSS-only: a single CSS transform can't fix both logo polarities — `mix-blend-mode: difference` over white inverts white-on-transparent logos to black but symmetrically *breaks* black-on-transparent ones (e.g. Spurs) into invisible-white. And a flex `justify-content` tweak can't center the `@`, because the transparent padding lives *inside* the square `<img>`: flex moves the box, not the centered mark within it. Per-pixel measurement is the only universal fix for both.

### Endpoints

**`POST /teams` (or `GET /teams?q=SEARCH_TERM`)**

- Searches the locally cached team index for teams matching the query (POST body: `{"query": "..."}`). The index is built lazily on first request from `/list/teams/{id}` for every league in `SUPPORTED_LEAGUE_IDS`, then cached 24h per Cloudflare POP.
- Case-insensitive substring match against `strTeam`, `strTeamAlternate`, and `strKeywords`. Catches mascot-only queries that SportsDB's `/search/team/` would miss (e.g. "Bulls" → Chicago Bulls).
- Results ranked: (1) team-name prefix match, (2) any team-name token prefix match, (3) substring/alternate/keyword match. Tiebreak alphabetical. Capped at `MAX_SEARCH_RESULTS` (20).
- Returns TRMNL xhrSelectSearch format: `[{"id": "TEAM_ID|LEAGUE_ID", "name": "Team Name (League)"}]`
- Minimum 2 characters required

**`GET /next-game?team=TEAM_ID|LEAGUE_ID&type=any|home|away&locale=LOCALE&tz=IANA_TZ`**

- All filter modes call `/schedule/full/team/{id}` (full current-season schedule across every competition the team is entered in). The list isn't pre-sorted, so the worker filters to upcoming events and sorts ascending before picking the soonest match. Home/away filtering is done locally — see "Cross-league fixtures" below.
- The `LEAGUE_ID` half of the team param drives the `team_league_label` shown in the title bar (mapped through `LEAGUE_DISPLAY_NAMES`, falling back to the team's `strLeague` via the team-meta lookup). Using the URL's leagueId rather than the next event's `strLeague` keeps the label stable across cup/continental fixtures.
- `locale` and `tz` are passed through from `{{ trmnl.user.locale }}` / `{{ trmnl.user.time_zone_iana }}`. The worker uses them to localize `date_label` ("Today", "Heute", "Wednesday, May 1") and `time_label` ("7:00 p.m.", "19:00") on the server, so templates render the strings as-is. Both have a placeholder guard — a literal `{{...}}` string from un-interpolated template syntax falls back to en-US/UTC.
- Returns a flat event object (see `formatEvent` in `lib/format.js`) when a game is found, including pre-localized `date_label`/`time_label`, the raw `start_utc_timestamp`, and the configured team's `team_name` (resolved by matching `idHomeTeam`/`idAwayTeam` against the URL's teamId) plus `team_league_label`. When this object is re-served as last-known-good during an outage it also carries `stale: true` and a localized `as_of_label` (see "Graceful degradation" above).
- When no game is found, returns `{"found": false, "team_badge": <url|null>, "team_badge_invert": <bool>, "team_badge_trim": {x,y,w,h}, "team_name": "...", "team_league_label": "...", "not_found_message": "..."}`. Team badge, name, and league are looked up via `/lookup/team/{id}` and cached 30 days under cache key `/_team-meta` (returned as a `{badge, name, idLeague, strLeague}` JSON blob — see `fetchTeamMeta`). `not_found_message` is the localized "No game found" string keyed off the locale's language code (`NOT_FOUND_MESSAGES` table; falls back to English). A season-over result re-served during an outage adds `stale`/`as_of_label`; the cold-cache outage variant adds `outage: true` with `not_found_message` set to the localized "Schedule unavailable" (`OUTAGE_MESSAGES`).

### Redeploy after changes

```bash
cd cloudflare-worker
npm install   # if node_modules/ is missing (gitignored)
npx wrangler deploy
```

Stream live logs:

```bash
npx wrangler tail
```

### Observability

Every request emits one telemetry record from `emit()` in `index.js`, to two sinks (both free-tier, configured in `wrangler.toml`):

- **Workers Logs** (`[observability] enabled = true`) — a structured `console.log` line tagged `"evt":"req"` with `endpoint`/`outcome`/`cache`/`upstream`/`latencyMs`/config dims. For per-request debugging. 7-day retention.
- **Analytics Engine** (`[[analytics_engine_datasets]]`, binding `ANALYTICS`, dataset `trmnl_sports_requests`) — one `writeDataPoint` per request for aggregate trends (cache-hit ratio, upstream error rate, volume, latency, distinct-config install proxy). 3-month retention. The **column order is a permanent positional contract** — see `cloudflare-worker/observability-queries.md` for the schema and canonical SQL.

`emit()` is the single writer (built from a per-request collector threaded through the handlers); the top-level `fetch` is wrapped in `try/catch/finally` so every path — including a thrown exception (`outcome: "error"`, a recorded 500) — emits exactly once.

**Separating test from real traffic:** `emit()` classifies every request by User-Agent into a `client` bucket (`trmnl` = TRMNL's Faraday poller, `trmnlp` = local preview, `curl`, `browser`, `other`) and a `source` (`test`/`prod`) via the pure `lib/client.js`. `source = test` when a request carries `?test=1` **or** comes from one of our own dev tools (`trmnlp`/`curl`); everything else (incl. unknown UAs) is `prod`. So for a real-world read, filter `source = prod` (or `client = trmnl` for the tight view); see `observability-queries.md`. **When manually hitting the deployed/dev worker in a way that could look like a real poll (browser, a `wrangler dev --remote` polling-URL override, an odd client), append `&test=1`** so it's tagged test — `trmnlp`/`curl` are auto-tagged, so the marker is the safety net for everything else. The raw `ua` is logged (Workers Logs only, not AE) so buckets can be refined later without redeploying. Rationale + the forensic session that motivated this: `pape-docs/0075`.

Gotchas:

- **AE bindings don't exist in local `wrangler dev`** — `emit()` guards with `env.ANALYTICS?.`, so dev runs fine but writes nothing. Use `wrangler dev --remote` to exercise AE against the real binding.
- **Backgrounded / non-TTY `wrangler dev` does not surface worker `console.log`** (it streams worker logs over the DevTools inspector channel, only rendered interactively; the `[wrangler:info] METHOD PATH STATUS` request lines are a separate always-on logger). Don't conclude logging is broken from a piped dev session — verify logs via `wrangler tail`, the dashboard Query Builder, or the `cloudflare-observability` MCP (`query_worker_observability`) against the deployed worker. (Running dev under a real TTY via `script` instead triggers wrangler's interactive "install skills?" prompt and blocks.)

## Testing

Three layers, deliberately separate (full rationale in the testing-session pape-docs):

### Worker logic (unit tests)

The worker's pure logic lives in `cloudflare-worker/lib/` so it's importable and testable without bindings. These run in plain Node via **vitest** (the `lib` project) — no Workers runtime needed, because nothing under test touches it (`Intl`/`Response`/`Request` are Node globals; `computeBadgeStats` takes a raw RGBA array, so no `upng`). The handler integration layer below *does* run under `@cloudflare/vitest-pool-workers`; one `npm test` runs both projects.

```bash
cd cloudflare-worker
npm install        # vitest + @cloudflare/vitest-pool-workers + coverage-istanbul
npm test           # vitest run — BOTH projects (lib + integration)
npm run test:watch
```

The high-value logic that *was* buried in `handleNextGame` is extracted as pure functions and covered here: `selectNextGame` (upcoming-filter + sort + home/away pick) and `classifyNextGameCache` (fresh / stale-but-serveable — the stale guard that refuses to re-serve a started game). Time-dependent functions take an optional `nowMs` (default `Date.now()`) so tests pin "now". The deferred full handler split → thin-router `index.js` is written up in `pape-docs/0073`; smells noticed-but-not-fixed during the extraction are in `pape-docs/0074`.

### Handler integration tests (`test/integration/`)

The I/O handlers (`handleNextGame`, `handleTeamsSearch`, `fetchTeamMeta`, `analyzeBadge`, `emit`) and the router are tested at the **`fetch` boundary** — `worker.fetch(request, env, ctx)` called directly in real `workerd` via `@cloudflare/vitest-pool-workers`, with a **hand-built `env`** (not config bindings) so the telemetry datapoint and the rate-limit/error branches are assertable. Boundary tests are invariant under the deferred 0073 handler split — that's the point: a green run proves the move preserved behavior. Full design, fixture plan, and per-branch checklist: `pape-docs/0076`.

- `_harness.js` — `makeEnv()` (stub `RATE_LIMITER`, spy `ANALYTICS`), `decodeDatapoint()` (pins the AE positional column contract), `installFetchMock()`, `makeBadgePng()`.
- **Status: walking skeleton only** — router 404 + one real `upng` badge-decode smoke. The `/teams` and `/next-game` matrices are still to come (0076 chunks 1–3).

Toolchain gotchas (the pool moved a lot since 0076 was drafted — full account in that doc's "Toolchain reality" note):

- **Default-import CJS deps:** `import UPNG from "upng-js"`, *not* `import * as`. The pool's Vite/rollup bundler exposes a CJS module's exports only under `.default`, while wrangler's esbuild spreads them onto the namespace; the default import resolves under both (and Node). With `import * as`, `UPNG.decode` is `undefined` under the pool and decode silently hits its fallback. Prod (esbuild) is unaffected, but tests are — so reach for the default import for any CJS dep the handlers call.
- **Mock outbound `fetch` with `vi.stubGlobal("fetch", …)`** (wrapped in `installFetchMock`) — the pool's old `fetchMock` from `cloudflare:test` is gone in 0.16. The worker shares the test isolate, so a global stub applies to it.
- **Coverage uses the Istanbul provider** (`@vitest/coverage-istanbul`), not V8 — the pool doesn't support native V8 coverage. `npx vitest run --coverage` reports on `index.js` (no `fail_under` gate yet).

### Visual rendering (`scripts/render-gallery.sh`)

Templates render to dithered e-ink PNGs you *look at*, so the visual layer is a human-eyeball contact sheet, not pixel-diff. The gallery renders every fixture in `test/fixtures/next-game-responses/` across all four views into one labeled contact sheet.

```bash
scripts/render-gallery.sh                       # all states × 4 views → contact sheet
scripts/render-gallery.sh --view full           # one view across all states
scripts/render-gallery.sh --device v2           # render on TRMNL X
```

It's **hermetic**: it serves the fixtures over a local static server and points `variables.trmnl.plugin_settings.polling_url` at them, so the fixture *is* the polled response — edge states the live backend won't produce on demand (stale, outage, long names) render exactly. It backs up and restores your real `.trmnlp.yml`. Because trmnlp reads config (and re-polls) only at startup, the managed `trmnlp serve` is restarted once per fixture (~30s each) — a full run is a few minutes; it's an occasional check. Output lands in `$TMPDIR/trmnl-sports-gallery/`; the combined sheet path prints on stdout. To add a render state, drop another `*.json` (a full `/next-game` response) into the fixtures dir.

## TheSportsDB API

- **Version:** v2 (`https://www.thesportsdb.com/api/v2/json`)
- **Auth:** `X-API-KEY: <key>` request header — key stored as Cloudflare secret `SPORTSDB_API_KEY` (set via `wrangler secret put SPORTSDB_API_KEY`)
- **Key endpoints used:**
    - `GET /list/teams/{league_id}` → `{ list: [...] }` (used to build the team-search index; 20 parallel calls per index refresh)
    - `GET /schedule/full/team/{id}` → `{ schedule: [...] }` (full current-season schedule, ~250-event cap, all competitions)
    - `GET /lookup/team/{id}` → `{ lookup: [...] }` (used for the not-found team-badge fallback)
    - Note: `GET /search/team/{name}` is no longer used — its prefix-only matching missed mascot queries. See "Team search behavior" below.

### Supported league IDs

Defined in `cloudflare-worker/index.js` as `SUPPORTED_LEAGUE_IDS`.

| League | ID |
| --- | --- |
| NHL | 4380 |
| NBA | 4387 |
| MLB | 4424 |
| WNBA | 4516 |
| NWSL | 4521 |
| NCAA Men's Basketball | 4607 |
| NCAA Women's Basketball | 5789 |
| NFL | 4391 |
| NCAA Division I Football | 4479 |
| MLS | 4346 |
| CFL | 4405 |
| English Premier League | 4328 |
| Spanish La Liga | 4335 |
| German Bundesliga | 4331 |
| Italian Serie A | 4332 |
| French Ligue 1 | 4334 |
| AFL | 4456 |
| NRL | 4416 |
| Indian Premier League | 4460 |
| Australian Big Bash League | 4461 |

### Dropdown label overrides (`LEAGUE_DISPLAY_NAMES`)

TheSportsDB's `strLeague` is sometimes wordy or ambiguous (e.g. "NCAA Division 1" without a sport, "American Major League Soccer", "Australian National Rugby League"). The worker maps these to cleaner names (`MLS`, `NRL`, `NCAA Football`, etc.) for the team-search dropdown only — internal cache keys still use the original `idLeague`. When adding a league whose `strLeague` is bad, add it to `LEAGUE_DISPLAY_NAMES`.

### Cross-league fixtures (cup competitions, continental play)

All three filter modes (`any`/`home`/`away`) hit `/schedule/full/team/{id}`, which returns the team's full current-season schedule across every competition they're entered in (cup, continental, etc.). Home/away filtering happens locally, so cross-league fixtures stay visible regardless of filter — and "next home game" can find a match anywhere in the remaining season, not just within the next handful of events.

### Team search behavior

The worker maintains a local index of every team across `SUPPORTED_LEAGUE_IDS` (built from `/list/teams/{id}`, ~1100 teams total, cached 24h per POP). Search is a case-insensitive substring scan against `strTeam`, `strTeamAlternate`, and `strKeywords`. Mascot-only queries work ("Bulls" → Chicago Bulls; "Warriors" → Golden State Warriors), as do city queries ("Chic" → all Chicago teams) and full-name queries.

Why not SportsDB's `/search/team/`: it only matches on team-name prefix or city. Even v1's "matches alternate names" doesn't help — Chicago Bulls' record has empty `strTeamAlternate` and `strKeywords`, so no SportsDB endpoint returns it for "Bulls".

Caveat: substring matching can produce odd hits (e.g. "xy" matches "Galaxy"). The 2-char minimum keeps this manageable.

## TRMNL plugin settings

- **Team** (`team_id`): `xhrSelectSearch` — calls Worker `/teams?q=` as user types. Stores composite `"TEAM_ID|LEAGUE_ID"` as the value.
- **Game Filter** (`game_type`): static select — `any` / `home` / `away`
- **Polling URL:** `https://trmnl-sports.carter-pape.workers.dev/next-game?team={{ team_id }}&type={{ game_type }}&locale={{ trmnl.user.locale }}&tz={{ trmnl.user.time_zone_iana }}`
- **Title bar:** All four layouts include a `title_bar` sibling to `layout` with `<span class="title">Next Game</span>` plus a per-instance `<span class="instance">` carrying the configured team. `full` and `half_horizontal` show `{{ team_name }} ({{ team_league_label }})`; `half_vertical` and `quadrant` drop the league to avoid overflow with long names. No icon — TRMNL's [recipe-publishing tips](https://trmnl.com/blog/plugin-recipe-publishing-tips) explicitly warn against using the default `trmnl--render.svg`, and the framework docs don't require a title-bar icon. The title bar was originally added in response to David's recipe-review feedback (2026-04-26 email, archived at `pape-docs/archive/0070 TRMNL David recipe-review feedback.md`).
- **Refresh interval:** 15 minutes

## Local preview `.trmnlp.yml`

```yaml
custom_fields:
  team_id: "TEAM_ID|LEAGUE_ID"   # find via: curl "https://trmnl-sports.carter-pape.workers.dev/teams?q=Chicago"
  game_type: "any"               # any | home | away
```

## Known open items

- **League allowlist** — `SUPPORTED_LEAGUE_IDS` may be loosened in the future to allow any TheSportsDB team.
