// Shared workbench for the worker's fetch-boundary integration tests
// (pape-docs/0076). Everything here runs inside workerd via the Workers Vitest
// pool. Tests call the default export's `fetch(request, env, ctx)` directly
// with an `env` built here — never the config-supplied bindings — so the
// telemetry datapoint and the rate-limit/error branches stay assertable.

import UPNG from "upng-js"; // default import — see the note in index.js
import { vi } from "vitest";

// Still exported from `cloudflare:test` in pool 0.16; `fetchMock` is not —
// outbound fetch is mocked via vi.stubGlobal (see installFetchMock).
export {
    createExecutionContext,
    waitOnExecutionContext,
} from "cloudflare:test";

// 🏭 A fresh per-test `env`. Knobs cover the branches the router takes off
// bindings: rate-limit denial (→ 429) and a binding that throws (→ 500). The
// returned `captured` array collects every Analytics Engine datapoint so a test
// can assert the one-datapoint-per-request telemetry contract.
export function makeEnv({
    rateLimit = true, // RATE_LIMITER.limit() → { success: rateLimit }
    rateLimitThrows = false, // make .limit() throw, to force the 500 path
    ...rest
} = {}) {
    const captured = [];
    const env = {
        SPORTSDB_API_KEY: "test",
        RATE_LIMITER: {
            limit: async () => {
                if (rateLimitThrows) throw new Error("💥 rate limiter boom");
                return { success: rateLimit };
            },
        },
        ANALYTICS: {
            writeDataPoint: (dp) => captured.push(dp),
        },
        ...rest,
    };
    return { env, captured };
}

// 🔎 Decode one Analytics Engine datapoint by its POSITIONAL contract
// (cloudflare-worker/observability-queries.md). Asserting through this decoder
// means a future reorder of emit()'s blobs/doubles breaks these tests — which
// is the point: the column order is a permanent positional contract.
export function decodeDatapoint(dp) {
    const [
        endpoint,
        outcome,
        cache,
        upstream,
        method,
        team,
        type,
        tz,
        locale,
        client,
        source,
    ] = dp.blobs;
    const [latencyMs, status, upstreamCalls, upstreamFails] = dp.doubles;
    return {
        indexes: dp.indexes,
        endpoint,
        outcome,
        cache,
        upstream,
        method,
        team,
        type,
        tz,
        locale,
        client,
        source,
        latencyMs,
        status,
        upstreamCalls,
        upstreamFails,
    };
}

// 🌐 Replace the global `fetch` the worker uses for its upstream calls. `route`
// maps a request URL → a Response (or undefined). An unmatched call throws,
// the "disableNetConnect" guarantee: a forgotten mock fails loudly instead of
// reaching the live API. Returns the recorded call list. Pair with
// `vi.unstubAllGlobals()` in an afterEach.
export function installFetchMock(route) {
    const calls = [];
    vi.stubGlobal(
        "fetch",
        vi.fn(async (input, init) => {
            const url = typeof input === "string" ? input : input.url;
            calls.push(url);
            const res = route(url, init);
            if (res == null)
                throw new Error(`🚫 unmocked outbound fetch: ${url}`);
            return res;
        }),
    );
    return calls;
}

// 🖼️ A minimal valid PNG (solid WxH, single color) so a test drives the REAL
// UPNG.decode → computeBadgeStats path. Default is opaque white (→ invert:true);
// pass r/g/b 0 for opaque black (→ invert:false). Returns an ArrayBuffer body
// suitable for a mocked badge Response.
export function makeBadgePng({
    w = 4,
    h = 4,
    r = 255,
    g = 255,
    b = 255,
    a = 255,
} = {}) {
    const rgba = new Uint8Array(w * h * 4);
    for (let i = 0; i < w * h; i++) {
        rgba[i * 4] = r;
        rgba[i * 4 + 1] = g;
        rgba[i * 4 + 2] = b;
        rgba[i * 4 + 3] = a;
    }
    return UPNG.encode([rgba.buffer], w, h, 0);
}
