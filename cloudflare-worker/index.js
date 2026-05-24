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
// How long the durable /next-game entry survives so it can be served as
// last-known-good during an upstream outage. The *outgoing* freshness is still
// NEXT_GAME_CACHE_TTL — the worker reads X-Fetched-At to decide fresh vs. stale,
// independent of this much-longer storage TTL.
const LKG_CACHE_TTL = 7 * 86400; // 7 days
const MAX_SEARCH_RESULTS = 20;

// TheSportsDB keeps recently-finished games in its "next events" response for
// some window. Treat a game as still upcoming until this long after kickoff,
// covering the longest expected game across supported leagues (MLB ~3h).
const UPCOMING_GRACE_MS = 4 * 60 * 60 * 1000;

// Cache the per-badge analysis (invert decision + content bounding box) per
// badge URL for a long time — team logos rarely change. Looked up via
// caches.default; recomputed on cache miss.
const BADGE_ANALYSIS_CACHE_TTL = 30 * 86400; // 30 days

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

// Localized "can't reach the data source" copy, keyed like NOT_FOUND_MESSAGES.
// Shown only when upstream is down AND there's no usable last-known-good to fall
// back on — distinct from the genuine "no game found" so an outage doesn't read
// as a finished season. Good-faith translations; review with a native speaker.
const OUTAGE_MESSAGES = {
    en: "Schedule unavailable",
    es: "Calendario no disponible",
    de: "Spielplan nicht verfügbar",
    fr: "Calendrier indisponible",
    it: "Calendario non disponibile",
    pt: "Calendário indisponível",
    nl: "Schema niet beschikbaar",
    sv: "Schema ej tillgängligt",
    da: "Plan utilgængelig",
    no: "Plan utilgjengelig",
    fi: "Aikataulu ei käytettävissä",
    pl: "Harmonogram niedostępny",
    ru: "Расписание недоступно",
    ja: "日程を取得できません",
    ko: "일정을 불러올 수 없음",
    zh: "无法获取赛程",
};

// "as of <time>" affixes for the staleness marker, keyed like NOT_FOUND_MESSAGES.
// `pre`/`post` place the marker around the localized timestamp — most languages
// prefix it; Japanese/Korean suffix it (e.g. "19:00現在", "오후 7시 기준").
// Good-faith translations; review with a native speaker.
const AS_OF_AFFIXES = {
    en: { pre: "as of " },
    es: { pre: "a las " },
    de: { pre: "Stand " },
    fr: { pre: "à " },
    it: { pre: "alle " },
    pt: { pre: "às " },
    nl: { pre: "vanaf " },
    sv: { pre: "kl. " },
    da: { pre: "kl. " },
    no: { pre: "kl. " },
    fi: { pre: "klo " },
    pl: { pre: "stan na " },
    ru: { pre: "на " },
    ja: { post: "現在" },
    ko: { post: " 기준" },
    zh: { pre: "截至 " },
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

function outageMessage(locale) {
    const lang = locale.split("-")[0].toLowerCase();
    return OUTAGE_MESSAGES[lang] || OUTAGE_MESSAGES.en;
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

// "as of <time>" staleness marker for a last-known-good screen served during an
// outage. Reuses localizeTimeLabel so the time format matches the live labels.
// When the cached data was fetched on an earlier calendar day (in the user's
// zone), prepend a compact date so a multi-day-old fetch doesn't read as today.
function asOfLabel(fetchedAtMs, locale, tz) {
    const lang = locale.split("-")[0].toLowerCase();
    const affix = AS_OF_AFFIXES[lang] || AS_OF_AFFIXES.en;
    let stamp = localizeTimeLabel(fetchedAtMs, locale, tz);
    const fetched = new Date(fetchedAtMs);
    if (ymdInZone(fetched, tz) !== ymdInZone(new Date(), tz)) {
        const date = new Intl.DateTimeFormat(locale, {
            timeZone: tz,
            month: "short",
            day: "numeric",
        }).format(fetched);
        stamp = `${date} ${stamp}`;
    }
    return `${affix.pre || ""}${stamp}${affix.post || ""}`;
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
    {
        homeInvert,
        awayInvert,
        homeTrim,
        awayTrim,
        locale,
        tz,
        teamId,
        teamLeagueLabel,
    },
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
        home_team_badge_trim: homeTrim,
        away_team_badge_trim: awayTrim,
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

// The neutral badge analysis: no inversion, no trim (full-canvas bbox). Used
// whenever a badge can't be fetched/decoded, so templates can always rely on a
// trim being present and fall back to today's untrimmed rendering.
const NO_BADGE_TRIM = { x: 0, y: 0, w: 1, h: 1 };

// Single pixel pass over a decoded badge. Computes two things at once:
//   • invert — mean Rec. 709 luminance of opaque pixels exceeds the white
//     threshold (white-on-transparent logos disappear after image-dither
//     against the device's white background, so templates invert them).
//   • trim — the opaque content's bounding box, as canvas fractions, so
//     templates can clip the transparent padding and center the marks at any
//     render size.
function computeBadgeStats(rgba, width, height) {
    let visible = 0;
    let lumaSum = 0;
    let minX = width;
    let minY = height;
    let maxX = -1;
    let maxY = -1;
    for (let i = 0; i < rgba.length; i += 4) {
        if (rgba[i + 3] < 128) continue;
        lumaSum +=
            0.2126 * rgba[i] + 0.7152 * rgba[i + 1] + 0.0722 * rgba[i + 2];
        visible++;
        const p = i / 4;
        const x = p % width;
        const y = (p / width) | 0;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
    }
    if (visible === 0) return { invert: false, trim: NO_BADGE_TRIM };
    const round = (n) => Math.round(n * 1e4) / 1e4;
    return {
        invert: lumaSum / visible > WHITE_BADGE_LUMA_THRESHOLD,
        trim: {
            x: round(minX / width),
            y: round(minY / height),
            w: round((maxX - minX + 1) / width),
            h: round((maxY - minY + 1) / height),
        },
    };
}

// Analyze a badge for e-ink rendering: { invert, trim } (see computeBadgeStats).
// Cached per badge URL as JSON.
async function analyzeBadge(url, hostname, ctx) {
    if (!url) return { invert: false, trim: NO_BADGE_TRIM };

    const key = buildCacheKey(hostname, "/_badge-analysis", { url });
    const cached = await caches.default.match(key);
    if (cached) {
        try {
            return JSON.parse(await cached.text());
        } catch {
            // Unexpected cache shape (e.g. legacy boolean) — recompute below.
        }
    }

    let result = { invert: false, trim: NO_BADGE_TRIM };
    try {
        const res = await fetch(url);
        if (res.ok) {
            const buf = await res.arrayBuffer();
            const decoded = UPNG.decode(buf);
            const rgba = new Uint8Array(UPNG.toRGBA8(decoded)[0]);
            result = computeBadgeStats(rgba, decoded.width, decoded.height);
        }
    } catch {
        // Decode failed (non-PNG, paletted edge case, etc.) — leave neutral.
    }

    const cacheResponse = new Response(JSON.stringify(result), {
        headers: {
            "Cache-Control": `public, max-age=${BADGE_ANALYSIS_CACHE_TTL}`,
        },
    });
    ctx.waitUntil(caches.default.put(key, cacheResponse.clone()));
    return result;
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

// Is a UTC timestamp string still "upcoming" — at or before UPCOMING_GRACE_MS
// after kickoff? Shared by the schedule filter (isUpcoming) and the stale
// last-known-good guard, so both use one definition of "still worth showing".
// Returns false for a missing/unparseable timestamp.
function isTimestampUpcoming(utcTimestamp) {
    if (!utcTimestamp) return false;
    const startMs = Date.parse(utcTimestamp);
    if (isNaN(startMs)) return false;
    return startMs > Date.now() - UPCOMING_GRACE_MS;
}

function isUpcoming(event) {
    const ts = toUtcTimestamp(event.strTimestamp);
    if (ts && !isNaN(Date.parse(ts))) return isTimestampUpcoming(ts);
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
async function getTeamIndex(env, hostname, ctx, m) {
    const key = buildCacheKey(hostname, "/_team-index", {});
    const cached = await caches.default.match(key);
    // Index warm — m.cache stays "miss" (cheap recompute, no fan-out).
    if (cached) return await cached.json();

    // This request pays the full ~20-call SportsDB fan-out to rebuild the index.
    m.cache = "rebuild";

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
    let failures = 0;
    results.forEach((result, i) => {
        const id = leagueIds[i];
        // A call failed if it threw or returned non-OK (mapped to null above).
        if (result.status !== "fulfilled" || !result.value) {
            failures++;
            return;
        }
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

    m.upstreamCalls = leagueIds.length;
    m.upstreamFails = failures;
    if (failures === 0) m.upstream = "ok";
    else if (failures < leagueIds.length) m.upstream = "partial";
    else m.upstream = "fail";

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
async function handleTeamsSearch(url, request, env, ctx, m) {
    let qRaw = (url.searchParams.get("q") || "").trim();
    if (!qRaw && request.method === "POST") {
        try {
            const body = await request.json();
            qRaw = (body.query || body.q || "").trim();
        } catch {}
    }
    if (qRaw.length < 2) {
        m.outcome = "short_query";
        return jsonResponse([], { cors: true });
    }
    const q = qRaw.toLowerCase();

    const key = buildCacheKey(url.hostname, "/teams", { q });
    const cached = await caches.default.match(key);
    // Stamp BEFORE returning the cached Response — it carries no metadata.
    if (cached) {
        m.cache = "hit";
        return cached;
    }
    m.cache = "miss";

    const index = await getTeamIndex(env, url.hostname, ctx, m);
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

// Persist a /next-game payload as the durable last-known-good entry. Stored with
// a long TTL so it survives well past the 10-min freshness window, plus an
// X-Fetched-At stamp the handler reads to compute fresh-vs-stale itself. Kept
// separate from the short-TTL response returned to the client.
function writeDurable(key, payload, ctx) {
    const resp = new Response(JSON.stringify(payload), {
        headers: {
            "Content-Type": "application/json",
            "Cache-Control": `public, max-age=${LKG_CACHE_TTL}`,
            "X-Fetched-At": String(Date.now()),
        },
    });
    ctx.waitUntil(caches.default.put(key, resp.clone()));
}

// Recover the configured team's badge/name/league for an outage screen when we
// have no last-known-good payload to reuse. Leans on the 30-day team-meta and
// badge-analysis caches, so a previously-seen team stays branded even while
// upstream is down; a never-seen team degrades to just the message. Mirrors the
// not-found payload's team fields so the templates render identically.
async function outageTeamMeta(teamId, leagueIdFromUrl, env, hostname, ctx) {
    const meta = await fetchTeamMeta(teamId, env, hostname, ctx);
    const teamLeagueLabel =
        LEAGUE_DISPLAY_NAMES[leagueIdFromUrl] ||
        LEAGUE_DISPLAY_NAMES[meta.idLeague] ||
        meta.strLeague ||
        "";
    const { invert, trim } = meta.badge
        ? await analyzeBadge(meta.badge, hostname, ctx)
        : { invert: false, trim: NO_BADGE_TRIM };
    return {
        team_badge: meta.badge,
        team_badge_invert: invert,
        team_badge_trim: trim,
        team_name: meta.name || "",
        team_league_label: teamLeagueLabel,
    };
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
async function handleNextGame(url, env, ctx, m) {
    const teamParam = url.searchParams.get("team") || "";
    const type = url.searchParams.get("type") || "any";
    const locale = parseLocale(url.searchParams.get("locale"));
    const tz = parseTimeZone(url.searchParams.get("tz"));

    // The leagueId half drives the league display label in the title bar so it
    // stays consistent with the dropdown (and with the team's home league, not
    // the league of the next match — cup fixtures shouldn't change the label).
    const [teamId, leagueIdRaw] = teamParam.split("|");
    const leagueIdFromUrl = leagueIdRaw ? Number(leagueIdRaw) : null;

    // Stamp config dimensions from parsed/validated values (so {{...}}
    // placeholders and junk don't inflate cardinality). team/league IDs are
    // public, not PII.
    m.team = teamId || "";
    m.type = type;
    m.tz = tz;
    m.locale = locale;

    if (!teamId) {
        m.outcome = "missing_team";
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
    // One durable cache entry per (team,type,locale,tz): stored with a long TTL
    // plus an X-Fetched-At stamp, but the worker computes its own freshness.
    // Fresh (< NEXT_GAME_CACHE_TTL old) → serve as a hit. Stale → keep it in hand
    // as last-known-good and try to refresh; if upstream then fails we serve the
    // stale copy rather than a misleading empty "no game" screen.
    const cached = await caches.default.match(key);
    let lkg = null;
    let fetchedAt = 0;
    if (cached) {
        fetchedAt = Number(cached.headers.get("X-Fetched-At")) || 0;
        try {
            lkg = await cached.json();
        } catch {
            lkg = null; // Unexpected cache shape — treat as a miss, refetch.
        }
        if (
            lkg &&
            fetchedAt &&
            Date.now() - fetchedAt < NEXT_GAME_CACHE_TTL * 1000
        ) {
            m.cache = "hit";
            // Re-wrap so TRMNL sees the short poll-cadence TTL, not the long
            // durable TTL the stored entry carries.
            return jsonResponse(lkg, { maxAge: NEXT_GAME_CACHE_TTL });
        }
    }
    m.cache = "miss";

    const res = await fetch(`${API_BASE}/schedule/full/team/${teamId}`, {
        headers: { "X-API-KEY": env.SPORTSDB_API_KEY },
    });
    m.upstreamCalls = 1;
    m.upstream = res.ok ? "ok" : "fail";
    if (!res.ok) {
        m.upstreamFails = 1;
        // Upstream is down. Serve last-known-good if we have something worth
        // showing, so a blip doesn't masquerade as a finished season.
        if (lkg) {
            // THE GUARD: never re-serve a game whose start time has already
            // passed — a 7-day durable entry routinely outlives the game it
            // describes, and a confidently-wrong "next game" is worse than an
            // honest outage message. A season-over (found:false) entry has no
            // game to expire, so it's always still valid to re-show.
            const serveStale =
                lkg.found === false ||
                isTimestampUpcoming(lkg.start_utc_timestamp);
            if (serveStale) {
                m.cache = "stale";
                m.outcome = "stale";
                return jsonResponse(
                    {
                        ...lkg,
                        stale: true,
                        as_of_label: asOfLabel(fetchedAt, locale, tz),
                    },
                    { maxAge: 0 },
                );
            }
        }
        // Nothing usable to fall back on — say so honestly, but recover the
        // team's badge/name (from the 30-day team-meta cache) so the screen
        // stays branded. maxAge 0 so the next poll re-attempts upstream promptly.
        m.outcome = "upstream_fail";
        const meta = await outageTeamMeta(
            teamId,
            leagueIdFromUrl,
            env,
            url.hostname,
            ctx,
        );
        return jsonResponse(
            {
                found: false,
                outage: true,
                ...meta,
                not_found_message: outageMessage(locale),
            },
            { maxAge: 0 },
        );
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
        const [home, away] = await Promise.all([
            analyzeBadge(event.strHomeTeamBadge, url.hostname, ctx),
            analyzeBadge(event.strAwayTeamBadge, url.hostname, ctx),
        ]);
        payload = formatEvent(event, {
            homeInvert: home.invert,
            awayInvert: away.invert,
            homeTrim: home.trim,
            awayTrim: away.trim,
            locale,
            tz,
            teamId,
            teamLeagueLabel,
        });
    } else {
        const { invert, trim } = teamMeta.badge
            ? await analyzeBadge(teamMeta.badge, url.hostname, ctx)
            : { invert: false, trim: NO_BADGE_TRIM };
        payload = {
            found: false,
            team_badge: teamMeta.badge,
            team_badge_invert: invert,
            team_badge_trim: trim,
            team_name: teamMeta.name || "",
            team_league_label: teamLeagueLabel,
            not_found_message: notFoundMessage(locale),
        };
    }

    // Persist as the durable last-known-good entry (long TTL + X-Fetched-At),
    // but return a short-TTL response so TRMNL re-polls on its normal cadence.
    writeDurable(key, payload, ctx);
    return jsonResponse(payload, { maxAge: NEXT_GAME_CACHE_TTL });
}

// ── Observability ─────────────────────────────────────────────────────────
// One structured log line + one Analytics Engine datapoint per request, both
// built from a single request-scoped collector. The collector is write-only:
// handlers stamp facts as they learn them; only emit() reads it back. The AE
// column order below is a permanent contract — never reorder, append only.
// See cloudflare-worker/observability-queries.md for the schema and queries.
//
//   outcome   ok | stale | short_query | missing_team | upstream_fail
//             | rate_limited | cors_preflight | method_not_allowed | not_found
//             | error  (stale = served last-known-good because upstream failed)
//   cache     none | hit | miss | stale | rebuild  (stale = served a durable
//             entry past its freshness window; rebuild = team-index fan-out ran)
//   upstream  none | ok | fail | partial
function newMetrics(endpoint, method) {
    return {
        endpoint, // "teams" | "next-game" | "other"
        method,
        outcome: "ok",
        cache: "none",
        upstream: "none",
        upstreamCalls: 0,
        upstreamFails: 0,
        status: 0, // filled from the Response at emit time
        latencyMs: 0,
        // next-game config dimensions (stay "" for other endpoints)
        team: "",
        type: "",
        tz: "",
        locale: "",
    };
}

function emit(m, env, request) {
    // Workers Logs sink: one structured line, searchable in the dashboard.
    console.log(
        JSON.stringify({
            evt: "req",
            endpoint: m.endpoint,
            method: m.method,
            outcome: m.outcome,
            cache: m.cache,
            upstream: m.upstream,
            upstreamCalls: m.upstreamCalls,
            upstreamFails: m.upstreamFails,
            status: m.status,
            latencyMs: m.latencyMs,
            team: m.team || null,
            type: m.type || null,
            tz: m.tz || null,
            locale: m.locale || null,
            errorName: m.errorName, // omitted by JSON unless outcome === "error"
            colo: request.cf?.colo ?? null,
            ray: request.headers.get("cf-ray"),
        }),
    );

    // Analytics Engine sink: one datapoint, queryable over time. Writes are
    // non-blocking (no await / waitUntil). The binding is absent in local
    // `wrangler dev`, so `?.` makes this a no-op there.
    env.ANALYTICS?.writeDataPoint({
        indexes: [m.endpoint], // sampling key (≤ 96 bytes)
        blobs: [
            m.endpoint, // blob1
            m.outcome, // blob2
            m.cache, // blob3
            m.upstream, // blob4
            m.method, // blob5
            m.team, // blob6
            m.type, // blob7
            m.tz, // blob8
            m.locale, // blob9
        ],
        doubles: [
            m.latencyMs, // double1
            m.status, // double2
            m.upstreamCalls, // double3
            m.upstreamFails, // double4
        ],
    });
}

export default {
    async fetch(request, env, ctx) {
        const startedAt = Date.now();
        const url = new URL(request.url);
        const isTeamsSearch = url.pathname === "/teams";
        const endpoint = isTeamsSearch
            ? "teams"
            : url.pathname === "/next-game"
              ? "next-game"
              : "other";
        const m = newMetrics(endpoint, request.method);

        let response;
        try {
            if (request.method === "OPTIONS") {
                // Only /teams is browser-fetched (xhrSelectSearch); /next-game
                // is server-polled by TRMNL, so it never preflights.
                if (isTeamsSearch) {
                    m.outcome = "cors_preflight";
                    response = new Response(null, {
                        headers: {
                            "Access-Control-Allow-Origin": "*",
                            "Access-Control-Allow-Methods":
                                "GET, POST, OPTIONS",
                            "Access-Control-Allow-Headers": "Content-Type",
                        },
                    });
                } else {
                    m.outcome = "method_not_allowed";
                    response = new Response(null, { status: 405 });
                }
                return response;
            }

            const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
            const { success } = await env.RATE_LIMITER.limit({ key: ip });
            if (!success) {
                m.outcome = "rate_limited";
                response = jsonResponse(
                    { error: "Too many requests" },
                    { status: 429, cors: isTeamsSearch },
                );
                return response;
            }

            if (isTeamsSearch) {
                response = await handleTeamsSearch(url, request, env, ctx, m);
                return response;
            }
            if (url.pathname === "/next-game") {
                response = await handleNextGame(url, env, ctx, m);
                return response;
            }

            m.outcome = "not_found";
            response = new Response("Not found", { status: 404 });
            return response;
        } catch (err) {
            m.outcome = "error";
            m.errorName = err?.name ?? "Error";
            response = jsonResponse(
                { error: "Internal error" },
                { status: 500, cors: isTeamsSearch },
            );
            return response;
        } finally {
            m.status = response?.status ?? 0;
            m.latencyMs = Date.now() - startedAt;
            try {
                emit(m, env, request);
            } catch {
                // Telemetry must never mask the real response.
            }
        }
    },
};
