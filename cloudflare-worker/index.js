import * as UPNG from "upng-js";

import { LEAGUE_DISPLAY_NAMES, SUPPORTED_LEAGUE_IDS } from "./lib/constants.js";
import {
    asOfLabel,
    notFoundMessage,
    outageMessage,
    parseLocale,
    parseTimeZone,
} from "./lib/localization.js";
import { classifyNextGameCache, selectNextGame } from "./lib/schedule.js";
import { formatEvent } from "./lib/format.js";
import { searchTeams } from "./lib/search.js";
import { computeBadgeStats, NO_BADGE_TRIM } from "./lib/badge.js";

const API_BASE = "https://www.thesportsdb.com/api/v2/json";

const TEAMS_CACHE_TTL = 86400; // 24h — per-query search response cache
const TEAM_INDEX_CACHE_TTL = 86400; // 24h — full team list across supported leagues
const NEXT_GAME_CACHE_TTL = 600; // 10 min — under TRMNL's 15-min poll interval
// How long the durable /next-game entry survives so it can be served as
// last-known-good during an upstream outage. The *outgoing* freshness is still
// NEXT_GAME_CACHE_TTL — the worker reads X-Fetched-At to decide fresh vs. stale,
// independent of this much-longer storage TTL.
const LKG_CACHE_TTL = 7 * 86400; // 7 days

// Cache the per-badge analysis (invert decision + content bounding box) per
// badge URL for a long time — team logos rarely change. Looked up via
// caches.default; recomputed on cache miss.
const BADGE_ANALYSIS_CACHE_TTL = 30 * 86400; // 30 days

// Cache the team metadata lookup separately from the not-found response so
// that many not-found responses share a single team lookup.
const TEAM_META_CACHE_TTL = 30 * 86400; // 30 days

function jsonResponse(data, { status = 200, cors = false, maxAge = 0 } = {}) {
    const headers = { "Content-Type": "application/json" };
    if (cors) headers["Access-Control-Allow-Origin"] = "*";
    if (maxAge > 0) headers["Cache-Control"] = `public, max-age=${maxAge}`;
    return new Response(JSON.stringify(data), { status, headers });
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

// GET /teams?q=SEARCH_TERM  (or POST with JSON body { query: "..." })
// Returns teams matching the query, filtered to supported leagues,
// in TRMNL xhrSelectSearch format. Matches against team name, alternate name,
// and keywords via the cached team index (searchTeams) — no upstream call per
// request once the index is warm.
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
    const matches = searchTeams(index, q);

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
// they're entered in — including cup and continental fixtures. The pure
// selectNextGame (lib/schedule.js) does the upcoming-filter + sort + home/away
// pick locally, so cross-league matches stay visible regardless of filter, and
// we can find the next home/away match anywhere in the season rather than just
// within the next handful of events.
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
    // plus an X-Fetched-At stamp, but the worker computes its own freshness via
    // classifyNextGameCache. Fresh (< NEXT_GAME_CACHE_TTL old) → serve as a hit.
    // Stale but still serveable → keep it as last-known-good and try to refresh;
    // if upstream then fails we serve the stale copy rather than a misleading
    // empty "no game" screen.
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
    }
    const { fresh, serveable } = classifyNextGameCache({
        lkg,
        fetchedAtMs: fetchedAt,
        freshnessMs: NEXT_GAME_CACHE_TTL * 1000,
    });
    if (fresh) {
        m.cache = "hit";
        // Re-wrap so TRMNL sees the short poll-cadence TTL, not the long
        // durable TTL the stored entry carries.
        return jsonResponse(lkg, { maxAge: NEXT_GAME_CACHE_TTL });
    }
    m.cache = "miss";

    const res = await fetch(`${API_BASE}/schedule/full/team/${teamId}`, {
        headers: { "X-API-KEY": env.SPORTSDB_API_KEY },
    });
    m.upstreamCalls = 1;
    m.upstream = res.ok ? "ok" : "fail";
    if (!res.ok) {
        m.upstreamFails = 1;
        // Upstream is down. Serve last-known-good if it's still worth showing.
        // `serveable` is THE GUARD: a season-over (found:false) entry always
        // re-shows, but a game entry is only re-served until its start passes —
        // a 7-day durable entry routinely outlives the game it describes, and a
        // confidently-wrong "next game" is worse than an honest outage message.
        if (serveable) {
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
    const event = selectNextGame(data.schedule, type, teamId);

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
