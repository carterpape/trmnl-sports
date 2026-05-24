import { describe, expect, it } from "vitest";

import { classifyClient, classifySource } from "../lib/client.js";

describe("classifyClient — UA bucket", () => {
    it("maps Faraday (TRMNL's backend poller) to trmnl", () => {
        expect(classifyClient("Faraday v2.9.0")).toBe("trmnl");
    });

    it("maps a Ruby UA (local trmnlp preview) to trmnlp", () => {
        expect(classifyClient("Ruby")).toBe("trmnlp");
    });

    it("maps curl to curl", () => {
        expect(classifyClient("curl/8.7.1")).toBe("curl");
    });

    it("maps a browser UA to browser", () => {
        expect(
            classifyClient(
                "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15",
            ),
        ).toBe("browser");
    });

    it("classifies an unknown client as other", () => {
        expect(classifyClient("python-requests/2.31.0")).toBe("other");
    });

    it("treats an empty or missing UA as other", () => {
        expect(classifyClient("")).toBe("other");
        expect(classifyClient(null)).toBe("other");
        expect(classifyClient(undefined)).toBe("other");
    });

    it("matches case-insensitively", () => {
        expect(classifyClient("FARADAY V2.9.0")).toBe("trmnl");
        expect(classifyClient("CURL/8.7.1")).toBe("curl");
    });

    it("prefers the Faraday bucket over Ruby when both could appear", () => {
        // Defensive: a Faraday UA must never fall through to the trmnlp bucket.
        expect(classifyClient("Faraday v2.9.0 (ruby)")).toBe("trmnl");
    });
});

describe("classifySource — test vs prod", () => {
    it("forces test when the ?test=1 override is set, even for a real client", () => {
        expect(classifySource("trmnl", true)).toBe("test");
    });

    it("treats our own dev tools as test", () => {
        expect(classifySource("trmnlp", false)).toBe("test");
        expect(classifySource("curl", false)).toBe("test");
    });

    it("treats the real poller, browsers, and unknown clients as prod", () => {
        expect(classifySource("trmnl", false)).toBe("prod");
        expect(classifySource("browser", false)).toBe("prod");
        expect(classifySource("other", false)).toBe("prod");
    });
});
