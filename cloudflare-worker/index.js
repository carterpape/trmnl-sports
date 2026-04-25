import * as UPNG from 'upng-js';

const API_BASE = 'https://www.thesportsdb.com/api/v2/json';

// Supported league IDs (TheSportsDB internal IDs)
const SUPPORTED_LEAGUE_IDS = new Set([
  // North America
  4380, // NHL
  4387, // NBA
  4424, // MLB
  4516, // WNBA
  4521, // NWSL
  4607, // NCAA Men's Basketball
  5789, // NCAA Women's Basketball
  4391, // NFL
  4479, // NCAA Football (Division I)
  4346, // MLS
  4405, // CFL
  // Europe (soccer)
  4328, // English Premier League
  4335, // Spanish La Liga
  4331, // German Bundesliga
  4332, // Italian Serie A
  4334, // French Ligue 1
  // Australia
  4456, // AFL
  4416, // NRL
  // Cricket
  4460, // Indian Premier League
  4461, // Australian Big Bash League
]);

// Leagues that use a single calendar year as the season identifier
// (e.g. "2026"). All others use split-year format (e.g. "2025-2026").
// Note: TheSportsDB's choice doesn't always match a league's calendar
// shape — NFL plays Sep–Feb but is labeled by its starting year.
const SUMMER_LEAGUE_IDS = new Set([
  4424, // MLB
  4516, // WNBA
  4521, // NWSL
  4391, // NFL
  4479, // NCAA Football
  4346, // MLS
  4405, // CFL
  4456, // AFL
  4416, // NRL
  4460, // IPL
]);

// TheSportsDB's `strLeague` is sometimes wordy or ambiguous (e.g. "NCAA
// Division 1" doesn't say "Football"). Override the dropdown label for
// these to keep the team-search list scannable.
const LEAGUE_DISPLAY_NAMES = {
  4346: 'MLS',
  4521: 'NWSL',
  4479: 'NCAA Football',
  4607: "NCAA Men's Basketball",
  5789: "NCAA Women's Basketball",
  4416: 'NRL',
  4456: 'AFL',
  4461: 'Big Bash League',
};

const TEAMS_CACHE_TTL = 86400;    // 24h — search results are stable
const NEXT_GAME_CACHE_TTL = 600;  // 10 min — under TRMNL's 15-min poll interval

// TheSportsDB keeps recently-finished games in its "next events" response for
// some window. Treat a game as still upcoming until this long after kickoff,
// covering the longest expected game across supported leagues (MLB ~3h).
const UPCOMING_GRACE_MS = 4 * 60 * 60 * 1000;

// Cache the badge-invert decision per badge URL for a long time — team logos
// rarely change. Looked up via caches.default; recomputed on cache miss.
const BADGE_INVERT_CACHE_TTL = 30 * 86400; // 30 days

// Mean luminance threshold (0–255). Above this, a badge's visible pixels are
// considered "white-on-transparent" and templates should invert it so it
// renders as dark-on-white on e-ink.
const WHITE_BADGE_LUMA_THRESHOLD = 200;

function getCurrentSeason(leagueId) {
  const now = new Date();
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth() + 1; // 1–12

  if (SUMMER_LEAGUE_IDS.has(Number(leagueId))) {
    return String(year);
  }
  // Fall/winter/spring leagues: new season starts in August
  return month >= 8 ? `${year}-${year + 1}` : `${year - 1}-${year}`;
}

function jsonResponse(data, { status = 200, cors = false, maxAge = 0 } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (cors) headers['Access-Control-Allow-Origin'] = '*';
  if (maxAge > 0) headers['Cache-Control'] = `public, max-age=${maxAge}`;
  return new Response(JSON.stringify(data), { status, headers });
}

// TheSportsDB timestamps lack explicit timezone info; treat as UTC.
function toUtcTimestamp(strTimestamp) {
  if (!strTimestamp) return null;
  if (strTimestamp.includes('+') || strTimestamp.endsWith('Z')) return strTimestamp;
  return strTimestamp + '+00:00';
}

function formatEvent(event, { homeInvert, awayInvert }) {
  return {
    found: true,
    home_team: event.strHomeTeam,
    away_team: event.strAwayTeam,
    home_team_badge: event.strHomeTeamBadge,
    away_team_badge: event.strAwayTeamBadge,
    home_team_badge_invert: homeInvert,
    away_team_badge_invert: awayInvert,
    start_utc_timestamp: toUtcTimestamp(event.strTimestamp),
    venue: event.strVenue,
    league: event.strLeague,
    sport: event.strSport,
  };
}

// Decide whether a badge needs inversion to be visible on e-ink. White-on-
// transparent badges disappear after image-dither against the device's white
// background; we detect them by sampling the badge's pixels and measuring
// the mean luminance of opaque content. Decision is cached per badge URL.
async function shouldInvertBadge(url, hostname, ctx) {
  if (!url) return false;

  const key = buildCacheKey(hostname, '/_badge-invert', { url });
  const cached = await caches.default.match(key);
  if (cached) return (await cached.text()) === 'true';

  let invert = false;
  try {
    const res = await fetch(url);
    if (res.ok) {
      const buf = await res.arrayBuffer();
      const decoded = UPNG.decode(buf);
      const rgba = new Uint8Array(UPNG.toRGBA8(decoded)[0]);
      let visible = 0;
      let lumaSum = 0;
      for (let i = 0; i < rgba.length; i += 4) {
        if (rgba[i + 3] < 128) continue;
        // Rec. 709 luminance
        lumaSum += 0.2126 * rgba[i] + 0.7152 * rgba[i + 1] + 0.0722 * rgba[i + 2];
        visible++;
      }
      if (visible > 0 && lumaSum / visible > WHITE_BADGE_LUMA_THRESHOLD) {
        invert = true;
      }
    }
  } catch {
    // Decode failed (non-PNG, paletted edge case, etc.) — leave invert false.
  }

  const cacheResponse = new Response(String(invert), {
    headers: { 'Cache-Control': `public, max-age=${BADGE_INVERT_CACHE_TTL}` },
  });
  ctx.waitUntil(caches.default.put(key, cacheResponse.clone()));
  return invert;
}

function isUpcoming(event) {
  const ts = toUtcTimestamp(event.strTimestamp);
  if (ts) {
    const startMs = Date.parse(ts);
    if (!isNaN(startMs)) return startMs > Date.now() - UPCOMING_GRACE_MS;
  }
  // Fallback for events without a precise time: compare by date only.
  if (!event.dateEvent) return false;
  return event.dateEvent >= new Date().toISOString().slice(0, 10);
}

// Build a synthetic GET cache key under the worker's own hostname. This lets
// POST /teams (xhrSelectSearch) and any GET equivalents share the same cache
// entry for the same query, and canonicalizes params so cache hits don't
// depend on incidental URL ordering.
function buildCacheKey(workerHostname, path, params) {
  const search = new URLSearchParams(params).toString();
  return new Request(`https://${workerHostname}/_cache${path}?${search}`, { method: 'GET' });
}

// GET /teams?q=SEARCH_TERM  (or POST with JSON body { query: "..." })
// Returns teams matching the query, filtered to supported leagues,
// in TRMNL xhrSelectSearch format.
async function handleTeamsSearch(url, request, env, ctx) {
  let q = (url.searchParams.get('q') || '').trim();
  if (!q && request.method === 'POST') {
    try {
      const body = await request.json();
      q = (body.query || body.q || '').trim();
    } catch {}
  }
  if (q.length < 2) {
    return jsonResponse([], { cors: true });
  }

  const key = buildCacheKey(url.hostname, '/teams', { q: q.toLowerCase() });
  const cached = await caches.default.match(key);
  if (cached) return cached;

  const res = await fetch(
    `${API_BASE}/search/team/${encodeURIComponent(q)}`,
    { headers: { 'X-API-KEY': env.SPORTSDB_API_KEY } },
  );
  if (!res.ok) return jsonResponse([], { cors: true });

  const data = await res.json();
  const options = (data.search || [])
    .filter(team => SUPPORTED_LEAGUE_IDS.has(Number(team.idLeague)))
    .map(team => {
      const leagueLabel = LEAGUE_DISPLAY_NAMES[Number(team.idLeague)] || team.strLeague;
      return {
        id: `${team.idTeam}|${team.idLeague}`,
        name: `${team.strTeam} (${leagueLabel})`,
      };
    });

  const response = jsonResponse(options, { cors: true, maxAge: TEAMS_CACHE_TTL });
  ctx.waitUntil(caches.default.put(key, response.clone()));
  return response;
}

// GET /next-game?team=TEAM_ID|LEAGUE_ID&type=any|home|away
// Returns the next matching game for the given team, or { found: false }.
async function handleNextGame(url, env, ctx) {
  const teamParam = url.searchParams.get('team') || '';
  const type = url.searchParams.get('type') || 'any';

  const [teamId, leagueId] = teamParam.split('|');
  if (!teamId || !leagueId) {
    return jsonResponse({ found: false });
  }

  const key = buildCacheKey(url.hostname, '/next-game', { team: teamParam, type });
  const cached = await caches.default.match(key);
  if (cached) return cached;

  let upstreamOk = false;
  let event = null;

  if (type === 'any') {
    // Use the efficient "next events for team" endpoint
    const res = await fetch(
      `${API_BASE}/schedule/next/team/${teamId}`,
      { headers: { 'X-API-KEY': env.SPORTSDB_API_KEY } },
    );
    if (res.ok) {
      upstreamOk = true;
      const data = await res.json();
      event = data.schedule?.find(isUpcoming) || null;
    }
  } else {
    // For home/away filtering, fetch the full season schedule for the league
    const season = getCurrentSeason(leagueId);
    const res = await fetch(
      `${API_BASE}/schedule/league/${leagueId}/${season}`,
      { headers: { 'X-API-KEY': env.SPORTSDB_API_KEY } },
    );
    if (res.ok) {
      upstreamOk = true;
      const data = await res.json();
      const matching = (data.schedule || [])
        .filter(e => {
          if (!isUpcoming(e)) return false;
          if (type === 'home') return String(e.idHomeTeam) === String(teamId);
          if (type === 'away') return String(e.idAwayTeam) === String(teamId);
          return false;
        })
        .sort((a, b) =>
          a.dateEvent.localeCompare(b.dateEvent) ||
          (a.strTime || '').localeCompare(b.strTime || ''),
        );
      event = matching[0] || null;
    }
  }

  // Don't cache upstream failures — let the next request retry immediately.
  if (!upstreamOk) return jsonResponse({ found: false });

  let payload;
  if (event) {
    const [homeInvert, awayInvert] = await Promise.all([
      shouldInvertBadge(event.strHomeTeamBadge, url.hostname, ctx),
      shouldInvertBadge(event.strAwayTeamBadge, url.hostname, ctx),
    ]);
    payload = formatEvent(event, { homeInvert, awayInvert });
  } else {
    payload = { found: false };
  }

  const response = jsonResponse(payload, { maxAge: NEXT_GAME_CACHE_TTL });
  ctx.waitUntil(caches.default.put(key, response.clone()));
  return response;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const isTeamsSearch = url.pathname === '/teams';

    if (request.method === 'OPTIONS') {
      // Only /teams is browser-fetched (xhrSelectSearch); /next-game is
      // server-polled by TRMNL, so it never preflights.
      if (isTeamsSearch) {
        return new Response(null, {
          headers: {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type',
          },
        });
      }
      return new Response(null, { status: 405 });
    }

    const ip = request.headers.get('CF-Connecting-IP') ?? 'unknown';
    const { success } = await env.RATE_LIMITER.limit({ key: ip });
    if (!success) {
      return jsonResponse({ error: 'Too many requests' }, {
        status: 429,
        cors: isTeamsSearch,
      });
    }

    if (isTeamsSearch) return handleTeamsSearch(url, request, env, ctx);
    if (url.pathname === '/next-game') return handleNextGame(url, env, ctx);

    return new Response('Not found', { status: 404 });
  },
};
