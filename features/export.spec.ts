// @vitest-environment node
import type { Client } from '@modelcontextprotocol/sdk/client/index.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import type { ExportState } from '../apps/server/src/exports/jobs'
import type { UploadTicket } from '../apps/server/src/media/store'
import type { RenderedSlide, RenderOptions, SlideRenderer, SlideToRender, VideoOptions, VideoRequest } from '../apps/server/src/mcp/renderer'
import type { Project } from '../apps/server/src/projects'
import type { TestBrowser, TestServer } from './support/server'
import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs'
import { rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import process from 'node:process'
import { crc32, deflateSync, inflateSync } from 'node:zlib'
import { describeFeature, loadFeature } from '@amiceli/vitest-cucumber'
import { PDFDict, PDFDocument, PDFName, PDFNumber, PDFRawStream } from 'pdf-lib'
import { beforeAll, expect, vi } from 'vitest'
import * as Y from 'yjs'
import { LiveDeckDocuments } from '../apps/server/src/collab/documents'
import { ExportJobs } from '../apps/server/src/exports/jobs'
import { BUSY_WAIT_MS } from '../apps/server/src/exports/pdf'
import { VIDEO_TOO_LONG } from '../apps/server/src/exports/video'
import { MarkdownDecks } from '../apps/server/src/mcp/decks'
import { RenderError, RendererBusyError, RendererRefusedError } from '../apps/server/src/mcp/renderer'
import { ProjectStore } from '../apps/server/src/projects'
import { deckToYDoc, fromMarkdown } from '../packages/deck-model/src'
import { FakeMediaStorage, sampleFile } from './support/media-storage'
import { approveConsent, connectMcp, FakeClaudeCodeAuth, followInBrowser } from './support/mcp-client'
import { closeTestServers, createTestServer, DATABASE_WARM_UP_MS, TestBrowser as Browser, signedInBrowser, TEST_ORIGIN, warmUpDatabase } from './support/server'

const feature = await loadFeature('./export.feature')

beforeAll(warmUpDatabase, DATABASE_WARM_UP_MS)

/** What makes the fake renderer report a slide that does not compile. */
const BROKEN = '{{ 1 + }}'
/** The start of a WebM file, standing in for a recording. */
const WEBM = Buffer.from([0x1A, 0x45, 0xDF, 0xA3, ...Buffer.from(' a recorded deck')])
/** A title of 100 characters whose last one takes two UTF-16 code units. */
const LONG_TITLE = `${'A'.repeat(99)}\u{1F600}`

/** A PNG chunk with its length and checksum. */
function pngChunk(type: string, data: Buffer) {
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data])
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const check = Buffer.alloc(4)
  check.writeUInt32BE(crc32(body))
  return Buffer.concat([length, body, check])
}

/** A PNG of these rows of pixels, 8 bit RGB as Chromium draws them, or RGBA. */
function png(width: number, height: number, rows: Buffer[], alpha = false) {
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header[8] = 8
  header[9] = alpha ? 6 : 2
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(Buffer.concat(rows.map(row => Buffer.concat([Buffer.from([0]), row]))))),
    pngChunk('IEND', Buffer.alloc(0)),
  ])
}

/** A PNG in one color, with transparency when `alpha` is given. */
function solidPng(width: number, height: number, color: number[], alpha?: number) {
  const pixel = Buffer.from(alpha === undefined ? color : [...color, alpha])
  const row = Buffer.concat(Array.from({ length: width }, () => pixel))
  return png(width, height, Array.from({ length: height }, () => row), alpha !== undefined)
}

/** A PNG of random pixels: like a photo, it hardly compresses. */
const photoPng = (side: number) => png(side, side, Array.from({ length: side }, () => randomBytes(side * 3)))

/** The color the fake renderer paints a slide at a click step, so each page can be told apart. */
const colorOf = (slide: number, step: number) => [slide * 25, 80 + step * 10, 160]
const numberOf = (content: string) => Number(/# Slide (\d+)/.exec(content)?.[1] ?? 0)

/**
 * The slide renderer, in memory. Like the real one it draws one request
 * at a time, in the order they arrive, and refuses at once when it is busy.
 * Export batches (1920 by 1080) can be held until a scenario lets them
 * through, and so can recordings. A slide's click count is the number of
 * `<v-click>` in it.
 */
class FakeRenderer implements SlideRenderer {
  /** Every render call that was drawn, in the order it arrived, with the options sent over the wire. */
  readonly calls: { slides: SlideToRender[], options?: Omit<RenderOptions, 'signal'> }[] = []
  /** The signals the API gave export batches. */
  readonly signals: AbortSignal[] = []
  readonly videos: VideoRequest[] = []
  holding = false
  holdingVideos = false
  transparent = false
  photos = false
  /** The export batch, counted from 1, that gets a busy answer once. */
  busyAt?: number
  alwaysBusy = false
  busyAnswers = 0
  /** The renderer refuses export batches with this reason. */
  refusal?: string
  /** A recording fails with this message. */
  videoFailure?: string
  private exportRequests = 0
  private readonly gates: (() => void)[] = []
  private readonly videoGates: (() => void)[] = []
  private line: Promise<unknown> = Promise.resolve()

  /** Export batches waiting to be let through. */
  get held() {
    return this.gates.length
  }

  get heldVideos() {
    return this.videoGates.length
  }

  render(slides: SlideToRender[], options?: RenderOptions): Promise<RenderedSlide[]> {
    const { signal, ...sent } = options ?? {}
    const exporting = sent.width === 1920
    if (exporting) {
      this.exportRequests++
      if (this.refusal)
        return Promise.reject(new RendererRefusedError(`The renderer answered 400: {"error":"${this.refusal}"}`, this.refusal))
      if (this.alwaysBusy || this.exportRequests === this.busyAt) {
        this.busyAnswers++
        return Promise.reject(new RendererBusyError('The renderer answered 503: {"error":"The renderer is busy"}'))
      }
    }
    this.calls.push({ slides, options: options ? sent : undefined })
    if (signal)
      this.signals.push(signal)
    const run = this.line.then(async () => {
      if (this.holding && exporting) {
        await new Promise<void>((resolve, reject) => {
          this.gates.push(resolve)
          signal?.addEventListener('abort', () => reject(signal.reason), { once: true })
        })
      }
      return slides.map(slide => this.draw(slide))
    })
    this.line = run.catch(() => {})
    return run
  }

  async video(request: VideoRequest, { file, onProgress }: VideoOptions) {
    this.videos.push(request)
    if (this.holdingVideos)
      await new Promise<void>(resolve => this.videoGates.push(resolve))
    if (this.videoFailure)
      throw new RenderError(this.videoFailure)
    onProgress?.(0.5)
    onProgress?.(1)
    await writeFile(file, WEBM)
  }

  letOneThrough() {
    this.gates.shift()?.()
  }

  letAllThrough() {
    this.holding = false
    this.holdingVideos = false
    for (const gate of [...this.gates.splice(0), ...this.videoGates.splice(0)])
      gate()
  }

  private draw(slide: SlideToRender): RenderedSlide {
    if (slide.content.includes(BROKEN))
      return { clicks: 0, overflow: false, error: 'Unexpected token.' }
    const clicks = slide.content.match(/<v-click>/g)?.length ?? 0
    const image = this.photos
      ? photoPng(300)
      : solidPng(16, 9, colorOf(numberOf(slide.content), Math.min(slide.clicks, clicks)), this.transparent ? 200 : undefined)
    return { png: image.toString('base64'), clicks, overflow: false }
  }
}

/** A deck as the API stores it, in base64. */
function stateOf(markdown: string) {
  return Buffer.from(Y.encodeStateAsUpdate(deckToYDoc(fromMarkdown(markdown)))).toString('base64')
}

/** A Markdown deck of `count` slides "# Slide N", with frontmatter and extra lines where given. */
function deckMarkdown(count: number, { title, frontmatter = {}, extra = {} }: { title?: string, frontmatter?: Record<number, string>, extra?: Record<number, string> } = {}) {
  return Array.from({ length: count }, (_, index) => {
    const number = index + 1
    const settings = [...(number === 1 && title ? [`title: ${title}`] : []), ...(frontmatter[number] ? [frontmatter[number]] : [])]
    const head = settings.length ? `---\n${settings.join('\n')}\n---\n\n` : number === 1 ? '' : '---\n\n'
    return `${head}# Slide ${number}\n${extra[number] ? `\n${extra[number]}\n` : ''}`
  }).join('\n')
}

/** Lets the server's background work run, for up to five seconds. Timers may be paused, so it never waits on one. */
async function until(condition: () => boolean | Promise<boolean>, what: string) {
  const started = performance.now()
  while (!(await condition())) {
    if (performance.now() - started > 5000)
      throw new Error(`Timed out waiting until ${what}`)
    await new Promise(resolve => setImmediate(resolve))
  }
}

/** Where the server keeps an export's file: its own folder under the system's temporary folder. */
function fileOnDisk(id: string) {
  for (const folder of readdirSync(tmpdir()).filter(name => name.startsWith('deyslide-exports-'))) {
    const match = readdirSync(join(tmpdir(), folder)).find(name => name.startsWith(`${id}.`))
    if (match)
      return join(tmpdir(), folder, match)
  }
  return undefined
}

const exportFolders = () => new Set(readdirSync(tmpdir()).filter(name => name.startsWith('deyslide-exports-')))

/** Each page's size and the first pixel of the image on it, read back from the PDF. */
async function pagesOf(bytes: Uint8Array) {
  const pdf = await PDFDocument.load(bytes)
  return pdf.getPages().map((page) => {
    const images = page.node.Resources()!.lookup(PDFName.of('XObject'), PDFDict)
    const stream = pdf.context.lookup(images.values()[0])
    if (!(stream instanceof PDFRawStream))
      throw new Error('The page has no slide image')
    const width = stream.dict.lookup(PDFName.of('Width'), PDFNumber).asNumber()
    const height = stream.dict.lookup(PDFName.of('Height'), PDFNumber).asNumber()
    // Each row starts with its PNG filter byte, then the pixels.
    const pixels = inflateSync(stream.contents)
    return { size: [page.getWidth(), page.getHeight()], image: [width, height], color: [...pixels.subarray(1, 4)] }
  })
}

/** A process id that no running process has: a child that has ended. */
function endedProcess() {
  return spawnSync(process.execPath, ['-e', '']).pid
}

describeFeature(feature, ({ Background, Scenario, ScenarioOutline, AfterEachScenario }) => {
  let server: TestServer
  let renderer: FakeRenderer | undefined
  let storage: FakeMediaStorage
  let ana: TestBrowser
  let budi: TestBrowser
  let citra: TestBrowser
  let projectId: string
  let deckId: string
  /** Changes to "Sorting" on top of its 8 plain slides. */
  let sorting: { frontmatter: Record<number, string>, extra: Record<number, string> }
  /** Ana's exports, in the order they were started. */
  let ids: string[]
  let others: Record<string, string>
  let refused: { status: number, body: { error?: string } }
  let download: Response
  let downloaded: Buffer
  let claude: Client
  let claudeAnswer: Promise<CallToolResult> | undefined
  let mediaId: string
  let file: string | undefined
  let foldersBefore: Set<string>
  /** Every export started in the scenario, and who started it. */
  let started: { id: string, browser: TestBrowser }[]
  /** Exports made straight on the class, with limits of their own. */
  let jobs: ExportJobs | undefined
  let jobId: string
  let leftovers: string[]

  AfterEachScenario(async () => {
    vi.useRealTimers()
    renderer?.letAllThrough()
    await claudeAnswer?.catch(() => {})
    await jobs?.close()
    jobs = undefined
    // Exports still under way would write into the folders removed below.
    for (const { id, browser } of started) {
      await until(async () => {
        const answer = await browser.json<ExportState>(`/api/exports/${id}`)
        return answer.status === 404 || (answer.body.status !== 'queued' && answer.body.status !== 'running')
      }, 'every export is finished')
    }
    for (const folder of exportFolders()) {
      if (!foldersBefore.has(folder))
        await rm(join(tmpdir(), folder), { recursive: true, force: true })
    }
    await closeTestServers()
  })

  async function start(make: () => FakeRenderer | SlideRenderer | undefined) {
    foldersBefore ??= exportFolders()
    const made = make()
    renderer = made instanceof FakeRenderer ? made : undefined
    storage = new FakeMediaStorage()
    server = await createTestServer({ renderer: made, mediaStorage: storage })
    ids = []
    started = []
    others = {}
    leftovers = []
    sorting = { frontmatter: {}, extra: {} }
    claudeAnswer = undefined
  }

  async function signInAna() {
    ana = await signedInBrowser(server, 'ana@example.com', 'Ana')
    projectId = (await ana.json<Project>('/api/projects', { json: { name: 'Talks' } })).body.id
    deckId = (await ana.json<{ id: string }>(`/api/projects/${projectId}/decks`, { json: { name: 'Sorting', state: stateOf(deckMarkdown(8, { title: 'Sorting' })) } })).body.id
  }

  async function saveSorting() {
    const saved = await ana.request(`/api/decks/${deckId}/state`, { method: 'PUT', json: { state: stateOf(deckMarkdown(8, { title: 'Sorting', ...sorting })) } })
    expect(saved.status).toBe(204)
  }

  /** Starts an export; keeps its id when it is accepted, else the refusal. */
  async function startExport(browser: TestBrowser, body: Record<string, unknown>) {
    const answer = await browser.json<{ id?: string, error?: string }>('/api/exports', { json: body })
    refused = answer
    if (answer.status === 202) {
      started.push({ id: answer.body.id!, browser })
      return answer.body.id!
    }
    return undefined
  }

  async function anaExports(body: Record<string, unknown> = { deckId, format: 'pdf' }) {
    const id = await startExport(ana, body)
    expect(id, JSON.stringify(refused.body)).toBeTruthy()
    ids.push(id!)
    return id!
  }

  const stateOfExport = async (id: string, browser: TestBrowser = ana) => (await browser.json<ExportState>(`/api/exports/${id}`)).body

  async function finished(id: string, browser: TestBrowser = ana) {
    let state: ExportState | undefined
    await until(async () => {
      state = await stateOfExport(id, browser)
      return state.status === 'done' || state.status === 'failed'
    }, 'the export is finished')
    return state!
  }

  async function done(id: string, browser: TestBrowser = ana) {
    const state = await finished(id, browser)
    expect(state.error).toBeUndefined()
    expect(state.status).toBe('done')
    file = fileOnDisk(id)
  }

  async function failsWith(message: string) {
    const state = await finished(ids[0])
    expect(state).toMatchObject({ status: 'failed', error: message })
  }

  async function downloadExport(id = ids.at(-1)!, browser: TestBrowser = ana) {
    download = await browser.request(`/api/exports/${id}/file`)
    downloaded = Buffer.from(await download.arrayBuffer())
  }

  const contentType = () => download.headers.get('content-type')
  const downloadName = () => /filename="([^"]*)"/.exec(download.headers.get('content-disposition') ?? '')?.[1]

  async function connectClaude() {
    const auth = new FakeClaudeCodeAuth(async (url) => {
      const page = await followInBrowser(ana, url)
      return page.pathname === '/oauth/consent' ? approveConsent(ana, page, true) : page
    })
    claude = await connectMcp(server, auth)
  }

  /** Uploads a file to a project's media library, as the person's browser would. */
  async function upload(browser: TestBrowser, project: string, name: string, size: number) {
    const ticket = await browser.json<UploadTicket>(`/api/projects/${project}/media`, { json: { name, type: 'image/png', size } })
    expect(ticket.status).toBe(201)
    const id = ticket.body.media.id
    storage.put(storage.links.find(link => link.kind === 'upload' && link.key.endsWith(`/${id}`))!.key, sampleFile('png', size))
    expect((await browser.request(`/api/media/${id}/finish`, { method: 'POST' })).status).toBe(200)
    return id
  }

  /** Export jobs made straight on the class, over this scenario's database. */
  function directJobs(fake: FakeRenderer, limits: { storedBytes?: number, pdfBytes?: number } = {}) {
    renderer = fake
    const projects = new ProjectStore(server.db)
    jobs = new ExportJobs({ renderer: fake, decks: new MarkdownDecks(projects, new LiveDeckDocuments(server.collab), TEST_ORIGIN), projects, limits })
    return jobs
  }

  async function directState() {
    let state: ExportState | undefined
    await until(async () => {
      state = await jobs!.status('ana', jobId)
      return state?.status === 'done' || state?.status === 'failed'
    }, 'the export is finished')
    return state!
  }

  Background(({ Given, And }) => {
    Given('the Deyslide API with a slide renderer and media storage', () => start(() => new FakeRenderer()))
    And('Ana is signed in with the 8 slide deck "Sorting" in the project "Talks"', signInAna)
  })

  Scenario('A PDF is drawn in batches and its progress follows them', ({ Given, When, Then, And }) => {
    Given('the renderer holds each export batch until it is let through', () => {
      renderer!.holding = true
    })
    When('Ana exports "Sorting" to PDF', async () => {
      await anaExports()
    })
    Then('Ana\'s export is running at 0 percent', async () => {
      await until(() => renderer!.held === 1, 'the first batch reaches the renderer')
      expect(await stateOfExport(ids[0])).toEqual({ status: 'running', progress: 0 })
    })
    And('its file cannot be downloaded yet', async () => {
      const early = await ana.json<{ error: string }>(`/api/exports/${ids[0]}/file`)
      expect(early).toEqual({ status: 409, body: { error: 'The export is not finished yet.' } })
    })
    When('the renderer lets the first batch through', () => {
      renderer!.letOneThrough()
    })
    Then('Ana\'s export is running at 75 percent', async () => {
      await until(() => renderer!.held === 1, 'the second batch reaches the renderer')
      expect(await stateOfExport(ids[0])).toEqual({ status: 'running', progress: 0.75 })
    })
    And('the file on disk already holds the first 6 slide images', () => {
      // Images go to the file as they arrive, so the server never holds a whole PDF in memory.
      const written = readFileSync(fileOnDisk(ids[0])!, 'latin1')
      expect(written.match(/\/Subtype \/Image/g)).toHaveLength(6)
    })
    When('the renderer lets the second batch through', () => {
      renderer!.letOneThrough()
    })
    Then('Ana\'s export is done at 100 percent', async () => {
      await finished(ids[0])
      expect(await stateOfExport(ids[0])).toEqual({ status: 'done', progress: 1 })
    })
    And('the renderer drew slides 1 to 6, then 7 and 8, at 1920 by 1080 and their last click', () => {
      expect(renderer!.calls.map(call => call.slides.map(slide => numberOf(slide.content)))).toEqual([[1, 2, 3, 4, 5, 6], [7, 8]])
      expect(renderer!.calls.map(call => call.options)).toEqual([{ width: 1920, height: 1080 }, { width: 1920, height: 1080 }])
      const slides = renderer!.calls.flatMap(call => call.slides)
      expect(slides.every(slide => slide.clicks >= 1000 && slide.headmatter.title === 'Sorting')).toBe(true)
      expect(slides.map(slide => slide.first)).toEqual([true, false, false, false, false, false, false, false])
    })
  })

  Scenario('Download a PDF named after the deck', ({ Given, When, Then, And }) => {
    Given('the deck is renamed "Sorting / Searching"', async () => {
      expect((await ana.request(`/api/decks/${deckId}`, { method: 'PATCH', json: { name: 'Sorting / Searching' } })).status).toBe(204)
    })
    When('Ana exports "Sorting" to PDF and it is done', async () => {
      await done(await anaExports())
    })
    And('Ana downloads the export', async () => {
      await downloadExport()
    })
    Then('Ana gets "Sorting - Searching.pdf" as "application/pdf"', () => {
      expect(download.status).toBe(200)
      expect(contentType()).toBe('application/pdf')
      expect(download.headers.get('content-disposition')).toBe(`attachment; filename="Sorting - Searching.pdf"; filename*=UTF-8''Sorting%20-%20Searching.pdf`)
      expect(Number(download.headers.get('content-length'))).toBe(downloaded.length)
    })
    And('the PDF has 8 pages of 960 by 540 points, each showing its slide\'s image', async () => {
      const pages = await pagesOf(downloaded)
      expect(pages).toEqual(Array.from({ length: 8 }, (_, index) => ({ size: [960, 540], image: [16, 9], color: colorOf(index + 1, 0) })))
      expect((await PDFDocument.load(downloaded)).getTitle()).toBe('Sorting - Searching')
    })
  })

  Scenario('A long title keeps whole characters in the file name', ({ When, Then, And }) => {
    When('Ana exports a 2 slide Markdown deck titled with 99 letters and an emoji, and it is done', async () => {
      await done(await anaExports({ markdown: deckMarkdown(2, { title: LONG_TITLE }), format: 'pdf' }))
    })
    And('Ana downloads the export', async () => {
      await downloadExport()
    })
    Then('Ana gets the title, emoji included, as the PDF\'s name', () => {
      expect(download.status).toBe(200)
      const encoded = /filename\*=UTF-8''(.*)$/.exec(download.headers.get('content-disposition') ?? '')?.[1]
      expect(decodeURIComponent(encoded!)).toBe(`${LONG_TITLE}.pdf`)
    })
  })

  Scenario('A PDF with every click step', ({ Given, When, Then, And }) => {
    Given('slide 2 of "Sorting" has 2 clicks', async () => {
      sorting.extra[2] = '<v-click>Bubble</v-click>\n\n<v-click>Merge</v-click>'
      await saveSorting()
    })
    When('Ana exports "Sorting" to PDF with every click step and it is done', async () => {
      await done(await anaExports({ deckId, format: 'pdf', options: { clicks: 'each' } }))
    })
    Then('the renderer drew every slide at click 0, then slide 2 at clicks 1 and 2', () => {
      expect(renderer!.calls.map(call => call.slides.map(slide => `${numberOf(slide.content)}@${slide.clicks}`))).toEqual([
        ['1@0', '2@0', '3@0', '4@0', '5@0', '6@0'],
        ['7@0', '8@0'],
        ['2@1', '2@2'],
      ])
    })
    And('the downloaded PDF has 10 pages, slide 2\'s steps in order', async () => {
      await downloadExport()
      const pages = await pagesOf(downloaded)
      expect(pages.map(page => page.color)).toEqual([
        colorOf(1, 0),
        colorOf(2, 0),
        colorOf(2, 1),
        colorOf(2, 2),
        ...[3, 4, 5, 6, 7, 8].map(slide => colorOf(slide, 0)),
      ])
    })
  })

  Scenario('Slide images the renderer sends in other kinds of PNG still make pages', ({ Given, When, Then }) => {
    Given('the renderer sends its slide images as PNGs with transparency', () => {
      renderer!.transparent = true
    })
    When('Ana exports "Sorting" to PDF and it is done', async () => {
      await done(await anaExports())
    })
    Then('the downloaded PDF has 8 pages', async () => {
      await downloadExport()
      const pdf = await PDFDocument.load(downloaded)
      expect(pdf.getPages().map(page => [page.getWidth(), page.getHeight()])).toEqual(Array.from({ length: 8 }, () => [960, 540]))
    })
  })

  Scenario('The API asks the renderer for a video with every click step and each slide\'s own time', ({ Given, When, Then, And }) => {
    Given('slide 3 of "Sorting" asks for 2 seconds on screen', () => {
      sorting.frontmatter[3] = 'videoDwell: 2'
    })
    And('slide 4 of "Sorting" asks for 0.0004 seconds on screen', async () => {
      sorting.frontmatter[4] = 'videoDwell: 0.0004'
      await saveSorting()
    })
    When('Ana exports "Sorting" to video with 600 ms per step and it is done', async () => {
      await done(await anaExports({ deckId, format: 'webm', options: { dwellMs: 600 } }))
    })
    Then('the renderer was asked to record the 8 slides with every click step', () => {
      expect(renderer!.videos).toHaveLength(1)
      const [video] = renderer!.videos
      expect(video.clicks).toBe('each')
      expect(video.headmatter.title).toBe('Sorting')
      expect(video.slides.map(slide => numberOf(slide.content))).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
      expect(video.slides.map(slide => slide.first)).toEqual([true, false, false, false, false, false, false, false])
      expect(video.media).toBeUndefined()
    })
    And('each slide stays 600 ms on screen at each step, slide 3 2000 ms and slide 4 the shortest time, 500 ms', () => {
      expect(renderer!.videos[0].slides.map(slide => slide.dwellMs)).toEqual([600, 600, 2000, 500, 600, 600, 600, 600])
    })
    And('Ana downloads "Sorting.webm" as "video/webm" with the renderer\'s video in it', async () => {
      await downloadExport()
      expect([download.status, downloadName(), contentType()]).toEqual([200, 'Sorting.webm', 'video/webm'])
      expect(downloaded.equals(WEBM)).toBe(true)
    })
  })

  Scenario('A video can show only the last step of each slide', ({ When, Then }) => {
    When('Ana exports "Sorting" to video with the last click step of each slide and it is done', async () => {
      await done(await anaExports({ deckId, format: 'webm', options: { clicks: 'last' } }))
    })
    Then('the renderer was asked to record the 8 slides at their last click step', () => {
      expect(renderer!.videos.map(video => [video.clicks, video.slides.length])).toEqual([['last', 8]])
    })
  })

  ScenarioOutline('An export request is checked before it starts', ({ When, Then }, variables) => {
    const bodies: Record<string, () => Record<string, unknown>> = {
      'a dwell time of 100 ms': () => ({ deckId, format: 'webm', options: { dwellMs: 100 } }),
      'a dwell time of 60001 ms': () => ({ deckId, format: 'webm', options: { dwellMs: 60_001 } }),
      'both a deck and Markdown': () => ({ deckId, markdown: deckMarkdown(2), format: 'pdf' }),
      'neither a deck nor Markdown': () => ({ format: 'pdf' }),
      'the format "gif"': () => ({ deckId, format: 'gif' }),
    }
    When('Ana asks for an export with <request>', async () => {
      await startExport(ana, bodies[variables.request]())
    })
    Then('the export is refused with 400 and "<message>"', () => {
      expect(refused).toEqual({ status: 400, body: { error: variables.message } })
      expect(renderer!.calls).toEqual([])
    })
  })

  Scenario('Slides keep their project images', ({ Given, When, Then, And }) => {
    let photoId: string
    const dataUrl = (size: number) => `data:image/png;base64,${Buffer.from(sampleFile('png', size)).toString('base64')}`
    Given('Ana uploaded "diagram.png" to "Talks" and slide 7 of "Sorting" shows it', async () => {
      mediaId = await upload(ana, projectId, 'diagram.png', 2048)
      sorting.extra[7] = `<img src="/api/media/${mediaId}/file" alt="Diagram">`
    })
    And('Ana uploaded "photo.png" to "Talks" and slide 2 of "Sorting" uses it as its layout\'s image', async () => {
      photoId = await upload(ana, projectId, 'photo.png', 1024)
      sorting.frontmatter[2] = `layout: image-right\nimage: /api/media/${photoId}/file`
      await saveSorting()
    })
    When('Ana exports "Sorting" to PDF and it is done', async () => {
      await done(await anaExports())
    })
    Then('the renderer got "photo.png" as a data URL with the batch that holds slide 2, and "diagram.png" with the one that holds slide 7', () => {
      expect(renderer!.calls.map(call => call.options)).toEqual([
        { width: 1920, height: 1080, media: { [`/api/media/${photoId}/file`]: dataUrl(1024) } },
        { width: 1920, height: 1080, media: { [`/api/media/${mediaId}/file`]: dataUrl(2048) } },
      ])
    })
  })

  Scenario('Media the person may not open stays out of the export', ({ Given, When, Then, And }) => {
    Given('Budi has an account', async () => {
      budi = await signedInBrowser(server, 'budi@example.com', 'Budi')
    })
    And('Budi uploaded "secret.png" to the project "Private"', async () => {
      const project = (await budi.json<Project>('/api/projects', { json: { name: 'Private' } })).body.id
      mediaId = await upload(budi, project, 'secret.png', 2048)
    })
    And('slide 7 of "Sorting" links to "secret.png"', async () => {
      sorting.extra[7] = `<img src="/api/media/${mediaId}/file" alt="Secret">`
      await saveSorting()
    })
    When('Ana exports "Sorting" to PDF and it is done', async () => {
      await done(await anaExports())
    })
    Then('the renderer got no media', () => {
      expect(renderer!.calls.map(call => call.options?.media)).toEqual([undefined, undefined])
    })
  })

  Scenario('An export carries at most 20 MB of media', ({ Given, When, Then }) => {
    Given('Ana uploaded a 21 MB "poster.png" to "Talks" and slide 7 of "Sorting" shows it', async () => {
      mediaId = await upload(ana, projectId, 'poster.png', 21 * 1024 * 1024)
      sorting.extra[7] = `<img src="/api/media/${mediaId}/file" alt="Poster">`
      await saveSorting()
    })
    When('Ana exports "Sorting" to PDF', async () => {
      await anaExports()
    })
    Then('Ana\'s export fails with "The slides use more than 20 MB of media, which is more than an export can hold. Use smaller files."', async () => {
      await failsWith('The slides use more than 20 MB of media, which is more than an export can hold. Use smaller files.')
      expect(renderer!.calls).toEqual([])
    })
  })

  Scenario('A slide that cannot be drawn fails the export with the reason', ({ Given, When, Then, And }) => {
    Given('slide 4 of "Sorting" does not compile in the renderer', async () => {
      sorting.extra[4] = BROKEN
      await saveSorting()
    })
    When('Ana exports "Sorting" to PDF', async () => {
      await anaExports()
    })
    Then('Ana\'s export fails with "Slide 4 could not be drawn: Unexpected token. Fix it, then export again."', async () => {
      const state = await finished(ids[0])
      expect(state).toEqual({ status: 'failed', progress: 0, error: 'Slide 4 could not be drawn: Unexpected token. Fix it, then export again.' })
      expect(fileOnDisk(ids[0])).toBeUndefined()
    })
    And('downloading it says "The export failed, so there is no file. Slide 4 could not be drawn: Unexpected token. Fix it, then export again."', async () => {
      expect(await ana.json(`/api/exports/${ids[0]}/file`)).toEqual({
        status: 409,
        body: { error: 'The export failed, so there is no file. Slide 4 could not be drawn: Unexpected token. Fix it, then export again.' },
      })
    })
  })

  Scenario('An export waits while Claude Code\'s renders keep the renderer busy', ({ Given, When, Then }) => {
    Given('the renderer is busy for the second export batch, once', () => {
      renderer!.busyAt = 2
    })
    When('Ana exports "Sorting" to PDF and it is done', async () => {
      await done(await anaExports())
    })
    Then('the renderer drew slides 1 to 6, then 7 and 8 after one busy answer', () => {
      expect(renderer!.busyAnswers).toBe(1)
      expect(renderer!.calls.map(call => call.slides.map(slide => numberOf(slide.content)))).toEqual([[1, 2, 3, 4, 5, 6], [7, 8]])
    })
  })

  Scenario('A renderer that stays busy fails the export after two minutes', ({ Given, When, Then, And }) => {
    Given('the server\'s clock is paused', () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    })
    And('the renderer is busy for every export batch', () => {
      renderer!.alwaysBusy = true
    })
    When('Ana exports "Sorting" to PDF', async () => {
      await anaExports()
    })
    And('2 minutes pass', async () => {
      await until(() => renderer!.busyAnswers === 1, 'the renderer turns the first batch away')
      await vi.advanceTimersByTimeAsync(BUSY_WAIT_MS)
    })
    Then('Ana\'s export fails with "The slide renderer is busy with other work. Try again in a few minutes."', async () => {
      await failsWith('The slide renderer is busy with other work. Try again in a few minutes.')
      expect(renderer!.busyAnswers).toBeGreaterThan(5)
    })
  })

  Scenario('A request the renderer refuses says why', ({ Given, When, Then }) => {
    Given('the renderer refuses export batches with "Too large"', () => {
      renderer!.refusal = 'Too large'
    })
    When('Ana exports "Sorting" to PDF', async () => {
      await anaExports()
    })
    Then('Ana\'s export fails with "The slide renderer refused this export: Too large."', async () => {
      await failsWith('The slide renderer refused this export: Too large.')
    })
  })

  Scenario('Each account runs one export at a time, and the server two', ({ Given, When, Then, And }) => {
    Given('the renderer holds each export batch until it is let through', () => {
      renderer!.holding = true
    })
    And('Budi and Citra have accounts', async () => {
      budi = await signedInBrowser(server, 'budi@example.com', 'Budi')
      citra = await signedInBrowser(server, 'citra@example.com', 'Citra')
    })
    When('Ana exports "Sorting" to PDF twice, then Budi and Citra export a Markdown deck each', async () => {
      await anaExports()
      await anaExports()
      others.budi = (await startExport(budi, { markdown: deckMarkdown(8, { title: 'Graphs' }), format: 'pdf' }))!
      others.citra = (await startExport(citra, { markdown: deckMarkdown(8, { title: 'Trees' }), format: 'pdf' }))!
      expect(Object.values(others).every(Boolean)).toBe(true)
    })
    Then('Ana\'s first export and Budi\'s run, while Ana\'s second and Citra\'s are queued', async () => {
      await until(() => renderer!.calls.length === 2, 'both running exports reach the renderer')
      expect([
        (await stateOfExport(ids[0])).status,
        (await stateOfExport(others.budi, budi)).status,
        (await stateOfExport(ids[1])).status,
        (await stateOfExport(others.citra, citra)).status,
      ]).toEqual(['running', 'running', 'queued', 'queued'])
    })
    When('the renderer lets every batch through', () => {
      renderer!.letAllThrough()
    })
    Then('all four exports are done', async () => {
      await done(ids[0])
      await done(others.budi, budi)
      await done(ids[1])
      await done(others.citra, citra)
    })
  })

  Scenario('The server records one video at a time', ({ Given, When, Then, And }) => {
    Given('the renderer holds each recording until it is let through', () => {
      renderer!.holdingVideos = true
    })
    And('Budi has an account', async () => {
      budi = await signedInBrowser(server, 'budi@example.com', 'Budi')
    })
    When('Ana exports "Sorting" to video, then Budi exports a Markdown deck to video', async () => {
      await anaExports({ deckId, format: 'webm' })
      others.budi = (await startExport(budi, { markdown: deckMarkdown(2, { title: 'Graphs' }), format: 'webm' }))!
      expect(others.budi).toBeTruthy()
    })
    Then('Ana\'s video records while Budi\'s is queued', async () => {
      await until(() => renderer!.heldVideos === 1, 'the first video reaches the renderer')
      expect([(await stateOfExport(ids[0])).status, (await stateOfExport(others.budi, budi)).status]).toEqual(['running', 'queued'])
      expect(renderer!.videos).toHaveLength(1)
    })
    When('the renderer lets the recordings through', () => {
      renderer!.letAllThrough()
    })
    Then('both videos are done', async () => {
      await done(ids[0])
      await done(others.budi, budi)
      expect(renderer!.videos.map(video => video.headmatter.title)).toEqual(['Sorting', 'Graphs'])
    })
  })

  Scenario('Video export needs a renderer that records', ({ Given, When, Then, And }) => {
    Given('the Deyslide API with a slide renderer that cannot record', () => start(() => {
      const drawing = new FakeRenderer()
      return { render: (slides: SlideToRender[], options?: RenderOptions) => drawing.render(slides, options) }
    }))
    And('Ana is signed in with the 8 slide deck "Sorting" in the project "Talks"', signInAna)
    When('Ana exports "Sorting" to video', async () => {
      await startExport(ana, { deckId, format: 'webm' })
    })
    Then('the export is refused with 503 and "Video export is not available on this server."', () => {
      expect(refused).toEqual({ status: 503, body: { error: 'Video export is not available on this server.' } })
    })
  })

  Scenario('An account has at most 3 exports under way', ({ Given, When, Then }) => {
    Given('the renderer holds each export batch until it is let through', () => {
      renderer!.holding = true
    })
    When('Ana exports "Sorting" to PDF 4 times', async () => {
      for (let count = 0; count < 3; count++)
        await anaExports()
      await startExport(ana, { deckId, format: 'pdf' })
    })
    Then('the fourth export is refused with 429 and "You have 3 exports under way. Wait for one to finish, then try again."', () => {
      expect(refused).toEqual({ status: 429, body: { error: 'You have 3 exports under way. Wait for one to finish, then try again.' } })
    })
  })

  Scenario('An account keeps its 3 newest finished exports', ({ When, Then, And }) => {
    const files: string[] = []
    When('Ana exports "Sorting" to PDF 4 times, one after another', async () => {
      for (let count = 0; count < 4; count++) {
        await done(await anaExports())
        files.push(file!)
      }
    })
    Then('Ana\'s first export and its file are gone', async () => {
      expect((await ana.request(`/api/exports/${ids[0]}`)).status).toBe(404)
      expect((await ana.request(`/api/exports/${ids[0]}/file`)).status).toBe(404)
      await until(() => !existsSync(files[0]), 'the first file is removed')
    })
    And('Ana can still download the other three', async () => {
      for (const id of ids.slice(1)) {
        await downloadExport(id)
        expect(download.status).toBe(200)
      }
    })
  })

  Scenario('Claude Code\'s slide images fit between export batches', ({ Given, When, Then, And }) => {
    Given('Claude Code is connected as Ana', connectClaude)
    And('the renderer holds each export batch until it is let through', () => {
      renderer!.holding = true
    })
    And('Ana is exporting "Sorting" to PDF', async () => {
      await anaExports()
      await until(() => renderer!.held === 1, 'the first batch reaches the renderer')
    })
    When('Claude Code asks for images of slides 1 and 2 of "Sorting"', async () => {
      claudeAnswer = claude.callTool({ name: 'render_slides', arguments: { deckId, slides: [1, 2] } }) as Promise<CallToolResult>
      await until(() => renderer!.calls.length === 2, 'Claude Code\'s request reaches the renderer')
    })
    And('the renderer lets one batch through', () => {
      renderer!.letOneThrough()
    })
    Then('Claude Code gets both images while the export is still running', async () => {
      const answer = await claudeAnswer!
      expect(answer.content.filter(item => item.type === 'image')).toHaveLength(2)
      await until(() => renderer!.held === 1, 'the second batch reaches the renderer')
      expect(await stateOfExport(ids[0])).toEqual({ status: 'running', progress: 0.75 })
    })
    And('the renderer drew Claude Code\'s slides between the two export batches', () => {
      expect(renderer!.calls.map(call => [call.options?.width ?? 'Claude Code', call.slides.length])).toEqual([[1920, 6], ['Claude Code', 2], [1920, 2]])
    })
  })

  Scenario('Anyone who can open a deck may export it', ({ Given, When, Then, And }) => {
    Given('Budi has an account', async () => {
      budi = await signedInBrowser(server, 'budi@example.com', 'Budi')
    })
    And('Ana shared the deck "Sorting" with Budi as a viewer', async () => {
      expect((await ana.json(`/api/decks/${deckId}/sharing`, { json: { email: 'budi@example.com', role: 'viewer' } })).status).toBe(201)
    })
    When('Budi exports "Sorting" to PDF and it is done', async () => {
      others.budi = (await startExport(budi, { deckId, format: 'pdf' }))!
      expect(others.budi, JSON.stringify(refused.body)).toBeTruthy()
      await done(others.budi, budi)
    })
    Then('Budi downloads "Sorting.pdf"', async () => {
      await downloadExport(others.budi, budi)
      expect([download.status, downloadName(), contentType()]).toEqual([200, 'Sorting.pdf', 'application/pdf'])
    })
  })

  Scenario('An export goes when its deck can no longer be opened', ({ Given, When, Then, And }) => {
    Given('Budi has an account', async () => {
      budi = await signedInBrowser(server, 'budi@example.com', 'Budi')
    })
    And('Ana shared the deck "Sorting" with Budi as a viewer', async () => {
      expect((await ana.json(`/api/decks/${deckId}/sharing`, { json: { email: 'budi@example.com', role: 'viewer' } })).status).toBe(201)
    })
    And('Budi exported "Sorting" to PDF and it is done', async () => {
      others.budi = (await startExport(budi, { deckId, format: 'pdf' }))!
      await done(others.budi, budi)
      expect(file).toBeTruthy()
    })
    When('Ana deletes "Sorting"', async () => {
      expect((await ana.request(`/api/decks/${deckId}`, { method: 'DELETE' })).status).toBe(204)
    })
    Then('Budi can neither see the export nor download it', async () => {
      expect((await budi.request(`/api/exports/${others.budi}/file`)).status).toBe(404)
      expect((await budi.request(`/api/exports/${others.budi}`)).status).toBe(404)
    })
    And('its file is gone', async () => {
      await until(() => !existsSync(file!), 'the file is removed')
    })
  })

  Scenario('An export that waited in line checks the deck can still be opened', ({ Given, When, Then, And }) => {
    Given('the renderer holds each export batch until it is let through', () => {
      renderer!.holding = true
    })
    And('Budi and Citra have accounts', async () => {
      budi = await signedInBrowser(server, 'budi@example.com', 'Budi')
      citra = await signedInBrowser(server, 'citra@example.com', 'Citra')
    })
    And('Ana shared the deck "Sorting" with Budi as a viewer', async () => {
      expect((await ana.json(`/api/decks/${deckId}/sharing`, { json: { email: 'budi@example.com', role: 'viewer' } })).status).toBe(201)
    })
    When('Ana and Citra export a Markdown deck each, then Budi exports "Sorting" to PDF', async () => {
      await anaExports({ markdown: deckMarkdown(2, { title: 'Graphs' }), format: 'pdf' })
      others.citra = (await startExport(citra, { markdown: deckMarkdown(2, { title: 'Trees' }), format: 'pdf' }))!
      others.budi = (await startExport(budi, { deckId, format: 'pdf' }))!
      expect((await stateOfExport(others.budi, budi)).status).toBe('queued')
    })
    And('Ana deletes "Sorting"', async () => {
      expect((await ana.request(`/api/decks/${deckId}`, { method: 'DELETE' })).status).toBe(204)
    })
    And('the renderer lets every batch through', async () => {
      await until(() => renderer!.calls.length === 2, 'both running exports reach the renderer')
      renderer!.letAllThrough()
      await done(ids[0])
      await done(others.citra, citra)
    })
    Then('the renderer never drew "Sorting"', async () => {
      await until(async () => (await budi.request(`/api/exports/${others.budi}`)).status === 404, 'Budi\'s export is gone')
      expect(renderer!.calls.map(call => call.slides[0].headmatter.title)).toEqual(['Graphs', 'Trees'])
    })
    And('Budi can neither see the export nor download it', async () => {
      expect((await budi.request(`/api/exports/${others.budi}`)).status).toBe(404)
      expect((await budi.request(`/api/exports/${others.budi}/file`)).status).toBe(404)
    })
  })

  Scenario('Strangers can neither export a deck nor see someone\'s export', ({ Given, When, Then, And }) => {
    Given('Ana exported "Sorting" to PDF and it is done', async () => {
      await done(await anaExports())
    })
    And('Citra has an account', async () => {
      citra = await signedInBrowser(server, 'citra@example.com', 'Citra')
    })
    When('Citra exports "Sorting" to PDF', async () => {
      await startExport(citra, { deckId, format: 'pdf' })
    })
    Then('Citra is told the deck is not found', () => {
      expect(refused).toEqual({ status: 404, body: { error: 'Not found' } })
    })
    And('Citra can neither see Ana\'s export nor download it', async () => {
      expect((await citra.request(`/api/exports/${ids[0]}`)).status).toBe(404)
      expect((await citra.request(`/api/exports/${ids[0]}/file`)).status).toBe(404)
      expect((await new Browser(server).request(`/api/exports/${ids[0]}`)).status).toBe(401)
    })
  })

  Scenario('Markdown is checked before it is exported', ({ When, Then }) => {
    When('Ana exports Markdown whose first frontmatter is broken', async () => {
      await startExport(ana, { markdown: '---\ntitle: [unclosed\n---\n\n# One\n', format: 'pdf' })
    })
    Then('the export is refused with 400 and a message starting "The frontmatter is not valid YAML."', () => {
      expect(refused.status).toBe(400)
      expect(refused.body.error).toMatch(/^The frontmatter is not valid YAML\./)
    })
    When('Ana exports a 2 slide Markdown deck titled "Notes" and it is done', async () => {
      await done(await anaExports({ markdown: deckMarkdown(2, { title: 'Notes' }), format: 'pdf' }))
    })
    Then('Ana downloads "Notes.pdf" with 2 pages', async () => {
      await downloadExport()
      expect(downloadName()).toBe('Notes.pdf')
      expect(await pagesOf(downloaded)).toHaveLength(2)
    })
  })

  Scenario('An export holds at most 100 slides', ({ When, Then }) => {
    When('Ana exports Markdown with 101 slides to PDF', async () => {
      await startExport(ana, { markdown: deckMarkdown(101), format: 'pdf' })
    })
    Then('the export is refused with 400 and "The deck has 101 slides. An export can have at most 100."', () => {
      expect(refused).toEqual({ status: 400, body: { error: 'The deck has 101 slides. An export can have at most 100.' } })
    })
  })

  Scenario('A video is at most 10 minutes long', ({ When, Then }) => {
    When('Ana exports Markdown with 20 slides to video with 30000 ms per step', async () => {
      await startExport(ana, { markdown: deckMarkdown(20), format: 'webm', options: { dwellMs: 30000 } })
    })
    Then('the export is refused with 400 and "The video would be longer than 10 minutes. Show each slide for less time, or export fewer slides."', () => {
      // 20 steps of 30 seconds fill 10 minutes, and each slide's time to come in and be drawn goes over.
      expect(refused).toEqual({ status: 400, body: { error: 'The video would be longer than 10 minutes. Show each slide for less time, or export fewer slides.' } })
    })
  })

  Scenario('A video\'s click steps count toward its 10 minutes in the renderer', ({ Given, When, Then }) => {
    Given('the renderer finds the video too long once it counts the click steps', () => {
      renderer!.videoFailure = VIDEO_TOO_LONG
    })
    When('Ana exports "Sorting" to video', async () => {
      await anaExports({ deckId, format: 'webm' })
    })
    Then('Ana\'s export fails with "The video would be longer than 10 minutes. Show each slide for less time, or export fewer slides."', async () => {
      await failsWith('The video would be longer than 10 minutes. Show each slide for less time, or export fewer slides.')
      expect(fileOnDisk(ids[0])).toBeUndefined()
    })
  })

  Scenario('A PDF holds at most 300 pages, and finds out before drawing click steps', ({ Given, When, Then, And }) => {
    Given('slide 2 of "Sorting" has 400 clicks', async () => {
      sorting.extra[2] = Array.from({ length: 400 }, (_, index) => `<v-click>${index}</v-click>`).join('\n')
      await saveSorting()
    })
    When('Ana exports "Sorting" to PDF with every click step', async () => {
      await anaExports({ deckId, format: 'pdf', options: { clicks: 'each' } })
    })
    Then('Ana\'s export fails with "The PDF would have more than 300 pages. Export the last click step of each slide instead."', async () => {
      await failsWith('The PDF would have more than 300 pages. Export the last click step of each slide instead.')
    })
    And('the renderer drew only the first batch', () => {
      expect(renderer!.calls.map(call => call.slides.map(slide => `${numberOf(slide.content)}@${slide.clicks}`))).toEqual([['1@0', '2@0', '3@0', '4@0', '5@0', '6@0']])
    })
  })

  Scenario('A PDF has a size limit', ({ Given, When, Then }) => {
    Given('exports on a server whose PDFs may hold 0.5 MB, with a renderer that draws photos', () => {
      const photos = new FakeRenderer()
      photos.photos = true
      directJobs(photos, { pdfBytes: 0.5 * 1024 * 1024 })
    })
    When('Ana exports a 2 slide Markdown deck to PDF there', async () => {
      jobId = (await jobs!.start('ana', { markdown: deckMarkdown(2), format: 'pdf' }))!
    })
    Then('that export fails with "The PDF would be larger than 0.5 MB. Use smaller images, or export fewer slides."', async () => {
      expect(await directState()).toMatchObject({ status: 'failed', error: 'The PDF would be larger than 0.5 MB. Use smaller images, or export fewer slides.' })
      expect(fileOnDisk(jobId)).toBeUndefined()
    })
  })

  Scenario('The server stops taking exports while their files fill its space', ({ Given, When, Then }) => {
    Given('exports on a server that keeps 1 KB of finished files', () => {
      directJobs(new FakeRenderer(), { storedBytes: 1024 })
    })
    When('Ana exports a 2 slide Markdown deck to PDF there and it is done', async () => {
      jobId = (await jobs!.start('ana', { markdown: deckMarkdown(2), format: 'pdf' }))!
      expect(await directState()).toMatchObject({ status: 'done' })
      expect(readFileSync(fileOnDisk(jobId)!).length).toBeGreaterThan(1024)
    })
    Then('Ana\'s next export there is refused with "The server has no room for more exports right now. Try again in a few minutes."', async () => {
      await expect(jobs!.start('ana', { markdown: deckMarkdown(2), format: 'pdf' })).rejects.toThrow('The server has no room for more exports right now. Try again in a few minutes.')
    })
  })

  Scenario('A finished export is removed after an hour', ({ Given, When, Then, And }) => {
    Given('the server\'s clock is paused', () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    })
    And('Ana exported "Sorting" to PDF and it is done', async () => {
      await done(await anaExports())
      expect(file).toBeTruthy()
    })
    When('59 minutes pass', () => {
      vi.advanceTimersByTime(59 * 60_000)
    })
    Then('Ana can still download the export', async () => {
      await downloadExport()
      expect(download.status).toBe(200)
      expect(existsSync(file!)).toBe(true)
    })
    When('one more minute passes', () => {
      vi.advanceTimersByTime(60_000)
    })
    Then('the export and its file are gone', async () => {
      expect((await ana.request(`/api/exports/${ids[0]}`)).status).toBe(404)
      expect((await ana.request(`/api/exports/${ids[0]}/file`)).status).toBe(404)
      await until(() => !existsSync(file!), 'the file is removed')
    })
  })

  Scenario('A downloaded export is removed 10 minutes later', ({ Given, When, Then, And }) => {
    Given('the server\'s clock is paused', () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    })
    And('Ana exported "Sorting" to PDF and it is done', async () => {
      await done(await anaExports())
      expect(file).toBeTruthy()
    })
    When('Ana downloads the export', async () => {
      await downloadExport()
      expect(download.status).toBe(200)
    })
    And('9 minutes pass', () => {
      vi.advanceTimersByTime(9 * 60_000)
    })
    Then('Ana can still download the export', async () => {
      await downloadExport()
      expect(download.status).toBe(200)
      expect(existsSync(file!)).toBe(true)
    })
    When('one more minute passes', () => {
      vi.advanceTimersByTime(60_000)
    })
    Then('the export and its file are gone', async () => {
      expect((await ana.request(`/api/exports/${ids[0]}`)).status).toBe(404)
      expect((await ana.request(`/api/exports/${ids[0]}/file`)).status).toBe(404)
      await until(() => !existsSync(file!), 'the file is removed')
    })
  })

  Scenario('Shutting down stops exports and removes their files', ({ Given, When, Then, And }) => {
    Given('exports on a server whose renderer holds each batch', () => {
      const holding = new FakeRenderer()
      holding.holding = true
      directJobs(holding)
    })
    And('Ana is exporting a 2 slide Markdown deck there', async () => {
      jobId = (await jobs!.start('ana', { markdown: deckMarkdown(2), format: 'pdf' }))!
      await until(() => renderer!.held === 1, 'the batch reaches the renderer')
      file = fileOnDisk(jobId)
      expect(file).toBeTruthy()
    })
    When('that server shuts down', async () => {
      await jobs!.close()
    })
    Then('the renderer is told to stop', () => {
      expect(renderer!.signals.map(signal => signal.aborted)).toEqual([true])
    })
    And('the export\'s folder is gone', () => {
      expect(existsSync(dirname(file!))).toBe(false)
    })
  })

  Scenario('Folders that earlier runs left behind are removed', ({ Given, When, Then, And }) => {
    const leaveFolder = (pid: number, start: number) => {
      const folder = join(tmpdir(), `deyslide-exports-${pid}-${start}-test${leftovers.length}`)
      mkdirSync(folder)
      leftovers.push(folder)
    }
    Given('an export folder left by a process that has ended', () => {
      leaveFolder(endedProcess(), 1)
    })
    And('one left by an earlier start of this process', () => {
      leaveFolder(process.pid, 1)
    })
    And('one that a running process still uses', () => {
      leaveFolder(process.ppid, 1)
    })
    When('Ana exports "Sorting" to PDF and it is done', async () => {
      await done(await anaExports())
    })
    Then('the first two folders are gone, and the third is kept', async () => {
      expect(leftovers.map(folder => existsSync(folder))).toEqual([false, false, true])
      await rm(leftovers[2], { recursive: true, force: true })
    })
  })

  Scenario('Without a slide renderer, export is unavailable', ({ Given, When, Then, And }) => {
    Given('the Deyslide API without a slide renderer', () => start(() => undefined))
    And('Ana is signed in with the 8 slide deck "Sorting" in the project "Talks"', signInAna)
    When('Ana exports "Sorting" to PDF', async () => {
      await startExport(ana, { deckId, format: 'pdf' })
    })
    Then('the export is refused with 503 and "Export is not available on this server."', () => {
      expect(refused).toEqual({ status: 503, body: { error: 'Export is not available on this server.' } })
    })
    And('the API\'s settings say export is off', async () => {
      expect((await new Browser(server).json<{ exports: boolean }>('/api/config')).body.exports).toBe(false)
    })
  })
})
