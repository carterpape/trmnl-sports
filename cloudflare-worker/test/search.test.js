import { describe, expect, it } from "vitest";

import { matchRank, searchTeams } from "../lib/search.js";

describe("matchRank", () => {
    const bulls = { strTeam: "Chicago Bulls" };

    it("ranks a team-name prefix highest (0)", () => {
        expect(matchRank(bulls, "chicago")).toBe(0);
    });

    it("ranks a name-token prefix next (1) — the mascot case", () => {
        expect(matchRank(bulls, "bulls")).toBe(1);
    });

    it("ranks a mid-token substring lowest (2)", () => {
        expect(matchRank(bulls, "ull")).toBe(2);
    });
});

describe("searchTeams", () => {
    // searchBlob is "name | alternate | keywords", lowercased, as built by
    // getTeamIndex. `q` is passed pre-lowercased by the caller.
    const index = [
        {
            idTeam: "1",
            idLeague: "10",
            strTeam: "Chicago Bulls",
            leagueLabel: "NBA",
            searchBlob: "chicago bulls |  | ",
        },
        {
            idTeam: "2",
            idLeague: "11",
            strTeam: "Chicago Bears",
            leagueLabel: "NFL",
            searchBlob: "chicago bears |  | ",
        },
        {
            idTeam: "4",
            idLeague: "12",
            strTeam: "Red Star",
            leagueLabel: "Test",
            searchBlob: "red star |  | bullseye",
        },
    ];

    it("returns xhrSelectSearch-shaped entries", () => {
        const [first] = searchTeams(index, "bulls");
        expect(first).toEqual({ id: "1|10", name: "Chicago Bulls (NBA)" });
    });

    it("ranks prefix matches before substring, alphabetical within a tier", () => {
        // Both Chicago teams are rank-0; tiebreak alphabetical → Bears first.
        expect(searchTeams(index, "chicago").map((m) => m.name)).toEqual([
            "Chicago Bears (NFL)",
            "Chicago Bulls (NBA)",
        ]);
    });

    it("ranks a name-token match above a keyword-only substring", () => {
        // "bulls": token prefix on Chicago Bulls (rank 1) beats the "bullseye"
        // keyword substring on Red Star (rank 2).
        expect(searchTeams(index, "bulls").map((m) => m.name)).toEqual([
            "Chicago Bulls (NBA)",
            "Red Star (Test)",
        ]);
    });

    it("caps the result count", () => {
        expect(searchTeams(index, "chicago", 1)).toHaveLength(1);
    });

    it("returns nothing when no blob contains the query", () => {
        expect(searchTeams(index, "zzz")).toEqual([]);
    });
});
