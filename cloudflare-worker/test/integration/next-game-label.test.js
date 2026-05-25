// The real-install team-param shape at the /next-game fetch boundary
// (pape-docs/0081). TRMNL stores the picked dropdown option as `value::label`,
// so a real device poll sends `TEAM_ID|LEAGUE_ID::Team Name (League)` — not the
// clean `TEAM_ID|LEAGUE_ID` our other tests/curl use. The league half must
// still resolve the title-bar label via LEAGUE_DISPLAY_NAMES off the URL alone.
//
// The defeated-by-NaN bug didn't (usually) corrupt the label — fetchTeamMeta's
// own LEAGUE_DISPLAY_NAMES lookup recovered it — it defeated the URL-leagueId
// *fast path*, forcing an avoidable /lookup/team/ call on every real cache miss.
// So the load-bearing assertion here is that no team-meta lookup is fetched.

import { afterEach, describe, expect, it, vi } from "vitest";

import worker from "../../index.js";
import {
    createExecutionContext,
    installFetchMock,
    makeBadgePng,
    makeEnv,
    waitOnExecutionContext,
} from "./_harness.js";

// idLeague 4346 (MLS) is a LEAGUE_DISPLAY_NAMES override → the curated label is
// "MLS", not SportsDB's wordy "American Major League Soccer". A team id distinct
// from the other next-game integration test keeps the shared caches.default
// (next-game / team-meta / badge entries) from colliding across files.
const TEAM_ID = "54321";
const LEAGUE_ID = "4346";
const HOME_BADGE = "https://badges.test/label-home.png";
const AWAY_BADGE = "https://badges.test/label-away.png";

const EVENT = {
    idHomeTeam: TEAM_ID,
    idAwayTeam: "98765",
    strHomeTeam: "Test Home FC",
    strAwayTeam: "Test Away United",
    strHomeTeamBadge: HOME_BADGE,
    strAwayTeamBadge: AWAY_BADGE,
    strTimestamp: "2099-06-01 19:00:00",
    dateEvent: "2099-06-01",
    strTime: "19:00:00",
    strVenue: "Test Stadium",
    strLeague: "American Major League Soccer",
};

afterEach(() => {
    vi.unstubAllGlobals();
});

describe("/next-game with TRMNL's real-install ::label param shape", () => {
    it("resolves the title-bar label from the URL leagueId without a team-meta lookup", async () => {
        const calls = installFetchMock((url) => {
            if (url.includes(`/schedule/full/team/${TEAM_ID}`)) {
                return new Response(JSON.stringify({ schedule: [EVENT] }), {
                    headers: { "Content-Type": "application/json" },
                });
            }
            if (url === HOME_BADGE || url === AWAY_BADGE) {
                return new Response(makeBadgePng());
            }
            // Only the buggy NaN path reaches here. Mock it so that path
            // completes and the assertion (not an unmocked-fetch throw) is what
            // fails when the bug is present.
            if (url.includes(`/lookup/team/${TEAM_ID}`)) {
                return new Response(
                    JSON.stringify({
                        lookup: [
                            {
                                idLeague: LEAGUE_ID,
                                strLeague: "American Major League Soccer",
                                strTeam: "Test Home FC",
                                strBadge: HOME_BADGE,
                            },
                        ],
                    }),
                    { headers: { "Content-Type": "application/json" } },
                );
            }
            return undefined; // → fail loudly
        });

        const { env } = makeEnv();
        const ctx = createExecutionContext();

        // The real-install param: composite value + ::label suffix TRMNL appends.
        const team = encodeURIComponent(
            `${TEAM_ID}|${LEAGUE_ID}::Test Home FC (MLS)`,
        );
        const response = await worker.fetch(
            new Request(
                `https://worker.test/next-game?team=${team}&type=any&locale=en-US&tz=UTC`,
            ),
            env,
            ctx,
        );
        await waitOnExecutionContext(ctx);

        expect(response.status).toBe(200);
        const body = await response.json();

        expect(body.found).toBe(true);
        expect(body.team_name).toBe("Test Home FC");
        // The curated override, resolved off the URL leagueId — not the wordy
        // SportsDB strLeague.
        expect(body.team_league_label).toBe("MLS");

        // The fix: the ::label suffix is stripped, so the URL-leagueId fast path
        // hits and no /lookup/team/ call is made. With the NaN bug this fails.
        expect(calls.some((u) => u.includes("/lookup/team/"))).toBe(false);
    });
});
