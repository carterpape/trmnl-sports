// Shared league data used by both the I/O handlers (team-index fan-out,
// title-bar label) and the pure formatting/search logic. Cache keys still use
// the original numeric idLeague — only the *display* label is overridden here.

// Supported league IDs (TheSportsDB internal IDs).
export const SUPPORTED_LEAGUE_IDS = new Set([
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
export const LEAGUE_DISPLAY_NAMES = {
    4346: "MLS",
    4521: "NWSL",
    4479: "NCAA Football",
    4607: "NCAA Men's Basketball",
    5789: "NCAA Women's Basketball",
    4416: "NRL",
    4456: "AFL",
    4461: "Big Bash League",
};
