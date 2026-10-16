// The slide renderer for Deyslide's API. It serves the web app's build to
// its own headless Chromium, answers POST /render with PNGs (for Claude
// Code's render_slides and PDF exports) and POST /video with a WebM.
//
//   RENDERER_SITE_DIR   the web app's build (apps/web/dist), holding preview.html
//   RENDERER_LISTEN     a port such as 3102, or unix:/path/to/socket
//   CHROMIUM_PATH       optional: a Chromium to use instead of Playwright's own
//
// In production it runs in a container with no network at all, and the API
// reaches it through a Unix socket in a shared volume.
import { rmSync } from 'node:fs'
import { createServer } from 'node:http'
import process from 'node:process'
import { SlideDrawer } from './draw.ts'
import { rendererHandler } from './http.ts'
import { serveSite } from './site.ts'

const siteDir = process.env.RENDERER_SITE_DIR
const listen = process.env.RENDERER_LISTEN ?? '3102'
if (!siteDir) {
  console.error('Set RENDERER_SITE_DIR to the web app build (apps/web/dist)')
  process.exit(1)
}

const site = await serveSite(siteDir)
const drawer = new SlideDrawer(site.origin, process.env.CHROMIUM_PATH || undefined)
const server = createServer(rendererHandler(drawer))

if (listen.startsWith('unix:')) {
  const path = listen.slice('unix:'.length)
  rmSync(path, { force: true })
  server.listen(path, () => console.info(`Deyslide renderer on ${path}`))
}
else {
  server.listen(Number(listen), '127.0.0.1', () => console.info(`Deyslide renderer on http://127.0.0.1:${listen}`))
}

async function shutdown() {
  server.close()
  site.close()
  await drawer.close()
  process.exit(0)
}
process.on('SIGTERM', () => void shutdown())
process.on('SIGINT', () => void shutdown())
