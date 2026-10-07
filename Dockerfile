# Single-service deploy: build the client, then run the Express server (which serves dist/ + the API).
#
# Two stages, on purpose:
#  - `build` needs the toolchain (vite, tsx, the prerender script) and therefore devDependencies;
#  - the runtime stage installs PRODUCTION dependencies only (`npm ci --omit=dev`) and never sees the
#    toolchain or the dev-only package tree. Before this split the shipped image carried the whole
#    devDependency tree — including advisories that only exist in dev tooling (e.g. shell-quote via
#    concurrently) — for no runtime benefit. `tsx` and `cross-env`, the two things `npm start` actually
#    needs, are production dependencies, so the runtime image can still run TypeScript directly.
FROM node:24-slim AS build
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
# vite build + scripts/prerender-landing.tsx (see .dockerignore: scripts/ must stay in the context).
RUN npm run build

FROM node:24-slim AS runtime
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=8788

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Only what the server actually reads at runtime: the Express app itself, the shared types it imports,
# the built client it serves statically, and the tsconfig tsx uses to resolve/transform .ts imports.
# `server/index.ts` fails closed when SESSION_SECRET / DEEPSEEK_API_KEY / COMPOSIO_API_KEY / PUBLIC_URL
# are missing (NODE_ENV=production), so a misconfigured container exits instead of serving a half-working app.
COPY --from=build /app/server ./server
COPY --from=build /app/shared ./shared
COPY --from=build /app/dist ./dist
COPY --from=build /app/tsconfig.json ./tsconfig.json

# node:24-slim already ships an unprivileged `node` user (uid 1000). The server writes nothing to disk
# at runtime (accounts/tasks/integrations all live in Supabase + Composio; the only fs write in the repo
# is the build-time prerender), so nothing needs to be chowned for this to work.
USER node

EXPOSE 8788

# Plain liveness probe on the API's own /healthz (no auth, no session, no DB) using the Node runtime's
# global fetch — no curl/wget needed in the slim image.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8788)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["npm", "start"]
