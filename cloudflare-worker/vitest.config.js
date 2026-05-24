import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

// Two projects, one `npm test` run (see pape-docs/0076):
//   🧪 lib         — pure logic, plain Node. Fast; no workerd runtime needed.
//   🌐 integration — the real fetch boundary (worker.fetch with an injected
//                    env) inside workerd, via the Workers Vitest pool.
export default defineConfig({
    test: {
        // 📊 Coverage targets the worker's I/O surface (index.js), which only
        // the integration project exercises (inside workerd). It MUST use the
        // Istanbul provider: the Workers Vitest pool does not support native V8
        // coverage. Report-only for now — no fail_under gate while the
        // integration suite is still being built out (pape-docs/0076).
        coverage: {
            provider: "istanbul",
            include: ["index.js"],
            reporter: ["text"],
        },
        projects: [
            {
                // Intl, Response, Request are all globals in Node, and nothing
                // under test here touches the Workers runtime.
                test: {
                    name: "lib",
                    environment: "node",
                    include: ["test/**/*.test.js"],
                    exclude: ["test/integration/**"],
                },
            },
            {
                // Bindings + compat date come from wrangler.toml; the per-test
                // `env` is hand-built in test/integration/_harness.js so the
                // telemetry spy and rate-limit/error branches are assertable.
                plugins: [
                    cloudflareTest({
                        wrangler: { configPath: "./wrangler.toml" },
                    }),
                ],
                test: {
                    name: "integration",
                    include: ["test/integration/**/*.test.js"],
                },
            },
        ],
    },
});
