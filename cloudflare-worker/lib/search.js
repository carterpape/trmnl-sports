// Pure team-search ranking over the cached team index, plus the codec for the
// composite `TEAM_ID|LEAGUE_ID` param it emits. The I/O (building and caching
// the index) lives in index.js; this module ranks and shapes the matches into
// TRMNL's xhrSelectSearch format, and parses the param back on the way in. `q`
// is expected pre-lowercased by the caller (matchRank and the index's
// searchBlob are both lowercase).

const MAX_SEARCH_RESULTS = 20;

// Rank a match: 0 = team name starts with query, 1 = any whitespace token in
// team name starts with query (catches "Bulls" → "Chicago Bulls"), 2 = match
// only via substring or alternate/keyword fields.
export function matchRank(team, q) {
    const name = team.strTeam.toLowerCase();
    if (name.startsWith(q)) return 0;
    for (const token of name.split(/\s+/)) {
        if (token.startsWith(q)) return 1;
    }
    return 2;
}

// Filter the index to teams whose search blob contains `q`, rank them
// (prefix > token-prefix > substring), tiebreak alphabetically, cap, and shape
// into { id: "TEAM_ID|LEAGUE_ID", name: "Team Name (League)" } entries.
export function searchTeams(index, q, max = MAX_SEARCH_RESULTS) {
    return index
        .filter((t) => t.searchBlob.includes(q))
        .map((t) => ({ team: t, rank: matchRank(t, q) }))
        .sort(
            (a, b) =>
                a.rank - b.rank || a.team.strTeam.localeCompare(b.team.strTeam),
        )
        .slice(0, max)
        .map(({ team }) => ({
            id: `${team.idTeam}|${team.idLeague}`,
            name: `${team.strTeam} (${team.leagueLabel})`,
        }));
}

// Decode the composite team param — the inverse of the `id` searchTeams emits.
// We hand TRMNL `TEAM_ID|LEAGUE_ID`, but TRMNL stores the *picked* option as
// `value::label`, so a real device poll arrives as
// `TEAM_ID|LEAGUE_ID::Team Name (League)` (pape-docs/0081). parseInt reads the
// leading integer off the league half, ignoring any trailing `::label` — where
// Number() of the whole string would be NaN and silently defeat the title-bar
// label override. leagueId comes back as a clean number | null (never NaN).
export function parseTeamParam(teamParam) {
    const [teamId, leagueRaw] = (teamParam || "").split("|");
    const leagueId = leagueRaw ? parseInt(leagueRaw, 10) : NaN;
    return {
        teamId: teamId || "",
        leagueId: Number.isNaN(leagueId) ? null : leagueId,
    };
}
