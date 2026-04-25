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
- Filters to 7 supported leagues (NHL, NBA, MLB, NCAA Men's BB, NCAA Women's BB, WNBA, NWSL)
- Returns TRMNL xhrSelectSearch format: `[{"id": "TEAM_ID|LEAGUE_ID", "name": "Team Name (League)"}]`
- Minimum 2 characters required

**`GET /next-game?team=TEAM_ID|LEAGUE_ID&type=any|home|away`**

- For `type=any`: calls `/schedule/next/team/{id}` (efficient)
- For `type=home` or `type=away`: fetches the full season schedule and filters
- Returns a flat event object (see index.js `formatEvent`) or `{"found": false}`

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

### Supported league IDs

| League | ID |
| --- | --- |
| NHL | 4380 |
| NBA | 4387 |
| MLB | 4424 |
| NCAA Men's Basketball | 4607 |
| NCAA Women's Basketball | 5789 |
| WNBA | 4516 |
| NWSL | 4521 |

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
- **7-league filter** — may be loosened in the future to allow any TheSportsDB team.
