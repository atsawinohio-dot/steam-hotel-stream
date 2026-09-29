#!/usr/bin/env bash
# Publish a backup copy of the playlist to Cloudflare Pages (account it@theroyshotel.com).
# Backup link: https://roys-hotel-tv.pages.dev/iptv.m3u8
# Re-run after every change to iptv.m3u8 / logos / our own .m3u8 files, or the backup goes stale.
set -euo pipefail
cd "$(dirname "$0")/.."

PRIMARY="https://atsawinohio-dot.github.io/steam-hotel-stream"
BACKUP="https://roys-hotel-tv.pages.dev"
OUT="$(mktemp -d)"
trap 'rm -rf "$OUT"' EXIT

cp playlist.m3u8 segment_*.ts ebony-tv.m3u8 one31.m3u8 gmm25.m3u8 "$OUT"/
cp -r logos "$OUT"/logos
# Point channel 1, logos and our own masters at the backup host, so it works with GitHub down.
sed "s#${PRIMARY}#${BACKUP}#g" iptv.m3u8 > "$OUT/iptv.m3u8"
grep -q "github.io" "$OUT"/*.m3u8 && { echo "github.io still referenced" >&2; exit 1; }

cat > "$OUT/_headers" <<'EOF'
/*
  Access-Control-Allow-Origin: *
/*.m3u8
  Cache-Control: no-cache
EOF

npx wrangler pages deploy "$OUT" --project-name roys-hotel-tv --branch main --commit-dirty=true
