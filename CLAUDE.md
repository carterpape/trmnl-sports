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

- **GitHub:** <https://github.com/CarterPape/trmnl-sports> (public)
- **TRMNL plugin ID:** 271063 (name: "Next Game")

## Cloudflare Worker

Deployed at: `https://trmnl-sports.carter-pape.workers.dev`

**Rate limiting:** 50 requests/minute per IP via Cloudflare Workers Rate Limiting binding (`RATE_LIMITER` in `wrangler.toml`). Tuned high to accommodate `xhrSelectSearch` keystroke fan-out (every keystroke fires a request — TRMNL provides no client-side debounce).

**Response caching:** Both endpoints use `caches.default` with synthetic GET cache keys under the worker's own hostname (so POST `/teams` requests dedupe with each other). Upstream failures are not cached. TTLs: `/teams` per-query response 24h; team index 24h; `/next-game` 10 min (under TRMNL's 15-min poll). After the index is warm, `/teams` does zero upstream calls per request — the only SportsDB hits are the ~20 parallel `/list/teams/{id}` calls during a per-POP index refresh.

**CORS:** Only `/teams` returns CORS headers (it's browser-fetched via xhrSelectSearch). `/next-game` is server-polled by TRMNL and returns no CORS. `OPTIONS /next-game` returns 405.

**Badge invert auto-detection:** The `/next-game` response includes `home_team_badge_invert` and `away_team_badge_invert` flags. The worker fetches each badge PNG (via `upng-js`), measures the mean luminance of opaque pixels, and flags badges above `WHITE_BADGE_LUMA_THRESHOLD` (200/255) as needing `filter: invert(1)` in templates. This catches white-on-transparent logos (e.g. Trail Blazers) that would otherwise render as invisible after `image-dither` against the device's white background. The decision is cached per badge URL for 30 days. Templates use `{% if X_team_badge_invert %}style="filter: invert(1);"{% endif %}` on each badge `<img>`.

Why this and not CSS: `mix-blend-mode: difference` over white correctly inverts white-on-transparent logos to black, but symmetrically *breaks* black-on-transparent logos (e.g. Spurs) by inverting them to invisible-white. Any single CSS transformation can only fix one polarity; per-pixel detection is the only universal fix.

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
- Returns a flat event object (see index.js `formatEvent`) when a game is found, including pre-localized `date_label`/`time_label`, the raw `start_utc_timestamp`, and the configured team's `team_name` (resolved by matching `idHomeTeam`/`idAwayTeam` against the URL's teamId) plus `team_league_label`.
- When no game is found, returns `{"found": false, "team_badge": <url|null>, "team_badge_invert": <bool>, "team_name": "...", "team_league_label": "...", "not_found_message": "..."}`. Team badge, name, and league are looked up via `/lookup/team/{id}` and cached 30 days under cache key `/_team-meta` (returned as a `{badge, name, idLeague, strLeague}` JSON blob — see `fetchTeamMeta`). `not_found_message` is the localized "No game found" string keyed off the locale's language code (`NOT_FOUND_MESSAGES` table; falls back to English).

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

- **Logo centering** — logos with varying amounts of transparent padding can make the `@` symbol appear off-center. See `0067 Claude diary 2026-03-29.md` for the plan (CSS-first, then weserv.nl trim proxy if needed).
- **League allowlist** — `SUPPORTED_LEAGUE_IDS` may be loosened in the future to allow any TheSportsDB team.
