// Pure badge pixel analysis for e-ink rendering. The I/O wrapper (fetch +
// decode + cache) lives in index.js; this module is just the math over an
// already-decoded RGBA buffer, so it tests without network or upng.

// Mean luminance threshold (0–255). Above this, a badge's visible pixels are
// considered "white-on-transparent" and templates should invert it so it
// renders as dark-on-white on e-ink.
const WHITE_BADGE_LUMA_THRESHOLD = 200;

// The neutral badge analysis: no inversion, no trim (full-canvas bbox). Used
// whenever a badge can't be fetched/decoded, so templates can always rely on a
// trim being present and fall back to today's untrimmed rendering.
export const NO_BADGE_TRIM = { x: 0, y: 0, w: 1, h: 1 };

// Single pixel pass over a decoded badge. Computes two things at once:
//   • invert — mean Rec. 709 luminance of opaque pixels exceeds the white
//     threshold (white-on-transparent logos disappear after image-dither
//     against the device's white background, so templates invert them).
//   • trim — the opaque content's bounding box, as canvas fractions, so
//     templates can clip the transparent padding and center the marks at any
//     render size.
export function computeBadgeStats(rgba, width, height) {
    let visible = 0;
    let lumaSum = 0;
    let minX = width;
    let minY = height;
    let maxX = -1;
    let maxY = -1;
    for (let i = 0; i < rgba.length; i += 4) {
        if (rgba[i + 3] < 128) continue;
        lumaSum +=
            0.2126 * rgba[i] + 0.7152 * rgba[i + 1] + 0.0722 * rgba[i + 2];
        visible++;
        const p = i / 4;
        const x = p % width;
        const y = (p / width) | 0;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
    }
    if (visible === 0) return { invert: false, trim: NO_BADGE_TRIM };
    const round = (n) => Math.round(n * 1e4) / 1e4;
    return {
        invert: lumaSum / visible > WHITE_BADGE_LUMA_THRESHOLD,
        trim: {
            x: round(minX / width),
            y: round(minY / height),
            w: round((maxX - minX + 1) / width),
            h: round((maxY - minY + 1) / height),
        },
    };
}
