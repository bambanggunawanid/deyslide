import type { Browser, BrowserContext, Page } from 'playwright-core'
import type { FrameSize } from './site.ts'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium } from 'playwright-core'
import { DEFAULT_SIZE, EXPORT_SIZE, hostPath } from './site.ts'

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

export interface DrawOptions {
  /** The frame size, 1280 by 720 when left out. */
  size?: FrameSize
  /** Media links the slides use (`/api/media/<id>/file`), each mapped to a `data:` URL. */
  media?: Record<string, string>
}

/** One slide of a video, held on screen for `dwellMs` at each click step. */
export interface VideoSlide {
  content: string
  frontmatter: Record<string, unknown>
  first: boolean
  dwellMs: number
}

export interface VideoRequest {
  slides: VideoSlide[]
  /** The deck's settings: the first slide's frontmatter. */
  headmatter: Record<string, unknown>
  /** `each` plays every click step, `last` shows each slide once with all of its steps. */
  clicks: 'each' | 'last'
  media?: Record<string, string>
}

/** A recorded WebM on disk. `discard` removes it once it has been sent. */
export interface RecordedVideo {
  path: string
  discard: () => Promise<void>
}

/** What the preview frame answered: rendered with a click count, an error, or nothing in time. */
export interface PreviewAnswer {
  type: string
  clicks?: number
  message?: string
}

/** A render for the host page. The stage adds the media links the slide uses. */
export interface StageRender {
  slide: { content: string, frontmatter: Record<string, unknown>, first: boolean }
  headmatter: Record<string, unknown>
  clicks: number
  mode?: 'present'
  transition?: { name: string, back: boolean }
}

/** A page showing the preview, as a recording drives it. Tests stand in for Chromium with a double. */
export interface Stage {
  /** Renders a slide, then waits for the frame's answer or for the slide's time to run out. */
  render: (request: StageRender) => Promise<PreviewAnswer>
  /** Waits for fonts, images and 3D scenes to load, and for animations to settle. */
  settle: () => Promise<void>
  /** Keeps what is on screen for `ms`. */
  hold: (ms: number) => Promise<void>
  /** Closes the page. A page that records returns its WebM's path. */
  close: () => Promise<string | undefined>
}

/** Requests that may wait their turn. More than that is refused, so a flood cannot pile up. */
const MAX_WAITING = 4
/** Videos record one at a time, with none waiting: the API sends them one by one. */
const MAX_VIDEOS = 1

export class BusyError extends Error {}
/** A video that cannot be recorded. The message says why, for the person who asked for it. */
export class VideoError extends Error {}

/** How long one slide may take, components and fonts included. */
const SLIDE_TIMEOUT_MS = 15_000
/** Time for 3D scenes, animations and fonts to settle after the slide renders. */
export const SETTLE_MS = 600
/** The longest video. */
export const MAX_VIDEO_MS = 10 * 60_000
/** Time a video allows for drawing each step, on top of the step's dwell. */
export const STEP_ALLOWANCE_MS = 200
/** How much longer than planned a recording may run before it stops: drawing is sometimes slower. */
export const RECORDING_SLACK_MS = 30_000
/** How long counting the click steps of a whole deck may take before a recording. */
export const COUNTING_TIMEOUT_MS = 45_000
/**
 * A click number past any slide's last step: the preview shows the last one.
 * The same number as LAST_CLICKS in the web app's preview/protocol.ts.
 */
export const LAST_CLICKS = 999_999

export const TOO_LONG = `The video would be longer than ${MAX_VIDEO_MS / 60_000} minutes. Show each slide for less time, or export fewer slides.`
const TOO_SLOW = `The slides took too long to draw for a video of at most ${MAX_VIDEO_MS / 60_000} minutes. Show each slide for less time, or export fewer slides.`
const STOPPED = 'The recording was stopped.'

/**
 * How long a video runs: each slide settles once when it comes in, then
 * shows each of its steps for its dwell time plus the time to draw it. The
 * API measures videos with the same rule (videoLength in
 * apps/server/src/exports/video.ts), knowing one step per slide.
 */
export function videoLength(slides: { dwellMs: number, steps: number }[]) {
  return slides.reduce((sum, slide) => sum + SETTLE_MS + slide.steps * (slide.dwellMs + STEP_ALLOWANCE_MS), 0)
}

/** The media links a slide uses, in its content or its frontmatter (a layout's `image` or `background`). */
export function mediaLinksOf(slide: { content: string, frontmatter: Record<string, unknown> }, media: Record<string, string>) {
  const frontmatter = JSON.stringify(slide.frontmatter)
  return Object.keys(media).filter(link => slide.content.includes(link) || frontmatter.includes(link))
}

/** Runs tasks one at a time, and refuses new ones while too many are in line. */
export class TurnQueue {
  private queue: Promise<unknown> = Promise.resolve()
  private waiting = 0
  private readonly limit: number

  /** `limit` counts the running task too. */
  constructor(limit: number) {
    this.limit = limit
  }

  run<T>(task: () => Promise<T>): Promise<T> {
    if (this.waiting >= this.limit)
      return Promise.reject(new BusyError())
    this.waiting++
    const run = this.queue.then(task).finally(() => {
      this.waiting--
    })
    this.queue = run.catch(() => {})
    return run
  }
}

interface HostWindow {
  renderSlide: (request: unknown) => Promise<PreviewAnswer>
  addMedia: (entries: Record<string, string>) => void
}

/**
 * The host page in one browser context. Each media file goes to the page
 * once; a render then names the links its slide uses, and the page hands
 * the frame only those. A video's click steps send no media again.
 */
export class HostPage implements Stage {
  readonly page: Page
  private readonly context: BrowserContext
  private readonly media: Record<string, string>
  private readonly sent = new Set<string>()

  constructor(context: BrowserContext, page: Page, media: Record<string, string> = {}) {
    this.context = context
    this.page = page
    this.media = media
  }

  async render(request: StageRender): Promise<PreviewAnswer> {
    const links = mediaLinksOf(request.slide, this.media)
    const fresh = links.filter(link => !this.sent.has(link))
    if (fresh.length) {
      const entries = Object.fromEntries(fresh.map(link => [link, this.media[link]]))
      await this.page.evaluate(values => (window as unknown as HostWindow).addMedia(values), entries)
      for (const link of fresh)
        this.sent.add(link)
    }
    return renderOn(this.page, { type: 'deyslide:render', ...request, ...(links.length ? { mediaLinks: links } : {}) })
  }

  async settle() {
    await this.page.waitForLoadState('networkidle', { timeout: SLIDE_TIMEOUT_MS }).catch(() => {})
    await this.page.waitForTimeout(SETTLE_MS)
  }

  hold(ms: number) {
    return this.page.waitForTimeout(ms)
  }

  async close() {
    const video = this.page.video()
    // Closing the context finishes writing the video.
    await this.context.close()
    return video ? await video.path() : undefined
  }
}

/**
 * Draws slides with the web app's own preview in headless Chromium. Each
 * request gets a fresh browser context that can only load the site it is
 * served from: a slide's code cannot reach anything else.
 *
 * Slides and videos wait in separate lines, so a long recording never
 * holds up the slide images Claude Code asks for.
 */
export class SlideDrawer {
  private browser?: Promise<Browser>
  private readonly origin: string
  private readonly executablePath?: string
  /** One request at a time keeps memory use flat on a small server. */
  private readonly drawing = new TurnQueue(MAX_WAITING)
  private readonly recording = new TurnQueue(MAX_VIDEOS)

  constructor(origin: string, executablePath?: string) {
    this.origin = origin
    this.executablePath = executablePath
  }

  draw(slides: SlideToRender[], options: DrawOptions = {}): Promise<RenderedSlide[]> {
    return this.drawing.run(() => this.drawNow(slides, options))
  }

  /** Records a video of the slides as presented. `onProgress` gets the share done, from 0 to 1. */
  record(request: VideoRequest, onProgress: (progress: number) => void, signal: AbortSignal): Promise<RecordedVideo> {
    return this.recording.run(() => this.recordNow(request, onProgress, signal))
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

  private async lockedContext(size: FrameSize, videoFolder?: string): Promise<BrowserContext> {
    const context = await (await this.launch()).newContext({
      viewport: size,
      deviceScaleFactor: 1,
      serviceWorkers: 'block',
      colorScheme: 'dark',
      ...(videoFolder ? { recordVideo: { dir: videoFolder, size } } : {}),
    })
    await context.route('**/*', route => new URL(route.request().url()).origin === this.origin ? route.continue() : route.abort('blockedbyclient'))
    await context.routeWebSocket(/.*/, socket => socket.close())
    return context
  }

  /** The host page in a fresh locked context, recording into `videoFolder` when given. */
  private async openHostPage(size: FrameSize, media?: Record<string, string>, videoFolder?: string): Promise<HostPage> {
    const context = await this.lockedContext(size, videoFolder)
    try {
      const page = await context.newPage()
      await page.goto(`${this.origin}${hostPath(size)}`)
      return new HostPage(context, page, media)
    }
    catch (error) {
      await context.close().catch(() => {})
      throw error
    }
  }

  /** A page for a recording, or for counting a deck's steps. Tests replace it. */
  protected openStage(size: FrameSize, media?: Record<string, string>, videoFolder?: string): Promise<Stage> {
    return this.openHostPage(size, media, videoFolder)
  }

  /** The clock recordings are timed with. Tests replace it. */
  protected now() {
    return Date.now()
  }

  protected async drawNow(slides: SlideToRender[], { size = DEFAULT_SIZE, media }: DrawOptions): Promise<RenderedSlide[]> {
    const host = await this.openHostPage(size, media)
    try {
      const results: RenderedSlide[] = []
      for (const slide of slides)
        results.push(await this.drawOne(host, slide))
      return results
    }
    finally {
      await host.close()
    }
  }

  private async drawOne(host: HostPage, slide: SlideToRender): Promise<RenderedSlide> {
    const answer = await host.render({
      slide: { content: slide.content, frontmatter: slide.frontmatter, first: slide.first },
      headmatter: slide.headmatter,
      clicks: slide.clicks,
    })
    if (answer.type === 'timeout')
      return { clicks: 0, overflow: false, error: `The slide took longer than ${SLIDE_TIMEOUT_MS / 1000} seconds to render.` }

    await host.settle()
    const { page } = host

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

  /**
   * How many steps each slide shows in the video. With every click step,
   * each slide is drawn once in a page that does not record, to learn its
   * click count, and counting stops as soon as the video is sure to run
   * longer than allowed.
   */
  private async countSteps(request: VideoRequest, signal: AbortSignal): Promise<number[]> {
    const steps = request.slides.map(() => 1)
    if (request.clicks === 'last')
      return steps
    const stage = await this.openStage(DEFAULT_SIZE)
    try {
      const deadline = this.now() + COUNTING_TIMEOUT_MS
      for (const [index, slide] of request.slides.entries()) {
        if (signal.aborted)
          throw new VideoError(STOPPED)
        if (this.now() > deadline)
          throw new VideoError(TOO_SLOW)
        const answer = await stage.render({
          slide: { content: slide.content, frontmatter: slide.frontmatter, first: slide.first },
          headmatter: request.headmatter,
          clicks: 0,
          mode: 'present',
        })
        if (answer.type !== 'deyslide:rendered')
          throw new VideoError(cannotDraw(index, answer))
        steps[index] = (answer.clicks ?? 0) + 1
        // Slides not counted yet show at least one step each.
        if (videoLength(request.slides.map((item, at) => ({ dwellMs: item.dwellMs, steps: steps[at] }))) > MAX_VIDEO_MS)
          throw new VideoError(TOO_LONG)
      }
      return steps
    }
    finally {
      await stage.close().catch(() => {})
    }
  }

  /**
   * Presents the slides in a page that records itself: each slide comes in
   * with its transition and settles, then steps through its clicks, and
   * every step stays on screen for the slide's dwell time. The video's
   * length is known before recording starts, and longer ones are refused.
   */
  protected async recordNow(request: VideoRequest, onProgress: (progress: number) => void, signal: AbortSignal): Promise<RecordedVideo> {
    const folder = await mkdtemp(join(tmpdir(), 'deyslide-video-'))
    const discard = () => rm(folder, { recursive: true, force: true })
    let stage: Stage | undefined
    try {
      const steps = await this.countSteps(request, signal)
      const total = videoLength(request.slides.map((slide, index) => ({ dwellMs: slide.dwellMs, steps: steps[index] })))
      if (total > MAX_VIDEO_MS)
        throw new VideoError(TOO_LONG)

      stage = await this.openStage(EXPORT_SIZE, request.media, folder)
      const started = this.now()
      /** The planned time of the steps already shown. */
      let shown = 0
      for (const [index, slide] of request.slides.entries()) {
        for (let step = 0; step < steps[index]; step++) {
          if (signal.aborted)
            throw new VideoError(STOPPED)
          // Stop as soon as the video is sure to end past the limit.
          if (this.now() - started + total - shown > MAX_VIDEO_MS + RECORDING_SLACK_MS)
            throw new VideoError(TOO_SLOW)
          const arriving = step === 0
          const answer = await stage.render({
            slide: { content: slide.content, frontmatter: slide.frontmatter, first: slide.first },
            headmatter: request.headmatter,
            clicks: request.clicks === 'last' ? LAST_CLICKS : step,
            mode: 'present',
            // Coming to a slide plays the transition of the slide being left, as in Slidev.
            ...(arriving && index > 0 ? { transition: { name: '', back: false } } : {}),
          })
          if (answer.type !== 'deyslide:rendered')
            throw new VideoError(cannotDraw(index, answer))
          // Fonts, images and 3D scenes load before the slide's time on screen starts.
          if (arriving) {
            await stage.settle()
            shown += SETTLE_MS
          }
          await stage.hold(slide.dwellMs)
          shown += slide.dwellMs + STEP_ALLOWANCE_MS
          onProgress(shown / total)
        }
      }
      const path = await stage.close()
      stage = undefined
      if (!path)
        throw new Error('Chromium recorded no video')
      return { path, discard }
    }
    catch (error) {
      await stage?.close().catch(() => {})
      await discard()
      throw error
    }
  }
}

function cannotDraw(index: number, answer: PreviewAnswer) {
  return `Slide ${index + 1} could not be drawn: ${answer.message ?? `it took longer than ${SLIDE_TIMEOUT_MS / 1000} seconds`}`
}

/** Asks the host page to render, then waits for the frame's answer, or for the slide's time to run out. */
async function renderOn(page: Page, request: Record<string, unknown>): Promise<PreviewAnswer> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<PreviewAnswer>((resolve) => {
    timer = setTimeout(() => resolve({ type: 'timeout' }), SLIDE_TIMEOUT_MS)
  })
  try {
    return await Promise.race([
      page.evaluate(message => (window as unknown as HostWindow).renderSlide(message), request),
      timeout,
    ])
  }
  finally {
    clearTimeout(timer)
  }
}
