// The load-bearing skeleton test (pape-docs/0076, watch-out #2): drive the REAL
// UPNG.decode → computeBadgeStats path through the /next-game fetch boundary,
// confirming upng-js bundles and runs inside workerd under the Workers pool.
// A mocked schedule yields one future event; mocked badge PNGs (opaque white
// vs. opaque black) must come back through the handler as invert true vs.
// false — proving the decode actually ran and distinguished them.

import { afterEach, describe, expect, it, vi } from "vitest";

import worker from "../../index.js";
import {
    createExecutionContext,
    decodeDatapoint,
    installFetchMock,
    makeBadgePng,
    makeEnv,
    waitOnExecutionContext,
} from "./_harness.js";

// idLeague 4346 (MLS) is a LEAGUE_DISPLAY_NAMES key, so the title-bar label
// resolves from the URL alone — no fetchTeamMeta lookup — keeping the mock
// surface to just the schedule + the two badge URLs.
const TEAM_ID = "12345";
const LEAGUE_ID = "4346";
const HOME_BADGE = "https://badges.test/home.png";
const AWAY_BADGE = "https://badges.test/away.png";

const EVENT = {
    idHomeTeam: TEAM_ID,
    idAwayTeam: "67890",
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

describe("/next-game badge analysis", () => {
    it("decodes badge PNGs via upng and threads invert/trim into the payload", async () => {
        installFetchMock((url) => {
            if (url.includes(`/schedule/full/team/${TEAM_ID}`)) {
                return new Response(JSON.stringify({ schedule: [EVENT] }), {
                    headers: { "Content-Type": "application/json" },
                });
            }
            if (url === HOME_BADGE) return new Response(makeBadgePng()); // opaque white
            if (url === AWAY_BADGE) {
                return new Response(makeBadgePng({ r: 0, g: 0, b: 0 })); // opaque black
            }
            return undefined; // → fail loudly
        });

        const { env, captured } = makeEnv();
        const ctx = createExecutionContext();

        const response = await worker.fetch(
            new Request(
                `https://worker.test/next-game?team=${TEAM_ID}|${LEAGUE_ID}&type=any&locale=en-US&tz=UTC`,
            ),
            env,
            ctx,
        );
        await waitOnExecutionContext(ctx);

        expect(response.status).toBe(200);
        const body = await response.json();

        expect(body.found).toBe(true);
        expect(body.team_name).toBe("Test Home FC");
        expect(body.team_league_label).toBe("MLS");

        // The real decode ran and distinguished the two badges: white → invert,
        // black → not. Trim is the opaque-content box; a solid badge fills the
        // canvas, so the no-trim sentinel {0,0,1,1}.
        expect(body.home_team_badge_invert).toBe(true);
        expect(body.away_team_badge_invert).toBe(false);
        expect(body.home_team_badge_trim).toEqual({ x: 0, y: 0, w: 1, h: 1 });

        // Pre-localized labels were produced server-side.
        expect(body.start_utc_timestamp).toBe("2099-06-01 19:00:00+00:00");
        expect(body.date_label).toBeTruthy();
        expect(body.time_label).toBeTruthy();

        // One datapoint, wired for the happy path.
        expect(captured).toHaveLength(1);
        const dp = decodeDatapoint(captured[0]);
        expect(dp.endpoint).toBe("next-game");
        expect(dp.outcome).toBe("ok");
        expect(dp.cache).toBe("miss");
        expect(dp.upstream).toBe("ok");
        expect(dp.upstreamCalls).toBe(1);
        expect(dp.team).toBe(TEAM_ID);
    });
});
