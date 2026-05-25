import { describe, expect, it } from "vitest";

import { classifyClient, classifySource } from "../lib/client.js";

describe("classifyClient — descriptive UA bucket", () => {
    it("maps a Faraday UA to faraday", () => {
        expect(classifyClient("Faraday v2.9.0")).toBe("faraday");
    });

    it("maps a bare Ruby UA to ruby", () => {
        expect(classifyClient("Ruby")).toBe("ruby");
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
        expect(classifyClient("FARADAY V2.9.0")).toBe("faraday");
        expect(classifyClient("CURL/8.7.1")).toBe("curl");
    });

    it("prefers faraday over ruby when both tokens appear", () => {
        // A Faraday UA string can also contain "ruby"; it must bucket as faraday.
        expect(classifyClient("Faraday v2.9.0 (ruby)")).toBe("faraday");
    });
});

describe("classifySource — test vs prod", () => {
    it("tags test only when the ?test=1 marker is set", () => {
        expect(classifySource(true)).toBe("test");
    });

    it("tags everything unmarked as prod, regardless of UA", () => {
        // The key fix: real TRMNL polls (bare Ruby UA) must NOT be tagged test
        // just because they share a UA with our local trmnlp tooling.
        expect(classifySource(false)).toBe("prod");
    });
});
