// Pure schedule logic: timestamp parsing, the "still upcoming?" predicate, the
// next-game selection (filter + sort + home/away pick), and the next-game cache
// classification (fresh / stale-but-serveable). The I/O shell in handleNextGame
// fetches the schedule and delegates the decisions here. Time-dependent
// functions take an optional `nowMs` (defaulting to the real clock) so tests
// can pin "now".

// TheSportsDB keeps recently-finished games in its schedule response for some
// window. Treat a game as still upcoming until this long after kickoff,
// covering the longest expected game across supported leagues (MLB ~3h).
const UPCOMING_GRACE_MS = 4 * 60 * 60 * 1000;

// TheSportsDB timestamps lack explicit timezone info; treat as UTC.
export function toUtcTimestamp(strTimestamp) {
    if (!strTimestamp) return null;
    if (strTimestamp.includes("+") || strTimestamp.endsWith("Z"))
        return strTimestamp;
    return strTimestamp + "+00:00";
}

// Is a UTC timestamp string still "upcoming" — at or before UPCOMING_GRACE_MS
// after kickoff? Shared by the schedule filter (isUpcoming) and the stale
// last-known-good guard, so both use one definition of "still worth showing".
// Returns false for a missing/unparseable timestamp.
export function isTimestampUpcoming(utcTimestamp, nowMs = Date.now()) {
    if (!utcTimestamp) return false;
    const startMs = Date.parse(utcTimestamp);
    if (isNaN(startMs)) return false;
    return startMs > nowMs - UPCOMING_GRACE_MS;
}

export function isUpcoming(event, nowMs = Date.now()) {
    const ts = toUtcTimestamp(event.strTimestamp);
    if (ts && !isNaN(Date.parse(ts))) return isTimestampUpcoming(ts, nowMs);
    // Fallback for events without a precise time: compare by date only.
    if (!event.dateEvent) return false;
    return event.dateEvent >= new Date(nowMs).toISOString().slice(0, 10);
}

// Pick the soonest upcoming event matching the home/away filter for `teamId`.
// /schedule/full/team is not chronologically ordered, so filter to upcoming
// events and sort ascending before .find() picks the first match. Home/away is
// resolved locally so cross-league (cup/continental) fixtures stay visible.
// Returns the chosen event, or null when nothing matches.
export function selectNextGame(schedule, type, teamId, nowMs = Date.now()) {
    const upcoming = (schedule || [])
        .filter((e) => isUpcoming(e, nowMs))
        .sort(
            (a, b) =>
                (a.dateEvent || "").localeCompare(b.dateEvent || "") ||
                (a.strTime || "").localeCompare(b.strTime || ""),
        );
    return (
        upcoming.find((e) => {
            if (type === "home") return String(e.idHomeTeam) === String(teamId);
            if (type === "away") return String(e.idAwayTeam) === String(teamId);
            return true;
        }) || null
    );
}

// Classify a durable last-known-good /next-game cache entry against the clock:
//   • fresh     — present and fetched within `freshnessMs` (serve as a hit).
//   • serveable — present and still worth re-showing if upstream then fails: a
//     season-over (found:false) entry never expires, and a game entry is only
//     serveable until its start passes (the stale guard against re-serving a
//     game that already happened).
// `lkg` is the parsed payload (or null on a miss/parse failure); `fetchedAtMs`
// is the stored X-Fetched-At stamp (0 when absent).
export function classifyNextGameCache({
    lkg,
    fetchedAtMs,
    nowMs = Date.now(),
    freshnessMs,
}) {
    if (!lkg) return { fresh: false, serveable: false };
    const fresh = !!fetchedAtMs && nowMs - fetchedAtMs < freshnessMs;
    const serveable =
        lkg.found === false ||
        isTimestampUpcoming(lkg.start_utc_timestamp, nowMs);
    return { fresh, serveable };
}
