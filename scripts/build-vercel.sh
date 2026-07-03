#!/bin/bash
# Bundle the Express server into a single plain-JS serverless function for Vercel.
#
# Why bundle ourselves: Vercel's builder does NOT follow `.ts`-extension relative imports — it
# transpiles the entry but ships `import "../server/index.ts"` verbatim, which crashes at runtime
# with ERR_MODULE_NOT_FOUND. So we produce a ready-to-run api/index.mjs (ESM, so top-level await
# and import.meta.url in server/index.ts keep working). npm dependencies stay external — Vercel's
# file tracer sees the imports in the output and packages node_modules for us.
set -e
cd "$(dirname "$0")/.."

echo "Bundling API function for Vercel..."
npx esbuild server/index.ts \
  --bundle \
  --platform=node \
  --target=node20 \
  --format=esm \
  --outfile=api/index.mjs \
  --packages=external

echo "API function bundled to api/index.mjs"
