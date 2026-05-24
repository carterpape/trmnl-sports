// Pure transform from a raw TheSportsDB event (plus the badge analysis and
// locale/tz the handler resolved) into the flat /next-game payload the
// templates consume. No I/O — badge analysis and locale parsing happen in the
// handler and are passed in.

import { localizeDateLabel, localizeTimeLabel } from "./localization.js";
import { toUtcTimestamp } from "./schedule.js";

export function formatEvent(
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
        nowMs = Date.now(),
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
        date_label: haveTime
            ? localizeDateLabel(gameMs, locale, tz, nowMs)
            : "",
        time_label: haveTime ? localizeTimeLabel(gameMs, locale, tz) : "",
        // Reserved for future templates; not rendered today.
        //   venue  — for a possible "@ <stadium>" line.
        //   league — the raw next-event league (e.g. "FA Cup" for a cup tie),
        //            deliberately distinct from the displayed team_league_label
        //            (which stays the team's home league). If ever shown, qualify
        //            it visually so a cross-competition fixture reads as such.
        venue: event.strVenue,
        league: event.strLeague,
        team_name: teamName || "",
        team_league_label: teamLeagueLabel || event.strLeague || "",
    };
}
