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
  shared.liquid        # Shared partials (date_time template)
cloudflare-worker/     # Backend (deployed at trmnl-sports.carter-pape.workers.dev)
  index.js             # Worker source — two endpoints: /teams and /next-game
  wrangler.toml        # Wrangler deploy config
  package.json         # Worker npm deps (upng-js for badge analysis)
```

## Publication

- **GitHub:** https://github.com/CarterPape/trmnl-sports (public)
- **TRMNL plugin ID:** 271063 (name: "Next Game")

## Cloudflare Worker

Deployed at: `https://trmnl-sports.carter-pape.workers.dev`

**Rate limiting:** 50 requests/minute per IP via Cloudflare Workers Rate Limiting binding (`RATE_LIMITER` in `wrangler.toml`). Tuned high to accommodate `xhrSelectSearch` keystroke fan-out (every keystroke fires a request — TRMNL provides no client-side debounce).

**Response caching:** Both endpoints use `caches.default` with synthetic GET cache keys under the worker's own hostname (so POST `/teams` requests dedupe with each other). Upstream failures are not cached. TTLs: `/teams` 24h, `/next-game` 10 min (under TRMNL's 15-min poll). Caching is the primary defense against keystroke fan-out and abuse — popular team prefixes ("Chic", "New Y") stay warm across users.

**CORS:** Only `/teams` returns CORS headers (it's browser-fetched via xhrSelectSearch). `/next-game` is server-polled by TRMNL and returns no CORS. `OPTIONS /next-game` returns 405.

**Badge invert auto-detection:** The `/next-game` response includes `home_team_badge_invert` and `away_team_badge_invert` flags. The worker fetches each badge PNG (via `upng-js`), measures the mean luminance of opaque pixels, and flags badges above `WHITE_BADGE_LUMA_THRESHOLD` (200/255) as needing `filter: invert(1)` in templates. This catches white-on-transparent logos (e.g. Trail Blazers) that would otherwise render as invisible after `image-dither` against the device's white background. The decision is cached per badge URL for 30 days. Templates use `{% if X_team_badge_invert %}style="filter: invert(1);"{% endif %}` on each badge `<img>`.

Why this and not CSS: `mix-blend-mode: difference` over white correctly inverts white-on-transparent logos to black, but symmetrically *breaks* black-on-transparent logos (e.g. Spurs) by inverting them to invisible-white. Any single CSS transformation can only fix one polarity; per-pixel detection is the only universal fix.

### Endpoints

**`POST /teams` (or `GET /teams?q=SEARCH_TERM`)**

- Searches TheSportsDB for teams matching the query (POST body: `{"query": "..."}`)
- Filters to the supported leagues listed in `SUPPORTED_LEAGUE_IDS` (see "Supported league IDs" below)
- Returns TRMNL xhrSelectSearch format: `[{"id": "TEAM_ID|LEAGUE_ID", "name": "Team Name (League)"}]`
- Minimum 2 characters required

**`GET /next-game?team=TEAM_ID|LEAGUE_ID&type=any|home|away`**

- For `type=any`: calls `/schedule/next/team/{id}` (efficient)
- For `type=home` or `type=away`: fetches the full season schedule and filters
- Returns a flat event object (see index.js `formatEvent`) when a game is found
- When no game is found, returns `{"found": false, "team_badge": <url|null>, "team_badge_invert": <bool>}`. The team badge is looked up via `/lookup/team/{id}` (cached 30 days per team) so the not-found template can still show the configured team's logo. Invert is computed via the same `shouldInvertBadge` pipeline used for found-state badges.

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

## TheSportsDB API

- **Version:** v2 (`https://www.thesportsdb.com/api/v2/json`)
- **Auth:** `X-API-KEY: <key>` request header — key stored as Cloudflare secret `SPORTSDB_API_KEY` (set via `wrangler secret put SPORTSDB_API_KEY`)
- **Key endpoints used:**
    - `GET /search/team/{name}` → `{ search: [...] }`
    - `GET /schedule/next/team/{id}` → `{ schedule: [...] }`
    - `GET /schedule/league/{leagueId}/{season}` → `{ schedule: [...] }`
    - `GET /lookup/team/{id}` → `{ lookup: [...] }` (used for the not-found team-badge fallback)

### Supported league IDs

Defined in `cloudflare-worker/index.js` as `SUPPORTED_LEAGUE_IDS`. `SUMMER_LEAGUE_IDS` flags the leagues whose `strSeason` is a single calendar year (e.g. `"2026"`); everything else uses split-year (`"2025-2026"`) and falls back to the August cutoff in `getCurrentSeason`.

| League                              | ID   | Season string |
| ----------------------------------- | ---- | ------------- |
| NHL                                 | 4380 | split         |
| NBA                                 | 4387 | split         |
| MLB                                 | 4424 | single        |
| WNBA                                | 4516 | single        |
| NWSL                                | 4521 | single        |
| NCAA Men's Basketball               | 4607 | split         |
| NCAA Women's Basketball             | 5789 | split         |
| NFL                                 | 4391 | single        |
| NCAA Division I Football            | 4479 | single        |
| MLS                                 | 4346 | single        |
| CFL                                 | 4405 | single        |
| English Premier League              | 4328 | split         |
| Spanish La Liga                     | 4335 | split         |
| German Bundesliga                   | 4331 | split         |
| Italian Serie A                     | 4332 | split         |
| French Ligue 1                      | 4334 | split         |
| AFL                                 | 4456 | single        |
| NRL                                 | 4416 | single        |
| Indian Premier League               | 4460 | single        |
| Australian Big Bash League          | 4461 | split         |

When adding a new league, look up `strCurrentSeason` via `https://www.thesportsdb.com/api/v1/json/3/search_all_seasons.php?id=<league_id>` (free, no key needed) to determine which set it belongs to — TheSportsDB's choice doesn't always match the league's calendar shape (NFL is single-year despite being a fall-to-winter sport).

### Dropdown label overrides (`LEAGUE_DISPLAY_NAMES`)

TheSportsDB's `strLeague` is sometimes wordy or ambiguous (e.g. "NCAA Division 1" without a sport, "American Major League Soccer", "Australian National Rugby League"). The worker maps these to cleaner names (`MLS`, `NRL`, `NCAA Football`, etc.) for the team-search dropdown only — internal cache keys still use the original `idLeague`. When adding a league whose `strLeague` is bad, add it to `LEAGUE_DISPLAY_NAMES`.

### Cross-league fixtures (cup competitions, continental play)

`/schedule/next/team/{id}` returns the team's next ~5 events across **all competitions** they're entered in, so a `game_type=any` query for a Premier League team will surface a Champions League fixture if it's their next match. The `home`/`away` paths use `/schedule/league/{leagueId}/{season}`, which is the team's primary domestic league only — so cross-league cup fixtures are invisible to those filters. There is no per-team season endpoint in TheSportsDB v2; v1 has `eventsseason.php?id=<team>` if a future fix needs it.

### Team search behavior

TheSportsDB search matches on team name prefix or city name — it does **not** fuzzy-match nicknames. "Chicago" works (returns Bulls, Blackhawks, Cubs, etc.); "Bulls" does not. "Golden State" works; "Warriors" does not. Users should type city name or full team name prefix.

## TRMNL plugin settings

- **Team** (`team_id`): `xhrSelectSearch` — calls Worker `/teams?q=` as user types. Stores composite `"TEAM_ID|LEAGUE_ID"` as the value.
- **Game Filter** (`game_type`): static select — `any` / `home` / `away`
- **Polling URL:** `https://trmnl-sports.carter-pape.workers.dev/next-game?team={{ team_id }}&type={{ game_type }}`
- **Refresh interval:** 15 minutes

## Local preview `.trmnlp.yml`

```yaml
custom_fields:
  team_id: "TEAM_ID|LEAGUE_ID"   # find via: curl "https://trmnl-sports.carter-pape.workers.dev/teams?q=Chicago"
  game_type: "any"               # any | home | away
```

## Known open items

- **Logo centering** — logos with varying amounts of transparent padding can make the `@` symbol appear off-center. See `0067 Claude diary 2026-03-29.md` for the plan (CSS-first, then weserv.nl trim proxy if needed).
- **Timestamp timezone** — `strTimestamp` from TheSportsDB is treated as UTC (Worker appends `+00:00`). If game times display incorrectly, this assumption may be wrong.
- **League allowlist** — `SUPPORTED_LEAGUE_IDS` may be loosened in the future to allow any TheSportsDB team.
