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
```

## Publication

- **GitHub:** https://github.com/CarterPape/trmnl-sports (public)
- **TRMNL plugin ID:** 271063 (name: "Next Game")

## Cloudflare Worker

Deployed at: `https://trmnl-sports.carter-pape.workers.dev`

**Rate limiting:** 50 requests/minute per IP via Cloudflare Workers Rate Limiting binding (`RATE_LIMITER` in `wrangler.toml`).

### Endpoints

**`GET /teams?q=SEARCH_TERM`**

- Searches TheSportsDB for teams matching the query
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
