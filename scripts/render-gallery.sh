#!/usr/bin/env bash
#
# 🖼️  render-gallery.sh — visual contact sheet of every render state.
#
# Renders each next-game-response fixture across the four TRMNL views into one
# labeled PNG per fixture, plus a combined contact sheet, for eyeballing the
# Liquid templates after a change. It is a human-review aid, not an automated
# pixel-diff — see pape-docs (the testing session) for why.
#
# Hermetic: it serves the fixtures in test/fixtures/next-game-responses/ over a
# local static server and points trmnlp's polling_url at them, so edge states
# the live backend won't produce on demand (stale, outage, long names) render
# exactly. It drives ../utilities/trmnl-preview.sh (headless Firefox + e-ink
# dithering) per fixture × view.
#
# ⚠️  trmnlp reads its config (and re-polls) only at startup, so the server is
# restarted once per fixture (~30s each). For 7 fixtures expect a few minutes —
# this is an occasional check, not a hot loop.

set -euo pipefail

usage() {
    cat >&2 <<'USAGE'
Usage:
  scripts/render-gallery.sh [--device NAME] [--view VIEW] [--keep]
  scripts/render-gallery.sh --help

  --device NAME   trmnlp device (default og_plus; see trmnl-preview.sh --list)
  --view VIEW     render a single view instead of all four
  --keep          keep the generated .trmnlp.yml on exit (when none existed)

Prints the path to the combined contact sheet on stdout; progress on stderr.
USAGE
}

PLUGIN_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FIXTURE_DIR="$PLUGIN_DIR/test/fixtures/next-game-responses"
PREVIEW="$PLUGIN_DIR/../utilities/trmnl-preview.sh"
TRMNLP_YML="$PLUGIN_DIR/.trmnlp.yml"
OUT_DIR="${TMPDIR:-/tmp}/trmnl-sports-gallery"

DEVICE="og_plus"
VIEWS=(full half_horizontal half_vertical quadrant)
KEEP=0

log() { printf '%s\n' "$*" >&2; }

while [[ $# -gt 0 ]]; do
    case "$1" in
        --device) DEVICE="$2"; shift 2 ;;
        --view) VIEWS=("$2"); shift 2 ;;
        --keep) KEEP=1; shift ;;
        --help|-h) usage; exit 0 ;;
        *) log "❌ unknown arg: $1"; usage; exit 2 ;;
    esac
done

command -v magick >/dev/null || { log "❌ need imagemagick (magick) on PATH"; exit 1; }
command -v python3 >/dev/null || { log "❌ need python3 on PATH"; exit 1; }
[[ -x "$PREVIEW" ]] || { log "❌ trmnl-preview.sh not found at $PREVIEW"; exit 1; }
[[ -d "$FIXTURE_DIR" ]] || { log "❌ no fixtures at $FIXTURE_DIR"; exit 1; }

# ImageMagick on macOS often has no default font configured; montage's -label
# and -title need an explicit one. Use the first available; skip labels if none.
FONT=""
for f in /System/Library/Fonts/Supplemental/Arial.ttf \
    /System/Library/Fonts/Supplemental/Verdana.ttf \
    /Library/Fonts/Arial.ttf; do
    [[ -f "$f" ]] && { FONT="$f"; break; }
done
[[ -z "$FONT" ]] && log "⚠️  no usable font found — montage cells will be unlabeled"

cd "$PLUGIN_DIR"
mkdir -p "$OUT_DIR"

# Back up an existing .trmnlp.yml so we can restore the user's real config.
HAD_ORIGINAL=0
BACKUP="$(mktemp)"
if [[ -f "$TRMNLP_YML" ]]; then cp "$TRMNLP_YML" "$BACKUP"; HAD_ORIGINAL=1; fi

# Free TCP port for the fixture static server (tiny bind/close race is fine).
PORT="$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1]); s.close()')"
HTTP_PID=""

cleanup() {
    [[ -n "$HTTP_PID" ]] && kill "$HTTP_PID" 2>/dev/null || true
    "$PREVIEW" --stop >/dev/null 2>&1 || true
    if [[ "$HAD_ORIGINAL" == 1 ]]; then
        cp "$BACKUP" "$TRMNLP_YML"
    elif [[ "$KEEP" != 1 ]]; then
        rm -f "$TRMNLP_YML"
    fi
    rm -f "$BACKUP"
}
trap cleanup EXIT

# Serve the fixtures so trmnlp can poll them as if they were the live backend.
( cd "$FIXTURE_DIR" && exec python3 -m http.server "$PORT" ) >/dev/null 2>&1 &
HTTP_PID=$!
for _ in $(seq 1 25); do
    curl -sf "http://127.0.0.1:$PORT/" >/dev/null 2>&1 && break
    sleep 0.2
done

sheets=()
for fixture in "$FIXTURE_DIR"/*.json; do
    name="$(basename "$fixture" .json)"
    log "🎬 $name …"

    # Point trmnlp at this fixture. The polling_url override gets custom_fields
    # interpolation, but our URL has none — the fixture IS the polled response.
    cat > "$TRMNLP_YML" <<EOF
custom_fields:
    team_id: "0|0"
    game_type: "any"
variables:
    trmnl:
        plugin_settings:
            polling_url: "http://127.0.0.1:$PORT/$name.json"
EOF

    # Restart so trmnlp re-reads config and re-polls the new fixture.
    "$PREVIEW" --stop >/dev/null 2>&1 || true

    montage_args=()
    if [[ -n "$FONT" ]]; then
        montage_args+=(-font "$FONT" -title "$name")
    else
        # montage labels each tile with its filename by default, which needs a
        # font; with none available, suppress labels so it doesn't error out.
        montage_args+=(-label "")
    fi
    for view in "${VIEWS[@]}"; do
        png="$("$PREVIEW" --view "$view" --device "$DEVICE")"
        [[ -n "$FONT" ]] && montage_args+=(-label "$view")
        montage_args+=("$png")
    done

    sheet="$OUT_DIR/$name.png"
    magick montage "${montage_args[@]}" \
        -tile "${#VIEWS[@]}x1" -geometry +8+8 -background white "$sheet"
    sheets+=("$sheet")
    log "   → $sheet"
done

# Stack the per-fixture sheets. They already carry titles, so suppress the
# default per-tile filename label (-label "") — which also means no font needed.
CONTACT="$OUT_DIR/contact-sheet.png"
contact_args=()
[[ -n "$FONT" ]] && contact_args+=(-font "$FONT")
contact_args+=(-label "")
magick montage "${contact_args[@]}" "${sheets[@]}" -tile "1x${#sheets[@]}" \
    -geometry +0+12 -background white "$CONTACT"

log "✅ contact sheet:"
echo "$CONTACT"
