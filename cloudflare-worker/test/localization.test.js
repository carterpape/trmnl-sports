import { describe, expect, it } from "vitest";

import {
    asOfLabel,
    localizeDateLabel,
    localizeTimeLabel,
    notFoundMessage,
    outageMessage,
    parseLocale,
    parseTimeZone,
} from "../lib/localization.js";

// Recent ICU (Node ≥ 18) puts a narrow no-break space (U+202F) before AM/PM in
// en-US time strings; \s in a regex matches it as well as a regular space, so
// time assertions use a whitespace-agnostic match to stay ICU-version-robust.

describe("parseLocale", () => {
    it("passes through valid IETF tags", () => {
        expect(parseLocale("en-US")).toBe("en-US");
        expect(parseLocale("de-DE")).toBe("de-DE");
    });

    it("falls back to en-US for missing input", () => {
        expect(parseLocale("")).toBe("en-US");
        expect(parseLocale(null)).toBe("en-US");
        expect(parseLocale(undefined)).toBe("en-US");
    });

    it("falls back for an un-interpolated template placeholder", () => {
        expect(parseLocale("{{ trmnl.user.locale }}")).toBe("en-US");
    });

    it("falls back for an unparseable tag", () => {
        expect(parseLocale("not-a-real-locale-@#$")).toBe("en-US");
    });
});

describe("parseTimeZone", () => {
    it("passes through valid IANA zones", () => {
        expect(parseTimeZone("America/Los_Angeles")).toBe(
            "America/Los_Angeles",
        );
        expect(parseTimeZone("UTC")).toBe("UTC");
    });

    it("falls back to UTC for missing, placeholder, or invalid input", () => {
        expect(parseTimeZone("")).toBe("UTC");
        expect(parseTimeZone(null)).toBe("UTC");
        expect(parseTimeZone("{{ trmnl.user.time_zone_iana }}")).toBe("UTC");
        expect(parseTimeZone("Not/AZone")).toBe("UTC");
    });
});

describe("notFoundMessage / outageMessage", () => {
    it("returns the localized string by language code", () => {
        expect(notFoundMessage("en-US")).toBe("No game found");
        expect(notFoundMessage("de-DE")).toBe("Kein Spiel");
        expect(notFoundMessage("ja-JP")).toBe("試合なし");
        expect(outageMessage("de-DE")).toBe("Spielplan nicht verfügbar");
    });

    it("is case-insensitive and region-agnostic", () => {
        expect(notFoundMessage("DE")).toBe("Kein Spiel");
    });

    it("falls back to English for an unknown language", () => {
        expect(notFoundMessage("xx-YY")).toBe("No game found");
        expect(outageMessage("xx-YY")).toBe("Schedule unavailable");
    });
});

describe("localizeDateLabel", () => {
    const NOW = Date.parse("2026-05-24T12:00:00Z");
    const todayInLA = Date.parse("2026-05-24T20:00:00Z"); // 13:00 PDT, 24th
    const tomorrowInLA = Date.parse("2026-05-25T20:00:00Z");
    const future = Date.parse("2026-05-30T20:00:00Z");

    it("says Today / Tomorrow in English", () => {
        expect(
            localizeDateLabel(todayInLA, "en-US", "America/Los_Angeles", NOW),
        ).toBe("Today");
        expect(
            localizeDateLabel(
                tomorrowInLA,
                "en-US",
                "America/Los_Angeles",
                NOW,
            ),
        ).toBe("Tomorrow");
    });

    it("localizes and capitalizes the relative day", () => {
        expect(
            localizeDateLabel(todayInLA, "de-DE", "America/Los_Angeles", NOW),
        ).toBe("Heute");
        expect(
            localizeDateLabel(
                tomorrowInLA,
                "de-DE",
                "America/Los_Angeles",
                NOW,
            ),
        ).toBe("Morgen");
    });

    it("crosses the day boundary by time zone for the same instant", () => {
        // todayInLA is the 24th in LA but the 25th in Tokyo.
        expect(
            localizeDateLabel(todayInLA, "en-US", "America/Los_Angeles", NOW),
        ).toBe("Today");
        expect(localizeDateLabel(todayInLA, "en-US", "Asia/Tokyo", NOW)).toBe(
            "Tomorrow",
        );
    });

    it("falls back to a weekday+date label beyond tomorrow", () => {
        const label = localizeDateLabel(
            future,
            "en-US",
            "America/Los_Angeles",
            NOW,
        );
        expect(label).not.toBe("Today");
        expect(label).not.toBe("Tomorrow");
        expect(label).toMatch(/May 30/);
    });
});

describe("localizeTimeLabel", () => {
    it("uses AP-style a.m./p.m. for English", () => {
        expect(
            localizeTimeLabel(
                Date.parse("2026-05-24T19:30:00Z"),
                "en-US",
                "UTC",
            ),
        ).toMatch(/^7:30\sp\.m\.$/);
        expect(
            localizeTimeLabel(
                Date.parse("2026-05-24T09:05:00Z"),
                "en-US",
                "UTC",
            ),
        ).toMatch(/^9:05\sa\.m\.$/);
    });

    it("leaves non-English (24h) formats untouched", () => {
        const label = localizeTimeLabel(
            Date.parse("2026-05-24T17:30:00Z"),
            "de-DE",
            "Europe/Berlin", // CEST (UTC+2) in May → 19:30
        );
        expect(label).toBe("19:30");
        expect(label).not.toMatch(/[ap]\.m\./);
    });
});

describe("asOfLabel", () => {
    const NOW = Date.parse("2026-05-24T20:00:00Z");

    it("prefixes 'as of' with the localized time on the same day", () => {
        const label = asOfLabel(
            Date.parse("2026-05-24T19:00:00Z"),
            "en-US",
            "UTC",
            NOW,
        );
        expect(label).toMatch(/^as of 7:00\sp\.m\.$/);
    });

    it("prepends a date when the fetch was on an earlier day", () => {
        const label = asOfLabel(
            Date.parse("2026-05-22T19:00:00Z"),
            "en-US",
            "UTC",
            NOW,
        );
        expect(label).toMatch(/^as of May 22 7:00\sp\.m\.$/);
    });

    it("suffixes the marker for Japanese/Korean", () => {
        const ja = asOfLabel(
            Date.parse("2026-05-24T19:00:00Z"),
            "ja-JP",
            "UTC",
            NOW,
        );
        expect(ja.startsWith("as of")).toBe(false);
        expect(ja.endsWith("現在")).toBe(true);

        const ko = asOfLabel(
            Date.parse("2026-05-24T19:00:00Z"),
            "ko-KR",
            "UTC",
            NOW,
        );
        expect(ko.endsWith(" 기준")).toBe(true);
    });
});
