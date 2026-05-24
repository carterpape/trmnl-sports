import { defineConfig } from "vitest/config";

export default defineConfig({
    test: {
        // The lib/ modules are pure logic, so tests run in plain Node — Intl,
        // Response, and Request are all globals there. No
        // @cloudflare/vitest-pool-workers needed; that's only required once we
        // start testing the I/O handlers against real bindings (see
        // pape-docs/0073).
        environment: "node",
        include: ["test/**/*.test.js"],
    },
});
