# Aspect-ratio balancing fixtures

Six `/next-game` responses chosen to span the hard cases for **visually balancing two side-by-side logos** — the problem worked through in `pape-docs/0079` (the shipped global aspect-ceiling) and `pape-docs/0080` (the harder per-logo perceptual-sizing problem). Each pairs logos that fill their square badge canvas very differently, so a single global "clamp wide logos to N:1" ceiling is right for some pairs and wrong for others.

These are kept separate from `../next-game-responses/` (the render-gallery's hermetic state set) because they're a *tuning bench* for the aspect work, not render-state regression guards. To render one, point `.trmnlp.yml`'s `variables.trmnl.plugin_settings.polling_url` at it over a local static server (the same trick `scripts/render-gallery.sh` uses), or inject its fields via `variables:` directly.

## The matchups, by shape contrast

Aspects are the trimmed opaque-content `w/h` (the worker's `*_badge_trim`); >1 is wide, <1 is tall, ≈1 is square. "Preferred ceiling" is the value Carter eyeballed as best **for that pair alone** from the 6×5 contact sheet (ceilings 1.0–1.4 × these 6 matchups, rendered 2026-05-24).

| Fixture | away (left) | home (right) | shape contrast | preferred ceiling |
| --- | --- | --- | --- | --- |
| `habs-at-knights.json` | Canadiens **1.48** wide | Golden Knights **0.74** tall | wide vs tall | **1.1** |
| `canes-at-stars.json` | Hurricanes **1.66** wide | Stars **1.22** mild-wide | wide vs mild-wide | **1.15** (1.1–1.2 both good) |
| `rays-at-yankees.json` | Rays **1.98** very-wide | Yankees **0.90** ~square | very-wide vs square | **1.2** |
| `storm-at-valkyries.json` | Storm **1.10** ~square | Valkyries **0.73** tall | mild vs tall | **1.0** |
| `chargers-at-saints.json` | Chargers **2.26** extreme-wide | Saints **0.82** tall | extreme bolt vs tall | **1.15** |
| `patriots-at-colts.json` | Patriots **2.15** extreme-wide | Colts **0.94** ~square | extreme vs square | **1.4** |

## What the spread shows

The preferred ceiling ranges **1.0 → 1.4** with no single value optimal for all six — that's the core evidence that a global ceiling is a compromise. Notably the two extreme-wide marks (Chargers, Patriots) disagree hardest: the bolt wants a *lower* ceiling (it reads fine modest), the flying-Elvis a *higher* one. And the Colts horseshoe is the canonical "lots of 0-alpha pixels inside the bbox yet reads big" case that bounding-box math can't see. `0080` is where we think about doing better than one number.

We shipped **1.2** globally for now (`0079`) — it beats the equal-height status quo on most real matchups even though it's nobody's per-pair optimum.
