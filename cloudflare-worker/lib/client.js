// Classify the request client from its User-Agent into a small, stable set of
// DESCRIPTIVE buckets, and fold an explicit ?test=1 marker into a test/prod
// source label. index.js logs the raw UA alongside for when the exact string
// matters.
//
// ⚠️ The UA bucket does NOT identify provenance. TRMNL's backend polls with
// BOTH a bare `Ruby` UA (the on-demand device-checkin render path — the bulk of
// real traffic) AND `Faraday` (the preview/validation path, e.g. the unconfigured
// team=0|0 polls), and our own local trmnlp/curl tooling also presents as
// Ruby/Faraday/curl. So a bucket can't say "this is TRMNL" vs "this is us".
//
// The reliable real-traffic signal is the `device` (trmnl.device.friendly_id)
// dimension on /next-game — populated only by real TRMNL device polls — plus the
// explicit ?test=1 marker on our own traffic. Filter `device != ''` for real
// installs; see observability-queries.md.
//
// (This replaced an earlier mapping that assumed Ruby = local preview and
// auto-tagged it `test`, which silently dropped real TRMNL device traffic into
// the test bucket. Root-cause writeup: the telemetry memory + pape-docs.)
//   faraday — Faraday Ruby HTTP client (TRMNL's preview poller AND local tooling)
//   ruby    — bare Ruby Net::HTTP (TRMNL's device-checkin poller AND local tooling)
//   curl    — curl
//   browser — a browser hitting the worker directly (e.g. xhrSelectSearch)
//   other   — bots, unknown clients, or a missing UA
export function classifyClient(userAgent) {
    const ua = (userAgent || "").toLowerCase();
    if (ua.includes("faraday")) return "faraday"; // before ruby: Faraday UAs can also contain "ruby"
    if (ua.includes("ruby")) return "ruby";
    if (ua.includes("curl")) return "curl";
    if (ua.includes("mozilla")) return "browser";
    return "other";
}

// test — explicitly marked with ?test=1 (our dev tools / manual hits append it).
// prod — everything else.
//
// We deliberately do NOT infer test from the UA bucket: TRMNL's real poller
// shares UAs with our local tooling (see above), so any UA-based inference
// either drops real traffic (the old bug) or can't separate us from TRMNL at
// all. Defaulting unmarked traffic to prod means our own un-tagged tests
// over-count prod rather than silently hiding real installs — and the
// `device != ''` filter excludes our tooling from real-install reads regardless.
export function classifySource(testFlag) {
    return testFlag ? "test" : "prod";
}
