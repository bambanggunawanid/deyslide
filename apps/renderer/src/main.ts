// The slide renderer for Deyslide's MCP server. It serves the web app's
// build to its own headless Chromium and answers POST /render with PNGs.
//
//   RENDERER_SITE_DIR   the web app's build (apps/web/dist), holding preview.html
//   RENDERER_LISTEN     a port such as 3102, or unix:/path/to/socket
//   CHROMIUM_PATH       optional: a Chromium to use instead of Playwright's own
//
// In production it runs in a container with no network at all, and the API
// reaches it through a Unix socket in a shared volume.
import type { SlideToRender } from './draw.ts'
import { rmSync } from 'node:fs'
import { createServer } from 'node:http'
import process from 'node:process'
import { BusyError, SlideDrawer } from './draw.ts'
import { serveSite } from './site.ts'

/** Matches the MCP server's limit per call. */
const MAX_SLIDES = 6
const MAX_BODY_BYTES = 2 * 1024 * 1024

const siteDir = process.env.RENDERER_SITE_DIR
const listen = process.env.RENDERER_LISTEN ?? '3102'
if (!siteDir) {
  console.error('Set RENDERER_SITE_DIR to the web app build (apps/web/dist)')
  process.exit(1)
}

const site = await serveSite(siteDir)
const drawer = new SlideDrawer(site.origin, process.env.CHROMIUM_PATH || undefined)

function isSlide(value: unknown): value is SlideToRender {
  const slide = value as SlideToRender
  return typeof slide === 'object' && slide !== null
    && typeof slide.content === 'string'
    && typeof slide.frontmatter === 'object' && slide.frontmatter !== null
    && typeof slide.headmatter === 'object' && slide.headmatter !== null
    && typeof slide.first === 'boolean'
    && Number.isInteger(slide.clicks) && slide.clicks >= 0
}

const server = createServer(async (request, response) => {
  const send = (status: number, body: unknown) => {
    response.writeHead(status, { 'content-type': 'application/json' })
    response.end(JSON.stringify(body))
  }
  if (request.method === 'GET' && request.url === '/health')
    return send(200, { ok: true })
  if (request.method !== 'POST' || request.url !== '/render')
    return send(404, { error: 'Not found' })

  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    size += (chunk as Buffer).length
    if (size > MAX_BODY_BYTES)
      return send(413, { error: 'Too large' })
    chunks.push(chunk as Buffer)
  }
  let slides: unknown
  try {
    slides = (JSON.parse(Buffer.concat(chunks).toString('utf8')) as { slides?: unknown }).slides
  }
  catch {
    return send(400, { error: 'The body must be JSON' })
  }
  if (!Array.isArray(slides) || slides.length === 0 || slides.length > MAX_SLIDES || !slides.every(isSlide))
    return send(400, { error: `Send 1 to ${MAX_SLIDES} slides` })

  try {
    send(200, { slides: await drawer.draw(slides) })
  }
  catch (error) {
    if (error instanceof BusyError)
      return send(503, { error: 'The renderer is busy' })
    console.error('Rendering failed', error)
    send(500, { error: 'Rendering failed' })
  }
})

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
