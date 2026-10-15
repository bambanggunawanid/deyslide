import type { AddressInfo } from 'node:net'
import { readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { extname, join, normalize, sep } from 'node:path'

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.wasm': 'application/wasm',
  '.glb': 'model/gltf-binary',
}

/** The size slides are drawn at unless a request asks for another. */
export const DEFAULT_SIZE = { width: 1280, height: 720 }
/** Exports draw and record at full HD. */
export const EXPORT_SIZE = { width: 1920, height: 1080 }

const WIDTH_RANGE = [320, 3840]
const HEIGHT_RANGE = [180, 2160]

export interface FrameSize {
  width: number
  height: number
}

/** One side of the frame: the length asked for, the default when none is, or what is wrong with it. */
function side(name: string, value: unknown, [min, max]: number[], fallback: number): number | string {
  if (value === undefined)
    return fallback
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max)
    return `The ${name} must be a whole number from ${min} to ${max}`
  return value
}

/** The frame size a request asks for, with the default for a side it leaves out, or a message explaining the problem. */
export function frameSize(width: unknown, height: unknown): FrameSize | string {
  const across = side('width', width, WIDTH_RANGE, DEFAULT_SIZE.width)
  const down = side('height', height, HEIGHT_RANGE, DEFAULT_SIZE.height)
  if (typeof across === 'string')
    return across
  if (typeof down === 'string')
    return down
  return { width: across, height: down }
}

/** The address of the host page for a frame of this size. */
export function hostPath({ width, height }: FrameSize) {
  return `${HOST_PATH}?width=${width}&height=${height}`
}

/** The page Chromium opens: the preview in a sandboxed frame, as in the editor, plus a way to drive it. */
const hostPage = ({ width, height }: FrameSize) => `<!doctype html>
<html>
<head><meta charset="utf-8"><style>html,body{margin:0;background:#000}iframe{display:block;border:0}</style></head>
<body>
<iframe id="preview" sandbox="allow-scripts" src="/preview.html" width="${width}" height="${height}"></iframe>
<script>
  const frame = document.getElementById('preview')
  // Each render gets an id, and the frame replies with it, so a reply meant
  // for an earlier render (a late slide error) is never taken for the
  // current one.
  const waiting = new Map()
  let renders = 0
  const ready = new Promise((resolve) => {
    window.addEventListener('message', (event) => {
      if (event.source !== frame.contentWindow)
        return
      const message = event.data || {}
      if (message.type === 'deyslide:ready') {
        resolve()
      }
      else if ((message.type === 'deyslide:rendered' || message.type === 'deyslide:error') && waiting.has(message.id)) {
        waiting.get(message.id)(message)
        waiting.delete(message.id)
      }
    })
  })
  // Media files come once per page. A render names the links its slide
  // uses, and the frame gets only those, the same ones at every click step.
  const media = {}
  window.addMedia = (entries) => {
    Object.assign(media, entries)
  }
  // Slides are drawn as for an export unless the request names a mode: print
  // mode mounts every click afresh, so no animation is caught halfway and 3D
  // cameras stand at their final pose.
  window.renderSlide = async ({ mediaLinks, ...request }) => {
    await ready
    const id = request.id || 'render-' + ++renders
    if (mediaLinks)
      request.media = Object.fromEntries(mediaLinks.map(link => [link, media[link]]))
    return new Promise((resolve) => {
      waiting.set(id, resolve)
      frame.contentWindow.postMessage({ ...request, mode: request.mode || 'print', id }, '*')
    })
  }
</script>
</body>
</html>`

export const HOST_PATH = '/__render.html'

/**
 * Serves the web app's build on 127.0.0.1, where only this process's
 * Chromium reaches it. The preview frame is sandboxed, so its scripts load
 * as cross origin requests and need the open CORS header, as in production.
 */
export async function serveSite(root: string) {
  const base = normalize(root)
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://localhost')
    const path = decodeURIComponent(url.pathname)
    response.setHeader('access-control-allow-origin', '*')
    if (path === HOST_PATH) {
      const number = (name: string) => url.searchParams.has(name) ? Number(url.searchParams.get(name)) : undefined
      const size = frameSize(number('width'), number('height'))
      response.writeHead(200, { 'content-type': TYPES['.html'] })
      return response.end(hostPage(typeof size === 'string' ? DEFAULT_SIZE : size))
    }
    const file = normalize(join(base, path))
    if (file !== base && !file.startsWith(base + sep))
      return response.writeHead(403).end()
    try {
      const body = await readFile(file)
      response.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' })
      response.end(body)
    }
    catch {
      response.writeHead(404).end()
    }
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return { origin: `http://127.0.0.1:${port}`, close: () => server.close() }
}
