const API_BASE = 'https://www.thesportsdb.com/api/v2/json';

// Supported league IDs (TheSportsDB internal IDs)
const SUPPORTED_LEAGUE_IDS = new Set([
  4380, // NHL
  4387, // NBA
  4424, // MLB
  4607, // NCAA Men's Basketball
  5789, // NCAA Women's Basketball
  4516, // WNBA
  4521, // NWSL
]);

// These leagues use a single calendar year as the season identifier;
// all others use split-year format (e.g. "2025-2026").
const SUMMER_LEAGUE_IDS = new Set([
  4424, // MLB
  4516, // WNBA
  4521, // NWSL
]);

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

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    },
  });
}

// TheSportsDB timestamps lack explicit timezone info; treat as UTC.
function toUtcTimestamp(strTimestamp) {
  if (!strTimestamp) return null;
  if (strTimestamp.includes('+') || strTimestamp.endsWith('Z')) return strTimestamp;
  return strTimestamp + '+00:00';
}

function formatEvent(event) {
  return {
    found: true,
    home_team: event.strHomeTeam,
    away_team: event.strAwayTeam,
    home_team_badge: event.strHomeTeamBadge,
    away_team_badge: event.strAwayTeamBadge,
    start_utc_timestamp: toUtcTimestamp(event.strTimestamp),
    venue: event.strVenue,
    league: event.strLeague,
    sport: event.strSport,
  };
}

// GET /teams?q=SEARCH_TERM  (or POST with JSON body { q: "..." })
// Returns teams matching the query, filtered to supported leagues,
// in TRMNL xhrSelectSearch format.
async function handleTeamsSearch(url, request, env) {
  let q = (url.searchParams.get('q') || '').trim();
  if (!q && request.method === 'POST') {
    try {
      const body = await request.json();
      q = (body.query || body.q || '').trim();
    } catch {}
  }
  if (q.length < 2) {
    return jsonResponse([]);
  }

  const res = await fetch(
    `${API_BASE}/search/team/${encodeURIComponent(q)}`,
    { headers: { 'X-API-KEY': env.SPORTSDB_API_KEY } }
  );
  if (!res.ok) return jsonResponse([]);

  const data = await res.json();
  if (!data.search) return jsonResponse([]);

  const options = data.search
    .filter(team => SUPPORTED_LEAGUE_IDS.has(Number(team.idLeague)))
    .map(team => ({
      id: `${team.idTeam}|${team.idLeague}`,
      name: `${team.strTeam} (${team.strLeague})`,
    }));

  return jsonResponse(options);
}

// GET /next-game?team=TEAM_ID|LEAGUE_ID&type=any|home|away
// Returns the next matching game for the given team, or { found: false }.
async function handleNextGame(url, env) {
  const teamParam = url.searchParams.get('team') || '';
  const type = url.searchParams.get('type') || 'any';

  const [teamId, leagueId] = teamParam.split('|');
  if (!teamId || !leagueId) {
    return jsonResponse({ found: false });
  }

  if (type === 'any') {
    // Use the efficient "next events for team" endpoint
    const res = await fetch(
      `${API_BASE}/schedule/next/team/${teamId}`,
      { headers: { 'X-API-KEY': env.SPORTSDB_API_KEY } }
    );
    if (!res.ok) return jsonResponse({ found: false });

    const data = await res.json();
    const event = data.schedule?.[0];
    return jsonResponse(event ? formatEvent(event) : { found: false });
  }

  // For home/away filtering, fetch the full season schedule for the league
  const season = getCurrentSeason(leagueId);
  const res = await fetch(
    `${API_BASE}/schedule/league/${leagueId}/${season}`,
    { headers: { 'X-API-KEY': env.SPORTSDB_API_KEY } }
  );
  if (!res.ok) return jsonResponse({ found: false });

  const data = await res.json();
  if (!data.schedule) return jsonResponse({ found: false });

  const today = new Date().toISOString().slice(0, 10); // "YYYY-MM-DD"

  const matching = data.schedule
    .filter(e => {
      if (!e.dateEvent || e.dateEvent < today) return false;
      if (type === 'home') return String(e.idHomeTeam) === String(teamId);
      if (type === 'away') return String(e.idAwayTeam) === String(teamId);
      return false;
    })
    .sort((a, b) =>
      a.dateEvent.localeCompare(b.dateEvent) ||
      (a.strTime || '').localeCompare(b.strTime || '')
    );

  const event = matching[0];
  return jsonResponse(event ? formatEvent(event) : { found: false });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
        },
      });
    }

    const ip = request.headers.get('CF-Connecting-IP') ?? 'unknown';
    const { success } = await env.RATE_LIMITER.limit({ key: ip });
    if (!success) {
      return jsonResponse({ error: 'Too many requests' }, 429);
    }

    if (url.pathname === '/teams') return handleTeamsSearch(url, request, env);
    if (url.pathname === '/next-game') return handleNextGame(url, env);

    return new Response('Not found', { status: 404 });
  },
};
