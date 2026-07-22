#!/usr/bin/env bash
# Package the Otto Tabs Chrome extension (extension/) into a static zip the web app can offer for download
# (Settings + the topbar "Get the Tabs extension" link). Runs automatically before dev/build (npm pre-hooks)
# so the download is always in sync with the extension source. Output lands in public/ → Vite copies it to
# dist/ so it's served at /otto-tabs-extension.zip in both dev and production.
set -e
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/public/otto-tabs-extension.zip"
if [ ! -d "$ROOT/extension" ]; then echo "[zip-extension] no extension/ dir — skipping"; exit 0; fi
if ! command -v zip >/dev/null 2>&1; then echo "[zip-extension] 'zip' not available — skipping download packaging"; exit 0; fi
mkdir -p "$ROOT/public"
rm -f "$OUT"
( cd "$ROOT/extension" && zip -rq "$OUT" . -x '*.DS_Store' )
echo "[zip-extension] packaged extension → public/otto-tabs-extension.zip"
