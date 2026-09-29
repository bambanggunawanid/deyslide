import type { Browser, BrowserContext, Page } from 'playwright-core'
import { chromium } from 'playwright-core'
import { HOST_PATH } from './site.ts'

/** One slide to draw, as the Deyslide API sends it. */
export interface SlideToRender {
  content: string
  frontmatter: Record<string, unknown>
  headmatter: Record<string, unknown>
  first: boolean
  clicks: number
}

export interface RenderedSlide {
  png?: string
  clicks: number
  overflow: boolean
  error?: string
}

/** What the preview frame answered: rendered with a click count, an error, or nothing in time. */
interface PreviewAnswer {
  type: string
  clicks?: number
  message?: string
}

/** Requests that may wait their turn. More than that is refused, so a flood cannot pile up. */
const MAX_WAITING = 4

export class BusyError extends Error {}

/** How long one slide may take, components and fonts included. */
const SLIDE_TIMEOUT_MS = 15_000
/** Time for 3D scenes, animations and fonts to settle after the slide renders. */
const SETTLE_MS = 600

/**
 * Draws slides with the web app's own preview in headless Chromium. Each
 * request gets a fresh browser context that can only load the site it is
 * served from: a slide's code cannot reach anything else.
 */
export class SlideDrawer {
  private browser?: Promise<Browser>
  private readonly origin: string
  private readonly executablePath?: string
  /** One request at a time keeps memory use flat on a small server. */
  private queue: Promise<unknown> = Promise.resolve()
  private waiting = 0

  constructor(origin: string, executablePath?: string) {
    this.origin = origin
    this.executablePath = executablePath
  }

  draw(slides: SlideToRender[]): Promise<RenderedSlide[]> {
    if (this.waiting >= MAX_WAITING)
      return Promise.reject(new BusyError())
    this.waiting++
    const run = this.queue.then(() => this.drawNow(slides)).finally(() => {
      this.waiting--
    })
    this.queue = run.catch(() => {})
    return run
  }

  async close() {
    await (await this.browser)?.close()
  }

  private launch() {
    this.browser ??= chromium.launch({ executablePath: this.executablePath }).then((browser) => {
      // A crashed browser is launched again on the next request.
      browser.on('disconnected', () => {
        this.browser = undefined
      })
      return browser
    })
    return this.browser
  }

  private async lockedContext(): Promise<BrowserContext> {
    const context = await (await this.launch()).newContext({
      viewport: { width: 1280, height: 720 },
      serviceWorkers: 'block',
      colorScheme: 'dark',
    })
    await context.route('**/*', route => new URL(route.request().url()).origin === this.origin ? route.continue() : route.abort('blockedbyclient'))
    await context.routeWebSocket(/.*/, socket => socket.close())
    return context
  }

  private async drawNow(slides: SlideToRender[]): Promise<RenderedSlide[]> {
    const context = await this.lockedContext()
    try {
      const page = await context.newPage()
      await page.goto(`${this.origin}${HOST_PATH}`)
      const results: RenderedSlide[] = []
      for (const slide of slides)
        results.push(await this.drawOne(page, slide))
      return results
    }
    finally {
      await context.close()
    }
  }

  private async drawOne(page: Page, slide: SlideToRender): Promise<RenderedSlide> {
    const request = {
      type: 'deyslide:render',
      slide: { content: slide.content, frontmatter: slide.frontmatter, first: slide.first },
      headmatter: slide.headmatter,
      clicks: slide.clicks,
    }
    const timeout = new Promise<PreviewAnswer>(resolve => setTimeout(() => resolve({ type: 'timeout' }), SLIDE_TIMEOUT_MS))
    const answer = await Promise.race([
      page.evaluate(message => (window as unknown as { renderSlide: (value: unknown) => Promise<PreviewAnswer> }).renderSlide(message), request),
      timeout,
    ])
    if (answer.type === 'timeout')
      return { clicks: 0, overflow: false, error: `The slide took longer than ${SLIDE_TIMEOUT_MS / 1000} seconds to render.` }

    await page.waitForLoadState('networkidle', { timeout: SLIDE_TIMEOUT_MS }).catch(() => {})
    await page.waitForTimeout(SETTLE_MS)

    const frame = page.frames().find(item => item.url().endsWith('/preview.html'))
    const measured = frame
      ? await frame.evaluate(() => {
          const slideElement = document.querySelector('[data-testid="slide"]')
          const shown = document.querySelector('[data-testid="preview-error"]')?.textContent?.trim()
          if (!slideElement)
            return { overflow: false, error: shown }
          // Anything drawn past the slide's edges, beyond a pixel of rounding.
          const bounds = slideElement.getBoundingClientRect()
          const overflow = [...slideElement.querySelectorAll('*')].some((element) => {
            const box = element.getBoundingClientRect()
            if (box.width === 0 || box.height === 0)
              return false
            return box.right > bounds.right + 2 || box.bottom > bounds.bottom + 2 || box.left < bounds.left - 2 || box.top < bounds.top - 2
          })
          return { overflow, error: shown }
        })
      : { overflow: false, error: undefined }

    // A slide that fails to compile leaves the previous slide on screen, so it gets no image.
    if (answer.type === 'deyslide:error')
      return { clicks: 0, overflow: false, error: answer.message ?? 'The slide could not be rendered.' }
    const png = await page.locator('#preview').screenshot({ type: 'png', timeout: SLIDE_TIMEOUT_MS })
    return {
      png: png.toString('base64'),
      clicks: answer.clicks ?? 0,
      overflow: measured.overflow,
      ...(measured.error ? { error: measured.error } : {}),
    }
  }
}
