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
  let waiting
  const ready = new Promise((resolve) => {
    window.addEventListener('message', (event) => {
      if (event.source !== frame.contentWindow)
        return
      const message = event.data || {}
      if (message.type === 'deyslide:ready')
        resolve()
      else if (waiting && (message.type === 'deyslide:rendered' || message.type === 'deyslide:error'))
        waiting(message)
    })
  })
  window.renderSlide = async (request) => {
    await ready
    return new Promise((resolve) => {
      waiting = resolve
      frame.contentWindow.postMessage(request, '*')
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
