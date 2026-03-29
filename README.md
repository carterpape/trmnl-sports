# Sports — Team's Next Game (TRMNL Plugin)

A [TRMNL](https://usetrmnl.com) plugin that shows your team's next scheduled game across major North American sports leagues.

![Plugin preview](preview.png)

## Supported leagues

- NHL
- NBA
- MLB
- NCAA Men's Basketball
- NCAA Women's Basketball
- WNBA
- NWSL

## Setup

1. Add the plugin to your TRMNL device.
2. In the plugin settings, type a city name or team name prefix in the **Team** field and select your team from the dropdown.
3. Choose a **Game Filter**: any next game, next home game, or next away game.

> **Tip:** Search by city name or full team name prefix — e.g. "Chicago" or "Golden State". Searching by nickname alone (e.g. "Bulls" or "Warriors") will not return results due to how TheSportsDB's search works.

## Cloudflare Worker

The plugin is backed by a Cloudflare Worker at `trmnl-sports.carter-pape.workers.dev` that proxies [TheSportsDB v2 API](https://www.thesportsdb.com). The Worker handles team search and schedule lookups; no API key is required from plugin users.

### Running your own Worker

If you'd prefer to self-host:

1. Get a [TheSportsDB](https://www.thesportsdb.com) API key (Patreon tier required for v2).
2. Install [Wrangler](https://developers.cloudflare.com/workers/wrangler/): `npm install -g wrangler`
3. Deploy:
   ```bash
   cd cloudflare-worker
   wrangler secret put SPORTSDB_API_KEY
   npx wrangler deploy
   ```
4. Update `polling_url` and the `endpoint` in `src/settings.yml` to point to your Worker URL.

## Known limitations

- Game times are displayed in your local timezone as configured on your TRMNL device.
- The plugin shows one upcoming game at a time.
- Only the seven leagues listed above are supported.

## License

[GNU General Public License v3.0](LICENSE)
