import { describe, expect, it } from "vitest";

import { formatEvent } from "../lib/format.js";

const NOW = Date.parse("2026-05-24T12:00:00Z");

const baseEvent = {
    strHomeTeam: "Home FC",
    strAwayTeam: "Away United",
    strHomeTeamBadge: "https://example.test/home.png",
    strAwayTeamBadge: "https://example.test/away.png",
    idHomeTeam: "100",
    idAwayTeam: "200",
    strTimestamp: "2026-05-24 19:00:00",
    strVenue: "Test Stadium",
    strLeague: "Test League",
    strSport: "Soccer",
};

const baseOpts = {
    homeInvert: true,
    awayInvert: false,
    homeTrim: { x: 0.1, y: 0, w: 0.8, h: 1 },
    awayTrim: { x: 0, y: 0, w: 1, h: 1 },
    locale: "en-US",
    tz: "UTC",
    teamId: "100",
    teamLeagueLabel: "MLS",
    nowMs: NOW,
};

describe("formatEvent", () => {
    it("maps the event into the flat payload with localized labels", () => {
        const out = formatEvent(baseEvent, baseOpts);
        expect(out).toMatchObject({
            found: true,
            home_team: "Home FC",
            away_team: "Away United",
            home_team_badge: "https://example.test/home.png",
            away_team_badge: "https://example.test/away.png",
            home_team_badge_invert: true,
            away_team_badge_invert: false,
            home_team_badge_trim: { x: 0.1, y: 0, w: 0.8, h: 1 },
            away_team_badge_trim: { x: 0, y: 0, w: 1, h: 1 },
            date_label: "Today",
            team_league_label: "MLS",
        });
        expect(out.time_label).toMatch(/^7:00\sp\.m\.$/);
    });

    it("resolves team_name from whichever side matches teamId", () => {
        expect(formatEvent(baseEvent, baseOpts).team_name).toBe("Home FC");
        expect(
            formatEvent(baseEvent, { ...baseOpts, teamId: "200" }).team_name,
        ).toBe("Away United");
    });

    it("blanks the date/time labels when the event has no timestamp", () => {
        const out = formatEvent({ ...baseEvent, strTimestamp: null }, baseOpts);
        expect(out.date_label).toBe("");
        expect(out.time_label).toBe("");
    });

    it("falls back to the event's strLeague when no label override is given", () => {
        const out = formatEvent(baseEvent, {
            ...baseOpts,
            teamLeagueLabel: "",
        });
        expect(out.team_league_label).toBe("Test League");
    });
});
