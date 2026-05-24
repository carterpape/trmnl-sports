// Router-level integration test: the unknown-path 404. This is the walking
// skeleton's first test (pape-docs/0076) — it needs no upstream mock (only the
// rate-limiter stub), so a green run proves the whole harness end to end: the
// Workers pool stands up, worker.fetch accepts an injected env, and the
// emit-once telemetry path fires.

import { describe, expect, it } from "vitest";

import worker from "../../index.js";
import {
    createExecutionContext,
    decodeDatapoint,
    makeEnv,
    waitOnExecutionContext,
} from "./_harness.js";

describe("router", () => {
    it("returns 404 for an unknown path and emits one not_found datapoint", async () => {
        const { env, captured } = makeEnv();
        const ctx = createExecutionContext();

        const response = await worker.fetch(
            new Request("https://worker.test/nope"),
            env,
            ctx,
        );
        await waitOnExecutionContext(ctx);

        expect(response.status).toBe(404);
        expect(await response.text()).toBe("Not found");

        expect(captured).toHaveLength(1);
        const dp = decodeDatapoint(captured[0]);
        expect(dp.endpoint).toBe("other");
        expect(dp.outcome).toBe("not_found");
        expect(dp.cache).toBe("none");
        expect(dp.status).toBe(404);
    });
});
