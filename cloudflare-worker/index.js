import * as UPNG from "upng-js";

const API_BASE = "https://www.thesportsdb.com/api/v2/json";

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

// TheSportsDB's `strLeague` is sometimes wordy or ambiguous (e.g. "NCAA
// Division 1" doesn't say "Football"). Override the dropdown label for
// these to keep the team-search list scannable.
const LEAGUE_DISPLAY_NAMES = {
    4346: "MLS",
    4521: "NWSL",
    4479: "NCAA Football",
    4607: "NCAA Men's Basketball",
    5789: "NCAA Women's Basketball",
    4416: "NRL",
    4456: "AFL",
    4461: "Big Bash League",
};

const TEAMS_CACHE_TTL = 86400; // 24h — per-query search response cache
const TEAM_INDEX_CACHE_TTL = 86400; // 24h — full team list across supported leagues
const NEXT_GAME_CACHE_TTL = 600; // 10 min — under TRMNL's 15-min poll interval
const MAX_SEARCH_RESULTS = 20;

// TheSportsDB keeps recently-finished games in its "next events" response for
// some window. Treat a game as still upcoming until this long after kickoff,
// covering the longest expected game across supported leagues (MLB ~3h).
const UPCOMING_GRACE_MS = 4 * 60 * 60 * 1000;

// Cache the badge-invert decision per badge URL for a long time — team logos
// rarely change. Looked up via caches.default; recomputed on cache miss.
const BADGE_INVERT_CACHE_TTL = 30 * 86400; // 30 days

// Cache the team metadata lookup separately from the not-found response so
// that many not-found responses share a single team lookup.
const TEAM_META_CACHE_TTL = 30 * 86400; // 30 days

// Mean luminance threshold (0–255). Above this, a badge's visible pixels are
// considered "white-on-transparent" and templates should invert it so it
// renders as dark-on-white on e-ink.
const WHITE_BADGE_LUMA_THRESHOLD = 200;

// Localized "no game found" copy keyed by language code (the part of an IETF
// locale tag before the first hyphen). Falls back to English. Templates render
// the localized string directly via {{ not_found_message }}.
const NOT_FOUND_MESSAGES = {
    en: "No game found",
    es: "Sin partido",
    de: "Kein Spiel",
    fr: "Aucun match",
    it: "Nessuna partita",
    pt: "Sem jogo",
    nl: "Geen wedstrijd",
    sv: "Ingen match",
    da: "Ingen kamp",
    no: "Ingen kamp",
    fi: "Ei ottelua",
    pl: "Brak meczu",
    ru: "Нет матчей",
    ja: "試合なし",
    ko: "경기 없음",
    zh: "无比赛",
};

// Validate a locale tag, falling back when missing or unparseable. Catches
// local-preview placeholders like the literal string "{{ trmnl.user.locale }}"
// that arrive verbatim when trmnlp doesn't interpolate trmnl.* into URLs.
function parseLocale(raw) {
    if (!raw || raw.includes("{{")) return "en-US";
    try {
        new Intl.Locale(raw);
        return raw;
    } catch {
        return "en-US";
    }
}

// Validate an IANA time-zone string, falling back to UTC when missing or
// unparseable. Same {{...}} guard as parseLocale.
function parseTimeZone(raw) {
    if (!raw || raw.includes("{{")) return "UTC";
    try {
        new Intl.DateTimeFormat("en-US", { timeZone: raw });
        return raw;
    } catch {
        return "UTC";
    }
}

function notFoundMessage(locale) {
    const lang = locale.split("-")[0].toLowerCase();
    return NOT_FOUND_MESSAGES[lang] || NOT_FOUND_MESSAGES.en;
}

// Capitalize the first character with locale-aware case mapping. Used to make
// Intl.RelativeTimeFormat output ("today", "heute", "今日") render as a leading
// capital where the locale supports it; locales with no case (Japanese, etc.)
// pass through unchanged.
function capitalizeFirst(s, locale) {
    if (!s) return s;
    return s.charAt(0).toLocaleUpperCase(locale) + s.slice(1);
}

// Returns the calendar date in the given IANA time zone, formatted YYYY-MM-DD.
// Used to compare game day vs. today/tomorrow without DST or offset math.
function ymdInZone(date, tz) {
    return new Intl.DateTimeFormat("en-CA", {
        timeZone: tz,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
    }).format(date);
}

function localizeDateLabel(gameMs, locale, tz) {
    const now = new Date();
    const todayYmd = ymdInZone(now, tz);
    const tomorrowYmd = ymdInZone(new Date(now.getTime() + 86400000), tz);
    const gameYmd = ymdInZone(new Date(gameMs), tz);

    if (gameYmd === todayYmd || gameYmd === tomorrowYmd) {
        const offset = gameYmd === todayYmd ? 0 : 1;
        try {
            const rtf = new Intl.RelativeTimeFormat(locale, {
                numeric: "auto",
            });
            return capitalizeFirst(rtf.format(offset, "day"), locale);
        } catch {
            return offset === 0 ? "Today" : "Tomorrow";
        }
    }

    return new Intl.DateTimeFormat(locale, {
        timeZone: tz,
        weekday: "long",
        month: "short",
        day: "numeric",
    }).format(new Date(gameMs));
}

function localizeTimeLabel(gameMs, locale, tz) {
    let timeStr = new Intl.DateTimeFormat(locale, {
        timeZone: tz,
        hour: "numeric",
        minute: "2-digit",
    }).format(new Date(gameMs));

    // AP-style lowercase periods for English locales; other locales' native
    // formats (typically 24h) pass through untouched.
    if (locale.toLowerCase().startsWith("en")) {
        timeStr = timeStr.replace(/\bAM\b/g, "a.m.").replace(/\bPM\b/g, "p.m.");
    }
    return timeStr;
}

function jsonResponse(data, { status = 200, cors = false, maxAge = 0 } = {}) {
    const headers = { "Content-Type": "application/json" };
    if (cors) headers["Access-Control-Allow-Origin"] = "*";
    if (maxAge > 0) headers["Cache-Control"] = `public, max-age=${maxAge}`;
    return new Response(JSON.stringify(data), { status, headers });
}

// TheSportsDB timestamps lack explicit timezone info; treat as UTC.
function toUtcTimestamp(strTimestamp) {
    if (!strTimestamp) return null;
    if (strTimestamp.includes("+") || strTimestamp.endsWith("Z"))
        return strTimestamp;
    return strTimestamp + "+00:00";
}

function formatEvent(
    event,
    { homeInvert, awayInvert, locale, tz, teamId, teamLeagueLabel },
) {
    const utcTimestamp = toUtcTimestamp(event.strTimestamp);
    const gameMs = utcTimestamp ? Date.parse(utcTimestamp) : NaN;
    const haveTime = !isNaN(gameMs);
    const isHome = String(event.idHomeTeam) === String(teamId);
    const teamName = isHome ? event.strHomeTeam : event.strAwayTeam;
    return {
        found: true,
        home_team: event.strHomeTeam,
        away_team: event.strAwayTeam,
        home_team_badge: event.strHomeTeamBadge,
        away_team_badge: event.strAwayTeamBadge,
        home_team_badge_invert: homeInvert,
        away_team_badge_invert: awayInvert,
        start_utc_timestamp: utcTimestamp,
        date_label: haveTime ? localizeDateLabel(gameMs, locale, tz) : "",
        time_label: haveTime ? localizeTimeLabel(gameMs, locale, tz) : "",
        venue: event.strVenue,
        league: event.strLeague,
        sport: event.strSport,
        team_name: teamName || "",
        team_league_label: teamLeagueLabel || event.strLeague || "",
    };
}

// Decide whether a badge needs inversion to be visible on e-ink. White-on-
// transparent badges disappear after image-dither against the device's white
// background; we detect them by sampling the badge's pixels and measuring
// the mean luminance of opaque content. Decision is cached per badge URL.
async function shouldInvertBadge(url, hostname, ctx) {
    if (!url) return false;

    const key = buildCacheKey(hostname, "/_badge-invert", { url });
    const cached = await caches.default.match(key);
    if (cached) return (await cached.text()) === "true";

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
                lumaSum +=
                    0.2126 * rgba[i] +
                    0.7152 * rgba[i + 1] +
                    0.0722 * rgba[i + 2];
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
        headers: {
            "Cache-Control": `public, max-age=${BADGE_INVERT_CACHE_TTL}`,
        },
    });
    ctx.waitUntil(caches.default.put(key, cacheResponse.clone()));
    return invert;
}

// Look up a team's badge, name, and league by team ID. Used to populate the
// not-found response (so the layout can still show the configured team's
// logo and name) and to fall back when the URL doesn't supply a league ID.
// Cached per team ID for 30 days; team metadata changes rarely.
async function fetchTeamMeta(teamId, env, hostname, ctx) {
    const empty = { badge: null, name: null, idLeague: null, strLeague: null };
    if (!teamId) return empty;

    const key = buildCacheKey(hostname, "/_team-meta", { teamId });
    const cached = await caches.default.match(key);
    if (cached) return await cached.json();

    let meta = empty;
    try {
        const res = await fetch(`${API_BASE}/lookup/team/${teamId}`, {
            headers: { "X-API-KEY": env.SPORTSDB_API_KEY },
        });
        if (res.ok) {
            const data = await res.json();
            const team = data.lookup?.[0] || data.teams?.[0];
            if (team) {
                meta = {
                    badge: team.strBadge || null,
                    name: team.strTeam || null,
                    idLeague: team.idLeague ? Number(team.idLeague) : null,
                    strLeague: team.strLeague || null,
                };
            }
        }
    } catch {
        // Lookup failed — fall through with the empty meta.
    }

    // Cache the result either way so failures don't refetch repeatedly.
    const cacheResponse = new Response(JSON.stringify(meta), {
        headers: {
            "Content-Type": "application/json",
            "Cache-Control": `public, max-age=${TEAM_META_CACHE_TTL}`,
        },
    });
    ctx.waitUntil(caches.default.put(key, cacheResponse.clone()));
    return meta;
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
    return new Request(`https://${workerHostname}/_cache${path}?${search}`, {
        method: "GET",
    });
}

// Fetch and cache the full team index across all supported leagues. SportsDB's
// /search/team/ only matches city/team-name prefix — typing "Bulls" won't find
// Chicago Bulls. We work around this by maintaining a local index of every
// supported team and doing substring matching against it.
//
// Side benefit: per-keystroke fan-out to SportsDB disappears. After warmup,
// each Cloudflare POP only refreshes the index ~21 times per 24h.
async function getTeamIndex(env, hostname, ctx) {
    const key = buildCacheKey(hostname, "/_team-index", {});
    const cached = await caches.default.match(key);
    if (cached) return await cached.json();

    const leagueIds = [...SUPPORTED_LEAGUE_IDS];
    const results = await Promise.allSettled(
        leagueIds.map((id) =>
            fetch(`${API_BASE}/list/teams/${id}`, {
                headers: { "X-API-KEY": env.SPORTSDB_API_KEY },
            }).then((r) => (r.ok ? r.json() : null)),
        ),
    );

    const index = [];
    let anySucceeded = false;
    results.forEach((result, i) => {
        const id = leagueIds[i];
        if (result.status !== "fulfilled" || !result.value) return;
        const teams = result.value.list || result.value.teams || [];
        if (teams.length === 0) return;
        anySucceeded = true;
        const leagueLabel =
            LEAGUE_DISPLAY_NAMES[id] || teams[0].strLeague || "";
        for (const team of teams) {
            const strTeam = team.strTeam || "";
            const strTeamAlternate = team.strTeamAlternate || "";
            const strKeywords = team.strKeywords || "";
            index.push({
                idTeam: team.idTeam,
                idLeague: team.idLeague,
                strTeam,
                leagueLabel,
                searchBlob:
                    `${strTeam} | ${strTeamAlternate} | ${strKeywords}`.toLowerCase(),
            });
        }
    });

    // If every league failed, don't poison the cache with an empty index.
    if (!anySucceeded) return [];

    const cacheResponse = new Response(JSON.stringify(index), {
        headers: {
            "Content-Type": "application/json",
            "Cache-Control": `public, max-age=${TEAM_INDEX_CACHE_TTL}`,
        },
    });
    ctx.waitUntil(caches.default.put(key, cacheResponse.clone()));
    return index;
}

// Rank a match: 0 = team name starts with query, 1 = any whitespace token in
// team name starts with query (catches "Bulls" → "Chicago Bulls"), 2 = match
// only via substring or alternate/keyword fields.
function matchRank(team, q) {
    const name = team.strTeam.toLowerCase();
    if (name.startsWith(q)) return 0;
    for (const token of name.split(/\s+/)) {
        if (token.startsWith(q)) return 1;
    }
    return 2;
}

// GET /teams?q=SEARCH_TERM  (or POST with JSON body { query: "..." })
// Returns teams matching the query, filtered to supported leagues,
// in TRMNL xhrSelectSearch format. Matches against team name, alternate name,
// and keywords via the cached team index — no upstream call per request.
async function handleTeamsSearch(url, request, env, ctx) {
    let qRaw = (url.searchParams.get("q") || "").trim();
    if (!qRaw && request.method === "POST") {
        try {
            const body = await request.json();
            qRaw = (body.query || body.q || "").trim();
        } catch {}
    }
    if (qRaw.length < 2) {
        return jsonResponse([], { cors: true });
    }
    const q = qRaw.toLowerCase();

    const key = buildCacheKey(url.hostname, "/teams", { q });
    const cached = await caches.default.match(key);
    if (cached) return cached;

    const index = await getTeamIndex(env, url.hostname, ctx);
    const matches = index
        .filter((t) => t.searchBlob.includes(q))
        .map((t) => ({ team: t, rank: matchRank(t, q) }))
        .sort(
            (a, b) =>
                a.rank - b.rank || a.team.strTeam.localeCompare(b.team.strTeam),
        )
        .slice(0, MAX_SEARCH_RESULTS)
        .map(({ team }) => ({
            id: `${team.idTeam}|${team.idLeague}`,
            name: `${team.strTeam} (${team.leagueLabel})`,
        }));

    const response = jsonResponse(matches, {
        cors: true,
        maxAge: TEAMS_CACHE_TTL,
    });
    ctx.waitUntil(caches.default.put(key, response.clone()));
    return response;
}

// GET /next-game?team=TEAM_ID|LEAGUE_ID&type=any|home|away
// Returns the next matching game for the given team, or { found: false }.
//
// All three filters use /schedule/full/team/{id}, which returns the team's
// full current-season schedule (~250-event cap) across every competition
// they're entered in — including cup and continental fixtures. Home/away
// filtering is done locally so cross-league matches stay visible regardless
// of filter, and we can find the next home/away match anywhere in the
// season rather than just within the next handful of events.
async function handleNextGame(url, env, ctx) {
    const teamParam = url.searchParams.get("team") || "";
    const type = url.searchParams.get("type") || "any";
    const locale = parseLocale(url.searchParams.get("locale"));
    const tz = parseTimeZone(url.searchParams.get("tz"));

    // The leagueId half drives the league display label in the title bar so it
    // stays consistent with the dropdown (and with the team's home league, not
    // the league of the next match — cup fixtures shouldn't change the label).
    const [teamId, leagueIdRaw] = teamParam.split("|");
    const leagueIdFromUrl = leagueIdRaw ? Number(leagueIdRaw) : null;
    if (!teamId) {
        return jsonResponse({
            found: false,
            not_found_message: notFoundMessage(locale),
        });
    }

    const key = buildCacheKey(url.hostname, "/next-game", {
        team: teamParam,
        type,
        locale,
        tz,
    });
    const cached = await caches.default.match(key);
    if (cached) return cached;

    const res = await fetch(`${API_BASE}/schedule/full/team/${teamId}`, {
        headers: { "X-API-KEY": env.SPORTSDB_API_KEY },
    });
    // Don't cache upstream failures — let the next request retry immediately.
    if (!res.ok) {
        return jsonResponse({
            found: false,
            not_found_message: notFoundMessage(locale),
        });
    }

    const data = await res.json();
    // /schedule/full/team is not chronologically ordered — sort ascending so
    // .find() picks the soonest matching event.
    const upcoming = (data.schedule || [])
        .filter(isUpcoming)
        .sort(
            (a, b) =>
                (a.dateEvent || "").localeCompare(b.dateEvent || "") ||
                (a.strTime || "").localeCompare(b.strTime || ""),
        );
    const event =
        upcoming.find((e) => {
            if (type === "home") return String(e.idHomeTeam) === String(teamId);
            if (type === "away") return String(e.idAwayTeam) === String(teamId);
            return true;
        }) || null;

    // Resolve the team's home-league display label. Prefer the URL's leagueId
    // (which TRMNL stores when the user picks the team from the dropdown). Fall
    // back to a one-time team-meta lookup for legacy settings without it.
    let teamLeagueLabel = LEAGUE_DISPLAY_NAMES[leagueIdFromUrl] || "";
    let teamMeta = null;
    if (!teamLeagueLabel || !event) {
        teamMeta = await fetchTeamMeta(teamId, env, url.hostname, ctx);
        if (!teamLeagueLabel) {
            teamLeagueLabel =
                LEAGUE_DISPLAY_NAMES[teamMeta.idLeague] ||
                teamMeta.strLeague ||
                "";
        }
    }

    let payload;
    if (event) {
        const [homeInvert, awayInvert] = await Promise.all([
            shouldInvertBadge(event.strHomeTeamBadge, url.hostname, ctx),
            shouldInvertBadge(event.strAwayTeamBadge, url.hostname, ctx),
        ]);
        payload = formatEvent(event, {
            homeInvert,
            awayInvert,
            locale,
            tz,
            teamId,
            teamLeagueLabel,
        });
    } else {
        const invert = teamMeta.badge
            ? await shouldInvertBadge(teamMeta.badge, url.hostname, ctx)
            : false;
        payload = {
            found: false,
            team_badge: teamMeta.badge,
            team_badge_invert: invert,
            team_name: teamMeta.name || "",
            team_league_label: teamLeagueLabel,
            not_found_message: notFoundMessage(locale),
        };
    }

    const response = jsonResponse(payload, { maxAge: NEXT_GAME_CACHE_TTL });
    ctx.waitUntil(caches.default.put(key, response.clone()));
    return response;
}

export default {
    async fetch(request, env, ctx) {
        const url = new URL(request.url);
        const isTeamsSearch = url.pathname === "/teams";

        if (request.method === "OPTIONS") {
            // Only /teams is browser-fetched (xhrSelectSearch); /next-game is
            // server-polled by TRMNL, so it never preflights.
            if (isTeamsSearch) {
                return new Response(null, {
                    headers: {
                        "Access-Control-Allow-Origin": "*",
                        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
                        "Access-Control-Allow-Headers": "Content-Type",
                    },
                });
            }
            return new Response(null, { status: 405 });
        }

        const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
        const { success } = await env.RATE_LIMITER.limit({ key: ip });
        if (!success) {
            return jsonResponse(
                { error: "Too many requests" },
                {
                    status: 429,
                    cors: isTeamsSearch,
                },
            );
        }

        if (isTeamsSearch) return handleTeamsSearch(url, request, env, ctx);
        if (url.pathname === "/next-game") return handleNextGame(url, env, ctx);

        return new Response("Not found", { status: 404 });
    },
};
