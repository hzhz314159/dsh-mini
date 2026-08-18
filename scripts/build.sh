#!/usr/bin/env bash
# dsh-mini zero-build pipeline: this plugin is plain ESM JavaScript, no tsc needed.
# "Build" = assemble lib/client.js (src/client.js + vendored qrcode-generator,
# MIT — Kazuhiko Arase) and syntax-check both halves + check public assets.
set -euo pipefail
cd "$(dirname "$0")/.."

echo "[dsh-mini build] assembling lib/client.js ..."
if [ -f vendor/qrcode.js ]; then
  node scripts/assemble-client.cjs
else
  # release packages may ship without vendor/ (client.js is pre-assembled)
  [ -f lib/client.js ] || { echo "missing lib/client.js and no vendor/qrcode.js to assemble it" >&2; exit 1; }
  echo "[dsh-mini build] vendor/ absent; keeping pre-assembled lib/client.js"
fi

echo "[dsh-mini build] checking syntax (node --check)..."
node --check lib/index.js
node --check lib/client.js

echo "[dsh-mini build] checking public assets..."
for f in public/index.html public/manifest.webmanifest public/icon-192.png public/icon-512.png; do
  [ -f "$f" ] || { echo "missing asset: $f" >&2; exit 1; }
done

echo "[dsh-mini build] checking gui assets (must ship in the package)..."
for f in gui/dist/index.html gui/manifest.json gui/bundles; do
  [ -e "$f" ] || { echo "missing gui asset: $f — add 'gui' to package.json files, re-copy the gui/ snapshot, then rebuild/pack" >&2; exit 1; }
done

echo "[dsh-mini build] version: $(node -p "require('./package.json').version")"
echo "[dsh-mini build] OK"
