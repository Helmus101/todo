#!/bin/bash
# Build script for Vercel: bundle server + dependencies into function
set -e

echo "Bundling API function for Vercel..."
npx esbuild api/index.ts \
  --bundle \
  --platform=node \
  --target=node18 \
  --format=esm \
  --outfile=api/index.js \
  --external:@anthropic-ai/sdk \
  --external:@composio/core \
  --external:@supabase/supabase-js \
  --external:bcryptjs \
  --external:express \
  --external:express-session \
  --external:googleapis \
  --external:openai \
  --external:dotenv

echo "API function bundled to api/index.js"
