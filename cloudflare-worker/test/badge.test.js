import { describe, expect, it } from "vitest";

import { NO_BADGE_TRIM, computeBadgeStats } from "../lib/badge.js";

// Build a width×height RGBA buffer from a per-pixel callback returning
// [r, g, b, a]. Pixel order is row-major, matching computeBadgeStats.
function rgbaFrom(width, height, pixel) {
    const buf = new Uint8Array(width * height * 4);
    for (let p = 0; p < width * height; p++) {
        const [r, g, b, a] = pixel(p % width, (p / width) | 0);
        buf.set([r, g, b, a], p * 4);
    }
    return buf;
}

describe("computeBadgeStats — invert decision", () => {
    it("flags a white-on-transparent logo for inversion", () => {
        const rgba = rgbaFrom(2, 2, () => [255, 255, 255, 255]);
        expect(computeBadgeStats(rgba, 2, 2).invert).toBe(true);
    });

    it("does not invert a dark logo", () => {
        const rgba = rgbaFrom(2, 2, () => [0, 0, 0, 255]);
        expect(computeBadgeStats(rgba, 2, 2).invert).toBe(false);
    });

    it("uses a strict threshold at luma 200", () => {
        expect(
            computeBadgeStats(new Uint8Array([200, 200, 200, 255]), 1, 1)
                .invert,
        ).toBe(false);
        expect(
            computeBadgeStats(new Uint8Array([201, 201, 201, 255]), 1, 1)
                .invert,
        ).toBe(true);
    });

    it("ignores transparent pixels when averaging luminance", () => {
        // One white opaque pixel + three transparent: mean over opaque only.
        const rgba = rgbaFrom(2, 2, (x, y) =>
            x === 0 && y === 0 ? [255, 255, 255, 255] : [0, 0, 0, 0],
        );
        expect(computeBadgeStats(rgba, 2, 2).invert).toBe(true);
    });
});

describe("computeBadgeStats — content trim", () => {
    it("reports a full-canvas bbox for an edge-to-edge logo", () => {
        const rgba = rgbaFrom(2, 2, () => [0, 0, 0, 255]);
        expect(computeBadgeStats(rgba, 2, 2).trim).toEqual({
            x: 0,
            y: 0,
            w: 1,
            h: 1,
        });
    });

    it("measures the opaque bounding box inside transparent padding", () => {
        // 4×4 canvas, only the center 2×2 is opaque.
        const rgba = rgbaFrom(4, 4, (x, y) =>
            x >= 1 && x <= 2 && y >= 1 && y <= 2
                ? [0, 0, 0, 255]
                : [0, 0, 0, 0],
        );
        expect(computeBadgeStats(rgba, 4, 4).trim).toEqual({
            x: 0.25,
            y: 0.25,
            w: 0.5,
            h: 0.5,
        });
    });

    it("falls back to the neutral analysis for a fully transparent badge", () => {
        const rgba = rgbaFrom(2, 2, () => [0, 0, 0, 0]);
        expect(computeBadgeStats(rgba, 2, 2)).toEqual({
            invert: false,
            trim: NO_BADGE_TRIM,
        });
    });
});
