// @vitest-environment node
import type { AddressInfo } from 'node:net'
import type { DrawOptions, PreviewAnswer, RecordedVideo, RenderedSlide, SlideToRender, Stage, StageRender, VideoRequest } from '../apps/renderer/src/draw.ts'
import type { Drawer } from '../apps/renderer/src/http.ts'
import type { FrameSize } from '../apps/renderer/src/site.ts'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describeFeature, loadFeature } from '@amiceli/vitest-cucumber'
import { expect } from 'vitest'
import * as renderer from '../apps/renderer/src/draw.ts'
import { BusyError, HostPage, SlideDrawer, VideoError } from '../apps/renderer/src/draw.ts'
import { rendererHandler } from '../apps/renderer/src/http.ts'
import { HOST_PATH, serveSite } from '../apps/renderer/src/site.ts'
import { LAST_CLICKS as PDF_LAST_CLICKS } from '../apps/server/src/exports/pdf.ts'
import * as api from '../apps/server/src/exports/video.ts'
import { HttpSlideRenderer, RenderError, RendererBusyError, RendererRefusedError } from '../apps/server/src/mcp/renderer.ts'
import { LAST_CLICKS as WEB_LAST_CLICKS } from '../apps/web/src/preview/protocol.ts'

const feature = await loadFeature('./export-renderer.feature')

/** The browser context and Playwright page a host page works with. */
type HostArguments = ConstructorParameters<typeof HostPage>

/** The start of a WebM file, standing in for a recording. */
const WEBM = Buffer.concat([Buffer.from([0x1A, 0x45, 0xDF, 0xA3]), Buffer.alloc(200_000, 7)])
const MEDIA = { '/api/media/m1/file': 'data:image/png;base64,iVBORw0KGgo=' }

const slide = (number: number): SlideToRender => ({ content: `# Slide ${number}`, frontmatter: {}, headmatter: { title: 'Sorting' }, first: number === 1, clicks: 1000 })
const videoOf = (count: number, dwellMs = 600): VideoRequest => ({
  slides: Array.from({ length: count }, (_, index) => ({ content: `# Slide ${index + 1}`, frontmatter: {}, first: index === 0, dwellMs: dwellMs + index * 100 })),
  headmatter: { title: 'Sorting' },
  clicks: 'each',
})
const numberOf = (content: string) => Number(/# Slide (\d+)/.exec(content)?.[1] ?? 0)

/** A recorded video in its own folder, as the drawer leaves it. */
async function recording(): Promise<RecordedVideo> {
  const folder = await mkdtemp(join(tmpdir(), 'deyslide-video-test-'))
  const path = join(folder, 'video.webm')
  await writeFile(path, WEBM)
  return { path, discard: () => rm(folder, { recursive: true, force: true }) }
}

/** Stands in for Chromium: keeps what it is asked to draw and record. */
class DrawerDouble implements Drawer {
  readonly draws: { slides: SlideToRender[], options: DrawOptions }[] = []
  readonly recordings: VideoRequest[] = []
  failAt?: number
  busy = false
  busyDrawing = false
  endless = false
  stopped = false
  recorded?: RecordedVideo

  async draw(slides: SlideToRender[], options: DrawOptions): Promise<RenderedSlide[]> {
    if (this.busyDrawing)
      throw new BusyError()
    this.draws.push({ slides, options })
    return slides.map(() => ({ png: 'iVBORw0KGgo=', clicks: 0, overflow: false }))
  }

  async record(request: VideoRequest, onProgress: (progress: number) => void, signal: AbortSignal): Promise<RecordedVideo> {
    if (this.busy)
      throw new BusyError()
    this.recordings.push(request)
    if (this.endless) {
      onProgress(0)
      await new Promise(resolve => signal.addEventListener('abort', resolve))
      this.stopped = true
      throw new VideoError('The recording was stopped.')
    }
    onProgress(0.5)
    if (this.failAt)
      throw new VideoError(`Slide ${this.failAt} could not be drawn: Unexpected token`)
    onProgress(1)
    this.recorded = await recording()
    return this.recorded
  }
}

/** A drawer whose Chromium work is replaced: recordings wait until they are let through. */
class GatedDrawer extends SlideDrawer {
  readonly recordings: VideoRequest[] = []
  readonly gates: (() => void)[] = []

  protected async drawNow(slides: SlideToRender[]): Promise<RenderedSlide[]> {
    return slides.map(() => ({ clicks: 0, overflow: false }))
  }

  protected async recordNow(request: VideoRequest): Promise<RecordedVideo> {
    this.recordings.push(request)
    await new Promise<void>(resolve => this.gates.push(resolve))
    return recording()
  }
}

/**
 * A page that stands in for Chromium's: it answers renders with the
 * slide's click count (its `<v-click>` tags, or `clicks` in its
 * frontmatter), and time passes on the drawer's clock as it draws,
 * settles and holds.
 */
class StageDouble implements Stage {
  readonly renders: StageRender[] = []
  readonly log: string[] = []
  closed = false
  readonly size: FrameSize
  readonly media?: Record<string, string>
  readonly videoFolder?: string
  private readonly drawer: StagedDrawer

  constructor(drawer: StagedDrawer, size: FrameSize, media?: Record<string, string>, videoFolder?: string) {
    this.drawer = drawer
    this.size = size
    this.media = media
    this.videoFolder = videoFolder
  }

  async render(request: StageRender): Promise<PreviewAnswer> {
    this.renders.push(request)
    this.drawer.clock += this.drawer.drawMs
    const { content, frontmatter } = request.slide
    this.log.push(`show ${numberOf(content)}@${request.clicks}${request.transition ? ' with transition' : ''}`)
    if (content.includes('{{ 1 + }}'))
      return { type: 'deyslide:error', message: 'Unexpected token' }
    const clicks = Number(frontmatter.clicks ?? content.match(/<v-click>/g)?.length ?? 0)
    return { type: 'deyslide:rendered', clicks }
  }

  async settle() {
    this.drawer.clock += renderer.SETTLE_MS
    this.log.push('settle')
  }

  async hold(ms: number) {
    this.drawer.clock += ms
    this.log.push(`hold ${ms}`)
    this.drawer.onHold?.()
  }

  async close() {
    this.closed = true
    if (!this.videoFolder)
      return undefined
    const path = join(this.videoFolder, 'video.webm')
    await writeFile(path, WEBM)
    return path
  }
}

/** A drawer whose pages are doubles and whose clock moves only as they work. */
class StagedDrawer extends SlideDrawer {
  readonly stages: StageDouble[] = []
  clock = 0
  drawMs = 0
  onHold?: () => void

  protected async openStage(size: FrameSize, media?: Record<string, string>, videoFolder?: string): Promise<Stage> {
    const stage = new StageDouble(this, size, media, videoFolder)
    this.stages.push(stage)
    return stage
  }

  protected now() {
    return this.clock
  }
}

async function settle() {
  for (let turn = 0; turn < 20; turn++)
    await new Promise(resolve => setImmediate(resolve))
}

/** Waits for the drawer's background work, for up to five seconds. */
async function until(condition: () => boolean, what: string) {
  const started = performance.now()
  while (!condition()) {
    if (performance.now() - started > 5000)
      throw new Error(`Timed out waiting until ${what}`)
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}

describeFeature(feature, ({ Scenario, ScenarioOutline, AfterEachScenario }) => {
  let drawer: DrawerDouble
  let client: HttpSlideRenderer
  let address: string
  let close: (() => void) | undefined
  let refused: { status: number, body: { error?: string } }
  let page: string
  let folder: string
  let file: string
  let progress: number[]
  let failure: unknown
  let gated: GatedDrawer
  let videos: Promise<unknown>[]
  let outcomes: string[]
  let staged: StagedDrawer
  let recorded: RecordedVideo | undefined
  let evaluated: unknown[]
  let host: HostPage

  AfterEachScenario(async () => {
    close?.()
    close = undefined
    if (folder)
      await rm(folder, { recursive: true, force: true })
    for (const gate of gated?.gates.splice(0) ?? [])
      gate()
    await recorded?.discard()
    recorded = undefined
  })

  /** Serves the renderer's API over a drawer double. `videoTimeoutMs` is how long the API waits for a video. */
  async function serve(setUp: (double: DrawerDouble) => void = () => {}, videoTimeoutMs?: number) {
    drawer = new DrawerDouble()
    setUp(drawer)
    const server = createServer(rendererHandler(drawer))
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    address = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    close = () => server.close()
    client = new HttpSlideRenderer(address, 60_000, videoTimeoutMs)
    folder = await mkdtemp(join(tmpdir(), 'deyslide-export-renderer-'))
    file = join(folder, 'deck.webm')
    progress = []
    failure = undefined
  }

  async function post(path: string, body: unknown) {
    const response = await fetch(`${address}${path}`, { method: 'POST', body: JSON.stringify(body) })
    refused = { status: response.status, body: await response.json() as { error?: string } }
  }

  async function askForVideo(request = videoOf(3)) {
    try {
      await client.video(request, { file, onProgress: value => progress.push(value) })
    }
    catch (error) {
      failure = error
    }
  }

  function stagedDrawer(drawMs = 0) {
    staged = new StagedDrawer('http://127.0.0.1:9')
    staged.drawMs = drawMs
    progress = []
    failure = undefined
  }

  /** Records with the staged drawer; keeps the video or the failure. */
  async function stagedRecording(request: VideoRequest, signal = new AbortController().signal) {
    try {
      recorded = await staged.record(request, value => progress.push(value), signal)
    }
    catch (error) {
      failure = error
    }
  }

  const deck = (slides: { content: string, frontmatter?: Record<string, unknown>, dwellMs: number }[], clicks: 'each' | 'last' = 'each'): VideoRequest => ({
    slides: slides.map((item, index) => ({ content: item.content, frontmatter: item.frontmatter ?? {}, first: index === 0, dwellMs: item.dwellMs })),
    headmatter: { title: 'Sorting' },
    clicks,
    media: MEDIA,
  })

  const counting = () => staged.stages[0]
  const recordingStage = () => staged.stages[1]

  Scenario('Slides are drawn at the size a request asks for', ({ Given, When, Then }) => {
    Given('the renderer\'s API in front of a drawer double', () => serve())
    When('the API asks it for 2 slides at 1920 by 1080 with a media link', async () => {
      expect(await client.render([slide(1), slide(2)], { width: 1920, height: 1080, media: MEDIA })).toHaveLength(2)
    })
    Then('the drawer draws both at 1920 by 1080 with that media link', () => {
      expect(drawer.draws).toEqual([{ slides: [slide(1), slide(2)], options: { size: { width: 1920, height: 1080 }, media: MEDIA } }])
    })
    When('the API asks it for a slide without a size', async () => {
      await client.render([slide(3)])
    })
    Then('the drawer draws it at 1280 by 720', () => {
      expect(drawer.draws[1].options).toEqual({ size: { width: 1280, height: 720 } })
    })
  })

  ScenarioOutline('A size out of range is refused', ({ Given, When, Then }, variables) => {
    Given('the renderer\'s API in front of a drawer double', () => serve())
    When('a request asks for slides <width> by <height>', async () => {
      await post('/render', { slides: [slide(1)], width: Number(variables.width), height: Number(variables.height) })
    })
    Then('it is refused with 400 and "<message>"', () => {
      expect(refused).toEqual({ status: 400, body: { error: variables.message } })
      expect(drawer.draws).toEqual([])
    })
  })

  Scenario('The host page frames slides at the size asked for', ({ Given, When, Then }) => {
    let site: Awaited<ReturnType<typeof serveSite>>
    Given('the renderer\'s site is served', async () => {
      folder = await mkdtemp(join(tmpdir(), 'deyslide-export-renderer-'))
      site = await serveSite(folder)
      close = () => site.close()
    })
    When('its host page is opened for 1920 by 1080', async () => {
      page = await (await fetch(`${site.origin}${HOST_PATH}?width=1920&height=1080`)).text()
    })
    Then('its preview frame is 1920 by 1080', () => {
      expect(page).toContain('<iframe id="preview" sandbox="allow-scripts" src="/preview.html" width="1920" height="1080"></iframe>')
    })
    When('its host page is opened for 99999 by 1080', async () => {
      page = await (await fetch(`${site.origin}${HOST_PATH}?width=99999&height=1080`)).text()
    })
    Then('its preview frame is 1280 by 720', () => {
      expect(page).toContain('<iframe id="preview" sandbox="allow-scripts" src="/preview.html" width="1280" height="720"></iframe>')
    })
  })

  Scenario('Each media file goes to the host page once, and each slide gets only its own', ({ Given, When, Then, And }) => {
    const media = { '/api/media/m1/file': 'data:image/png;base64,MQ==', '/api/media/m2/file': 'data:image/png;base64,Mg==', '/api/media/m3/file': 'data:image/png;base64,Mw==' }
    const render = (content: string, clicks: number, frontmatter: Record<string, unknown> = {}) => host.render({ slide: { content, frontmatter, first: false }, headmatter: {}, clicks })
    Given('a host page with three media files', () => {
      evaluated = []
      // What the drawer asks of a Playwright page while rendering: page.evaluate, with the value it passes.
      const fakePage = {
        evaluate: async (_: unknown, value: unknown) => {
          evaluated.push(value)
          return { type: 'deyslide:rendered', clicks: 1 }
        },
      }
      host = new HostPage({} as HostArguments[0], fakePage as unknown as HostArguments[1], media)
    })
    When('a slide that shows the first file is drawn at two click steps', async () => {
      await render('# One\n\n<img src="/api/media/m1/file">', 0)
      await render('# One\n\n<img src="/api/media/m1/file">', 1)
    })
    And('a slide that shows the first file and uses the second as its layout\'s image is drawn', async () => {
      await render('# Two\n\n<img src="/api/media/m1/file">', 0, { layout: 'image-right', image: '/api/media/m2/file' })
    })
    And('a slide without media is drawn', async () => {
      await render('# Three', 0)
    })
    Then('the first file went to the page once, then the second', () => {
      const sent = evaluated.filter(value => !(value as { type?: string }).type)
      expect(sent).toEqual([{ '/api/media/m1/file': media['/api/media/m1/file'] }, { '/api/media/m2/file': media['/api/media/m2/file'] }])
      expect(evaluated.map(value => (value as { type?: string }).type ?? 'media')).toEqual(['media', 'deyslide:render', 'deyslide:render', 'media', 'deyslide:render', 'deyslide:render'])
    })
    And('each render named only the links its slide uses', () => {
      const renders = evaluated.filter(value => (value as { type?: string }).type === 'deyslide:render') as { mediaLinks?: string[], media?: unknown }[]
      expect(renders.map(item => item.mediaLinks)).toEqual([['/api/media/m1/file'], ['/api/media/m1/file'], ['/api/media/m1/file', '/api/media/m2/file'], undefined])
      expect(renders.every(item => item.media === undefined)).toBe(true)
    })
    And('the third file never went to the page', () => {
      expect(JSON.stringify(evaluated)).not.toContain('/api/media/m3/file')
    })
  })

  Scenario('A video comes with its progress, then the WebM', ({ Given, When, Then, And }) => {
    Given('the renderer\'s API in front of a drawer double', () => serve())
    When('the API asks it for a video of 3 slides', () => askForVideo())
    Then('the drawer records the 3 slides in order, each with its time on screen', () => {
      expect(failure).toBeUndefined()
      expect(drawer.recordings).toEqual([videoOf(3)])
    })
    And('the API hears progress 0.5, then 1', () => {
      expect(progress).toEqual([0.5, 1])
    })
    And('the API saves the drawer\'s WebM byte for byte', async () => {
      expect((await readFile(file)).equals(WEBM)).toBe(true)
    })
    And('the drawer\'s recording is removed once it is sent', async () => {
      await until(() => !existsSync(drawer.recorded!.path), 'the recording is removed')
    })
  })

  Scenario('A video that cannot be recorded says why', ({ Given, When, Then, And }) => {
    Given('the renderer\'s API in front of a drawer double that cannot draw slide 2', () => serve((double) => {
      double.failAt = 2
    }))
    When('the API asks it for a video of 3 slides', () => askForVideo())
    Then('the API is told "Slide 2 could not be drawn: Unexpected token"', () => {
      expect(failure).toBeInstanceOf(RenderError)
      expect((failure as Error).message).toBe('Slide 2 could not be drawn: Unexpected token')
      expect(progress).toEqual([0.5])
    })
    And('no video file is left behind', () => {
      expect(existsSync(file)).toBe(false)
    })
  })

  Scenario('A video request that is not valid is refused', ({ Given, When, Then, And }) => {
    Given('the renderer\'s API in front of a drawer double', () => serve())
    When('the API asks it for a video whose slide stays 11 minutes on screen', () => askForVideo(videoOf(1, 11 * 60_000)))
    Then('the API is told the renderer refused it with "Send 1 to 100 slides, each with a dwell time of at most 600000 ms"', () => {
      expect(failure).toBeInstanceOf(RendererRefusedError)
      expect((failure as RendererRefusedError).detail).toBe('Send 1 to 100 slides, each with a dwell time of at most 600000 ms')
    })
    And('the drawer recorded nothing', () => {
      expect(drawer.recordings).toEqual([])
      expect(existsSync(file)).toBe(false)
    })
  })

  Scenario('A busy renderer refuses a video before it starts', ({ Given, When, Then, And }) => {
    Given('the renderer\'s API in front of a drawer double that is busy', () => serve((double) => {
      double.busy = true
    }))
    When('the API asks it for a video of 3 slides', () => askForVideo())
    Then('the API is told the renderer is busy', () => {
      expect(failure).toBeInstanceOf(RendererBusyError)
      expect((failure as Error).message).toBe('The renderer answered 503: {"error":"The renderer is busy"}')
    })
    And('no video file is left behind', () => {
      expect(existsSync(file)).toBe(false)
    })
  })

  Scenario('A busy renderer refuses slides, and the API can tell', ({ Given, When, Then }) => {
    Given('the renderer\'s API in front of a drawer double that is busy drawing', () => serve((double) => {
      double.busyDrawing = true
    }))
    When('the API asks it for 2 slides at 1920 by 1080 with a media link', async () => {
      try {
        await client.render([slide(1), slide(2)], { width: 1920, height: 1080, media: MEDIA })
      }
      catch (error) {
        failure = error
      }
    })
    Then('the API is told the renderer is busy', () => {
      expect(failure).toBeInstanceOf(RendererBusyError)
    })
  })

  Scenario('The recording stops when the API gives up', ({ Given, When, Then, And }) => {
    Given('the renderer\'s API in front of a drawer double whose recording never ends', () => serve((double) => {
      double.endless = true
    }, 300))
    When('the API asks it for a video and gives up after a moment', () => askForVideo())
    Then('the API is told the renderer took too long', () => {
      expect((failure as Error).message).toBe('The renderer took too long to record the video')
      expect(existsSync(file)).toBe(false)
    })
    And('the drawer is asked to stop recording', async () => {
      await until(() => drawer.stopped, 'the drawer stops recording')
    })
  })

  Scenario('Videos record one at a time on a line of their own', ({ Given, When, Then, And }) => {
    Given('a slide drawer whose recordings wait until they are let through', () => {
      // Its Chromium work is replaced, so it never launches a browser.
      gated = new GatedDrawer('http://127.0.0.1:9')
    })
    const ask = (count: number) => gated.record(videoOf(count), () => {}, new AbortController().signal).then(
      async (video) => {
        outcomes.push(`recorded ${count}`)
        await video.discard()
      },
      error => outcomes.push(error instanceof BusyError ? `busy ${count}` : String(error)),
    )
    When('two videos are asked for', async () => {
      outcomes = []
      videos = [ask(1), ask(2)]
      await settle()
    })
    Then('the first records and the second is refused as busy', () => {
      expect(gated.recordings.map(request => request.slides.length)).toEqual([1])
      expect(outcomes).toEqual(['busy 2'])
    })
    And('slides are still drawn while the first video records', async () => {
      expect(await gated.draw([slide(1)])).toEqual([{ clicks: 0, overflow: false }])
      expect(gated.recordings).toHaveLength(1)
    })
    When('the recording is let through', async () => {
      gated.gates.shift()!()
      await Promise.all(videos)
    })
    Then('the first video is recorded', () => {
      expect(outcomes).toEqual(['busy 2', 'recorded 1'])
    })
    And('another video can record now', async () => {
      const third = ask(3)
      await until(() => gated.gates.length === 1, 'the third video starts recording')
      gated.gates.shift()!()
      await third
      expect(outcomes).toEqual(['busy 2', 'recorded 1', 'recorded 3'])
    })
  })

  Scenario('A video counts click steps first, then lets each slide settle and holds every step', ({ Given, When, Then, And }) => {
    Given('a slide drawer with pages that stand in for Chromium', () => stagedDrawer())
    When('it records slide 1 with no clicks for 600 ms a step and slide 2 with 2 clicks for 800 ms a step', async () => {
      await stagedRecording(deck([
        { content: '# Slide 1', dwellMs: 600 },
        { content: '# Slide 2\n\n<v-click>A</v-click>\n\n<v-click>B</v-click>', dwellMs: 800 },
      ]))
      expect(failure).toBeUndefined()
    })
    Then('it first drew each slide at click 0 on a page that does not record, without media', () => {
      expect(staged.stages).toHaveLength(2)
      expect([counting().size, counting().media, counting().videoFolder]).toEqual([{ width: 1280, height: 720 }, undefined, undefined])
      expect(counting().log).toEqual(['show 1@0', 'show 2@0'])
      expect(counting().renders.every(request => request.mode === 'present')).toBe(true)
    })
    And('then it recorded at 1920 by 1080 with the deck\'s media', () => {
      expect([recordingStage().size, recordingStage().media]).toEqual([{ width: 1920, height: 1080 }, MEDIA])
      expect(recordingStage().videoFolder).toBeTruthy()
      expect(recordingStage().renders.every(request => request.mode === 'present' && request.headmatter.title === 'Sorting')).toBe(true)
    })
    And('slide 1 came in, settled and stayed 600 ms', () => {
      expect(recordingStage().log.slice(0, 3)).toEqual(['show 1@0', 'settle', 'hold 600'])
    })
    And('slide 2 came in with its transition, settled and stayed 800 ms, then stayed 800 ms at click 1 and at click 2', () => {
      expect(recordingStage().log.slice(3)).toEqual(['show 2@0 with transition', 'settle', 'hold 800', 'show 2@1', 'hold 800', 'show 2@2', 'hold 800'])
      expect(recordingStage().renders[1].transition).toEqual({ name: '', back: false })
    })
    And('its progress rose to 1 with the planned time', () => {
      const total = renderer.videoLength([{ dwellMs: 600, steps: 1 }, { dwellMs: 800, steps: 3 }])
      expect(progress).toEqual([1400, 3000, 4000, 5000].map(shown => shown / total))
      expect(progress.at(-1)).toBe(1)
    })
    And('both pages were closed and the video was kept', async () => {
      expect(staged.stages.map(stage => stage.closed)).toEqual([true, true])
      expect((await readFile(recorded!.path)).equals(WEBM)).toBe(true)
    })
  })

  Scenario('A video that click steps make too long is refused before it records', ({ Given, When, Then, And }) => {
    Given('a slide drawer with pages that stand in for Chromium', () => stagedDrawer())
    When('it records 3 slides of 3 seconds a step, the first with 100000 clicks', async () => {
      await stagedRecording(deck([
        { content: '# Slide 1', frontmatter: { clicks: 100000 }, dwellMs: 3000 },
        { content: '# Slide 2', dwellMs: 3000 },
        { content: '# Slide 3', dwellMs: 3000 },
      ]))
    })
    Then('it is told "The video would be longer than 10 minutes. Show each slide for less time, or export fewer slides."', () => {
      expect(failure).toBeInstanceOf(VideoError)
      expect((failure as Error).message).toBe('The video would be longer than 10 minutes. Show each slide for less time, or export fewer slides.')
    })
    And('it stopped counting after the first slide', () => {
      expect(counting().log).toEqual(['show 1@0'])
      expect(counting().closed).toBe(true)
    })
    And('no recording page was opened', () => {
      expect(staged.stages).toHaveLength(1)
    })
  })

  Scenario('A slide that cannot be drawn stops the video before it records', ({ Given, When, Then, And }) => {
    Given('a slide drawer with pages that stand in for Chromium', () => stagedDrawer())
    When('it records 3 slides and slide 2 does not compile', async () => {
      await stagedRecording(deck([
        { content: '# Slide 1', dwellMs: 600 },
        { content: '# Slide 2\n\n{{ 1 + }}', dwellMs: 600 },
        { content: '# Slide 3', dwellMs: 600 },
      ]))
    })
    Then('it is told "Slide 2 could not be drawn: Unexpected token"', () => {
      expect(failure).toBeInstanceOf(VideoError)
      expect((failure as Error).message).toBe('Slide 2 could not be drawn: Unexpected token')
    })
    And('no recording page was opened', () => {
      expect(staged.stages).toHaveLength(1)
      expect(counting().closed).toBe(true)
    })
  })

  Scenario('A recording that falls behind stops as soon as it would run long', ({ Given, When, Then, And }) => {
    Given('a slide drawer with pages that stand in for Chromium, each render taking 3 seconds', () => stagedDrawer(3000))
    When('it records the last step of 19 slides for 30 seconds each', async () => {
      // Planned at 19 times 30.8 seconds, under 10 minutes; each slide runs 2.8 seconds late.
      await stagedRecording(deck(Array.from({ length: 19 }, (_, index) => ({ content: `# Slide ${index + 1}`, dwellMs: 30_000 })), 'last'))
    })
    Then('it is told "The slides took too long to draw for a video of at most 10 minutes. Show each slide for less time, or export fewer slides."', () => {
      expect(failure).toBeInstanceOf(VideoError)
      expect((failure as Error).message).toBe('The slides took too long to draw for a video of at most 10 minutes. Show each slide for less time, or export fewer slides.')
    })
    And('it stopped before the last slide, within 10 and a half minutes', () => {
      // Without click steps there is nothing to count, so the only page is the recording.
      expect(staged.stages).toHaveLength(1)
      const holds = staged.stages[0].log.filter(entry => entry.startsWith('hold'))
      expect(holds.length).toBeLessThan(19)
      expect(staged.clock).toBeLessThanOrEqual(renderer.MAX_VIDEO_MS + renderer.RECORDING_SLACK_MS)
    })
    And('the recording page was closed and nothing was kept', () => {
      expect(staged.stages.at(-1)!.closed).toBe(true)
      expect(existsSync(staged.stages.at(-1)!.videoFolder!)).toBe(false)
    })
  })

  Scenario('A recording stops when it is asked to', ({ Given, When, Then, And }) => {
    Given('a slide drawer with pages that stand in for Chromium', () => stagedDrawer())
    When('it records 3 slides and is asked to stop during the first', async () => {
      const stop = new AbortController()
      staged.onHold = () => stop.abort()
      await stagedRecording(deck([1, 2, 3].map(number => ({ content: `# Slide ${number}`, dwellMs: 600 }))), stop.signal)
    })
    Then('it is told "The recording was stopped."', () => {
      expect(failure).toBeInstanceOf(VideoError)
      expect((failure as Error).message).toBe('The recording was stopped.')
      expect(recordingStage().log).toEqual(['show 1@0', 'settle', 'hold 600'])
    })
    And('the recording page was closed and nothing was kept', () => {
      expect(staged.stages.at(-1)!.closed).toBe(true)
      expect(existsSync(staged.stages.at(-1)!.videoFolder!)).toBe(false)
    })
  })

  Scenario('The API and the renderer measure a video the same way', ({ Given, Then, And }) => {
    let samples: { dwellMs: number, steps: number }[][]
    Given('slides with their dwell times and click steps', () => {
      samples = [
        [{ dwellMs: 3000, steps: 1 }],
        [{ dwellMs: 600, steps: 1 }, { dwellMs: 800, steps: 3 }],
        Array.from({ length: 20 }, () => ({ dwellMs: 30_000, steps: 1 })),
        Array.from({ length: 100 }, (_, index) => ({ dwellMs: 500 + index * 7, steps: 1 + (index % 4) })),
      ]
    })
    Then('the API\'s video length and the renderer\'s agree', () => {
      expect(samples.map(api.videoLength)).toEqual(samples.map(renderer.videoLength))
      expect([api.MAX_VIDEO_MS, api.SETTLE_MS, api.STEP_ALLOWANCE_MS]).toEqual([renderer.MAX_VIDEO_MS, renderer.SETTLE_MS, renderer.STEP_ALLOWANCE_MS])
      expect(api.VIDEO_TOO_LONG).toBe(renderer.TOO_LONG)
    })
    And('a slide\'s steps add their dwell plus the time to draw them, after the slide settles', () => {
      expect(renderer.videoLength([{ dwellMs: 800, steps: 3 }])).toBe(600 + 3 * (800 + 200))
    })
  })

  Scenario('The web app, the API and the renderer ask for a slide\'s last step with one number', ({ Then }) => {
    Then('the click number for "the last step" is the same everywhere', () => {
      expect([PDF_LAST_CLICKS, renderer.LAST_CLICKS]).toEqual([WEB_LAST_CLICKS, WEB_LAST_CLICKS])
    })
  })
})
