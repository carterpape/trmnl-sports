import { describe, expect, it } from "vitest";

import {
    classifyNextGameCache,
    isTimestampUpcoming,
    isUpcoming,
    selectNextGame,
    toUtcTimestamp,
} from "../lib/schedule.js";

const HOUR = 60 * 60 * 1000;

describe("toUtcTimestamp", () => {
    it("appends a UTC offset to a naive timestamp", () => {
        expect(toUtcTimestamp("2026-05-24 19:00:00")).toBe(
            "2026-05-24 19:00:00+00:00",
        );
    });

    it("leaves an already-zoned timestamp untouched", () => {
        expect(toUtcTimestamp("2026-05-24T19:00:00+02:00")).toBe(
            "2026-05-24T19:00:00+02:00",
        );
        expect(toUtcTimestamp("2026-05-24T19:00:00Z")).toBe(
            "2026-05-24T19:00:00Z",
        );
    });

    it("returns null for missing input", () => {
        expect(toUtcTimestamp(null)).toBeNull();
        expect(toUtcTimestamp("")).toBeNull();
    });
});

describe("isTimestampUpcoming", () => {
    const NOW = Date.parse("2026-05-24T12:00:00Z");

    it("is true for a future kickoff", () => {
        expect(
            isTimestampUpcoming(new Date(NOW + HOUR).toISOString(), NOW),
        ).toBe(true);
    });

    it("stays true within the post-kickoff grace window (4h)", () => {
        expect(
            isTimestampUpcoming(new Date(NOW - 3 * HOUR).toISOString(), NOW),
        ).toBe(true);
    });

    it("is false once the grace window has passed", () => {
        expect(
            isTimestampUpcoming(new Date(NOW - 5 * HOUR).toISOString(), NOW),
        ).toBe(false);
    });

    it("is false for missing or unparseable input", () => {
        expect(isTimestampUpcoming(null, NOW)).toBe(false);
        expect(isTimestampUpcoming("not a date", NOW)).toBe(false);
    });
});

describe("isUpcoming", () => {
    const NOW = Date.parse("2026-05-24T12:00:00Z");
    const today = new Date(NOW).toISOString().slice(0, 10);
    const yesterday = new Date(NOW - 24 * HOUR).toISOString().slice(0, 10);

    it("uses the precise timestamp when present", () => {
        expect(
            isUpcoming({ strTimestamp: "2026-05-30 19:00:00" }, "UTC", NOW),
        ).toBe(true);
        expect(
            isUpcoming({ strTimestamp: "2026-05-01 19:00:00" }, "UTC", NOW),
        ).toBe(false);
    });

    it("falls back to date-only comparison without a timestamp", () => {
        expect(isUpcoming({ dateEvent: today }, "UTC", NOW)).toBe(true);
        expect(isUpcoming({ dateEvent: yesterday }, "UTC", NOW)).toBe(false);
    });

    it("is false when neither timestamp nor date is present", () => {
        expect(isUpcoming({}, "UTC", NOW)).toBe(false);
    });

    it("uses the user's time zone for the date-only fallback", () => {
        // 2026-05-25 06:00 UTC is still 2026-05-24 23:00 in Los Angeles (PDT),
        // so a timestamp-less game dated 2026-05-24 is "today" locally but
        // already "yesterday" in UTC — the tz-naive fallback wrongly drops it.
        const lateNightUtc = Date.parse("2026-05-25T06:00:00Z");
        const event = { dateEvent: "2026-05-24" };
        expect(isUpcoming(event, "America/Los_Angeles", lateNightUtc)).toBe(
            true,
        );
        expect(isUpcoming(event, "UTC", lateNightUtc)).toBe(false);
    });
});

describe("selectNextGame", () => {
    const NOW = Date.parse("2026-05-24T00:00:00Z");
    const TEAM = "100";

    // Deliberately out of chronological order in the array.
    const homeGame = {
        dateEvent: "2026-06-01",
        strTime: "18:00:00",
        strTimestamp: "2026-06-01 18:00:00",
        idHomeTeam: "100",
        idAwayTeam: "200",
    };
    const awayGameSooner = {
        dateEvent: "2026-05-30",
        strTime: "19:00:00",
        strTimestamp: "2026-05-30 19:00:00",
        idHomeTeam: "300",
        idAwayTeam: "100",
    };
    const pastGame = {
        dateEvent: "2026-05-01",
        strTime: "19:00:00",
        strTimestamp: "2026-05-01 19:00:00",
        idHomeTeam: "100",
        idAwayTeam: "400",
    };
    const schedule = [homeGame, pastGame, awayGameSooner];

    it("picks the soonest upcoming game for type 'any'", () => {
        expect(selectNextGame(schedule, "any", TEAM, "UTC", NOW)).toBe(
            awayGameSooner,
        );
    });

    it("filters to the team's home games", () => {
        expect(selectNextGame(schedule, "home", TEAM, "UTC", NOW)).toBe(
            homeGame,
        );
    });

    it("filters to the team's away games", () => {
        expect(selectNextGame(schedule, "away", TEAM, "UTC", NOW)).toBe(
            awayGameSooner,
        );
    });

    it("returns null for an empty / all-past schedule", () => {
        expect(selectNextGame([], "any", TEAM, "UTC", NOW)).toBeNull();
        expect(selectNextGame(null, "any", TEAM, "UTC", NOW)).toBeNull();
        expect(selectNextGame([pastGame], "any", TEAM, "UTC", NOW)).toBeNull();
    });
});

describe("classifyNextGameCache", () => {
    const NOW = Date.parse("2026-05-24T12:00:00Z");
    const FRESHNESS = 600 * 1000; // NEXT_GAME_CACHE_TTL
    const future = new Date(NOW + 48 * HOUR).toISOString();
    const longPast = new Date(NOW - 48 * HOUR).toISOString();

    it("reports both false for a cache miss", () => {
        expect(
            classifyNextGameCache({
                lkg: null,
                fetchedAtMs: 0,
                nowMs: NOW,
                freshnessMs: FRESHNESS,
            }),
        ).toEqual({ fresh: false, serveable: false });
    });

    it("is fresh and serveable within the freshness window", () => {
        expect(
            classifyNextGameCache({
                lkg: { found: true, start_utc_timestamp: future },
                fetchedAtMs: NOW - 1000,
                nowMs: NOW,
                freshnessMs: FRESHNESS,
            }),
        ).toEqual({ fresh: true, serveable: true });
    });

    it("is stale-but-serveable past the freshness window for an upcoming game", () => {
        expect(
            classifyNextGameCache({
                lkg: { found: true, start_utc_timestamp: future },
                fetchedAtMs: NOW - 2 * FRESHNESS,
                nowMs: NOW,
                freshnessMs: FRESHNESS,
            }),
        ).toEqual({ fresh: false, serveable: true });
    });

    it("is NOT serveable once the cached game's start has passed (the guard)", () => {
        expect(
            classifyNextGameCache({
                lkg: { found: true, start_utc_timestamp: longPast },
                fetchedAtMs: NOW - 2 * FRESHNESS,
                nowMs: NOW,
                freshnessMs: FRESHNESS,
            }),
        ).toEqual({ fresh: false, serveable: false });
    });

    it("treats a season-over (found:false) entry as always serveable", () => {
        expect(
            classifyNextGameCache({
                lkg: { found: false },
                fetchedAtMs: NOW - 2 * FRESHNESS,
                nowMs: NOW,
                freshnessMs: FRESHNESS,
            }),
        ).toEqual({ fresh: false, serveable: true });
    });

    it("is never fresh without an X-Fetched-At stamp", () => {
        const { fresh } = classifyNextGameCache({
            lkg: { found: true, start_utc_timestamp: future },
            fetchedAtMs: 0,
            nowMs: NOW,
            freshnessMs: FRESHNESS,
        });
        expect(fresh).toBe(false);
    });
});
