// Pure team-search ranking over the cached team index. The I/O (building and
// caching the index) lives in index.js; this module just ranks and shapes the
// matches into TRMNL's xhrSelectSearch format. `q` is expected pre-lowercased
// by the caller (matchRank and the index's searchBlob are both lowercase).

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
