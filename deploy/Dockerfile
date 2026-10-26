# syntax=docker/dockerfile:1
# Production images for Deyslide, one target per service in compose.yaml.
# The build stage runs `pnpm build` once; the targets below copy what each service needs from it.
#   server    the API bundle (server.mjs) on Node
#   app       nginx with the web app at /, the demo deck at /demo/ and the API proxy
#   renderer  headless Chromium that draws slides for the MCP server

# 1. build everything, with dependencies cached until the lockfile changes
FROM docker.io/library/node:24-bookworm-slim AS build
WORKDIR /src
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY patches ./patches
RUN pnpm fetch
COPY . .
RUN pnpm install --offline --frozen-lockfile && pnpm build
RUN mkdir -p /release/site/demo \
  && cp -r apps/web/dist/. /release/site/ \
  && cp -r apps/deck/dist/. /release/site/demo/

# 2. the API: one bundled file, no node_modules
FROM docker.io/library/node:24-alpine AS server
WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3001
COPY --from=build /src/apps/server/dist/server.mjs ./server.mjs
EXPOSE 3001
CMD ["node", "/app/server.mjs"]

# 3. nginx: the static builds and the routes to the API
FROM docker.io/library/nginx:stable-alpine AS app
COPY deploy/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /release/site /usr/share/nginx/html
EXPOSE 3000

# 4. the slide renderer. Playwright's image carries the Chromium that matches playwright-core 1.63.0.
FROM mcr.microsoft.com/playwright:v1.63.0-noble AS renderer
WORKDIR /renderer
RUN npm install --no-save --no-package-lock --omit=dev playwright-core@1.63.0
COPY --from=build /src/apps/renderer/dist/renderer.mjs ./app/renderer.mjs
COPY --from=build /release/site /site
ENV RENDERER_SITE_DIR=/site
CMD ["node", "/renderer/app/renderer.mjs"]
