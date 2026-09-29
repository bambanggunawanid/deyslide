import { request } from 'node:http'

/** One slide to draw, as the web preview receives it. */
export interface SlideToRender {
  content: string
  frontmatter: Record<string, unknown>
  /** The deck's headmatter: the first slide's frontmatter. */
  headmatter: Record<string, unknown>
  first: boolean
  /** Which click step to show. A number above the slide's clicks shows the last step. */
  clicks: number
}

export interface RenderedSlide {
  /** PNG, base64. Missing when the slide failed to render. */
  png?: string
  /** How many click steps the slide has. */
  clicks: number
  /** True when content runs past the slide's edges. */
  overflow: boolean
  error?: string
}

/** Draws slides to images. A separate service in production, a fake in tests. */
export interface SlideRenderer {
  render: (slides: SlideToRender[]) => Promise<RenderedSlide[]>
}

export class RendererUnavailableError extends Error {}

/**
 * The renderer service, over HTTP. `address` is an http URL, or
 * `unix:/path/to/socket` for the production container, which has no network.
 */
export class HttpSlideRenderer implements SlideRenderer {
  private readonly address: string
  private readonly timeoutMs: number

  constructor(address: string, timeoutMs = 60_000) {
    this.address = address
    this.timeoutMs = timeoutMs
  }

  render(slides: SlideToRender[]): Promise<RenderedSlide[]> {
    const body = JSON.stringify({ slides })
    const target = this.address.startsWith('unix:')
      ? { socketPath: this.address.slice('unix:'.length), path: '/render' }
      : { host: new URL(this.address).hostname, port: new URL(this.address).port, path: `${new URL(this.address).pathname.replace(/\/$/, '')}/render` }
    return new Promise((resolve, reject) => {
      const call = request({
        ...target,
        method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
        timeout: this.timeoutMs,
      }, (response) => {
        const chunks: Buffer[] = []
        response.on('data', chunk => chunks.push(chunk))
        response.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8')
          if (response.statusCode !== 200)
            return reject(new RendererUnavailableError(`The renderer answered ${response.statusCode}: ${text.slice(0, 200)}`))
          try {
            resolve((JSON.parse(text) as { slides: RenderedSlide[] }).slides)
          }
          catch {
            reject(new RendererUnavailableError('The renderer sent an unreadable answer'))
          }
        })
      })
      call.on('timeout', () => call.destroy(new RendererUnavailableError('The renderer took too long')))
      call.on('error', error => reject(error instanceof RendererUnavailableError ? error : new RendererUnavailableError(`The renderer is unreachable: ${error.message}`)))
      call.end(body)
    })
  }
}
