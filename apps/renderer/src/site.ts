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

/** The page Chromium opens: the preview in a sandboxed frame, as in the editor, plus a way to drive it. */
const HOST_PAGE = `<!doctype html>
<html>
<head><meta charset="utf-8"><style>html,body{margin:0;background:#000}iframe{display:block;border:0}</style></head>
<body>
<iframe id="preview" sandbox="allow-scripts" src="/preview.html" width="1280" height="720"></iframe>
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
  // Slides are drawn as for an export unless the request names a mode: print
  // mode mounts every click afresh, so no animation is caught halfway and 3D
  // cameras stand at their final pose.
  window.renderSlide = async (request) => {
    await ready
    const id = request.id || 'render-' + ++renders
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
    const path = decodeURIComponent(new URL(request.url ?? '/', 'http://localhost').pathname)
    response.setHeader('access-control-allow-origin', '*')
    if (path === HOST_PATH) {
      response.writeHead(200, { 'content-type': TYPES['.html'] })
      return response.end(HOST_PAGE)
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
