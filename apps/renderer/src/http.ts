import type { IncomingMessage, RequestListener, ServerResponse } from 'node:http'
import type { DrawOptions, RecordedVideo, RenderedSlide, SlideToRender, VideoRequest, VideoSlide } from './draw.ts'
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { pipeline } from 'node:stream/promises'
import { BusyError, MAX_VIDEO_MS, VideoError } from './draw.ts'
import { frameSize } from './site.ts'

/** Matches the MCP server's limit per call, and the export's batches. */
export const MAX_SLIDES = 6
/** A video holds a whole deck, as the API allows. */
export const MAX_VIDEO_SLIDES = 100
/** Room for the media the slides use, sent inline as `data:` URLs: up to 20 MB of files, in base64. */
export const MAX_BODY_BYTES = 32 * 1024 * 1024

/**
 * The type of a `/video` answer. It is a series of lines of JSON, each
 * ending in a newline:
 *
 *   {"type":"progress","progress":0.25}    as recording goes on, from 0 to 1
 *
 * and then exactly one of:
 *
 *   {"type":"video","bytes":N}             followed by exactly N bytes of WebM, then the end
 *   {"type":"error","message":"..."}       then the end; the message is for the person who asked
 *
 * A request refused before recording starts gets a plain JSON error with
 * its own status (400, 413, 503) instead.
 */
export const VIDEO_STREAM_TYPE = 'application/vnd.deyslide.video-stream'

/** What the HTTP side needs from the drawer: `SlideDrawer`, or a double in tests. */
export interface Drawer {
  draw: (slides: SlideToRender[], options: DrawOptions) => Promise<RenderedSlide[]>
  record: (request: VideoRequest, onProgress: (progress: number) => void, signal: AbortSignal) => Promise<RecordedVideo>
}

class BadRequest extends Error {
  readonly status: number

  constructor(message: string, status = 400) {
    super(message)
    this.status = status
  }
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

function isSlide(value: unknown): value is SlideToRender {
  const slide = value as SlideToRender
  return isObject(slide)
    && typeof slide.content === 'string'
    && isObject(slide.frontmatter)
    && isObject(slide.headmatter)
    && typeof slide.first === 'boolean'
    && Number.isInteger(slide.clicks) && slide.clicks >= 0
}

function isVideoSlide(value: unknown): value is VideoSlide {
  const slide = value as VideoSlide
  return isObject(slide)
    && typeof slide.content === 'string'
    && isObject(slide.frontmatter)
    && typeof slide.first === 'boolean'
    && Number.isInteger(slide.dwellMs) && slide.dwellMs > 0 && slide.dwellMs <= MAX_VIDEO_MS
}

/** The `media` map, when sent: links mapped to `data:` URLs. */
function readMedia(value: unknown): Record<string, string> | undefined {
  if (value === undefined)
    return undefined
  if (!isObject(value) || !Object.values(value).every(link => typeof link === 'string' && link.startsWith('data:')))
    throw new BadRequest('media must map each link to a data: URL')
  return value as Record<string, string>
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    size += (chunk as Buffer).length
    if (size > MAX_BODY_BYTES)
      throw new BadRequest('Too large', 413)
    chunks.push(chunk as Buffer)
  }
  let body: unknown
  try {
    body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  }
  catch {
    throw new BadRequest('The body must be JSON')
  }
  if (!isObject(body))
    throw new BadRequest('The body must be a JSON object')
  return body
}

function readRender(body: Record<string, unknown>): { slides: SlideToRender[], options: DrawOptions } {
  const { slides } = body
  if (!Array.isArray(slides) || slides.length === 0 || slides.length > MAX_SLIDES || !slides.every(isSlide))
    throw new BadRequest(`Send 1 to ${MAX_SLIDES} slides`)
  const size = frameSize(body.width, body.height)
  if (typeof size === 'string')
    throw new BadRequest(size)
  const media = readMedia(body.media)
  return { slides, options: { size, ...(media ? { media } : {}) } }
}

function readVideo(body: Record<string, unknown>): VideoRequest {
  const { slides, headmatter, clicks } = body
  if (!Array.isArray(slides) || slides.length === 0 || slides.length > MAX_VIDEO_SLIDES || !slides.every(isVideoSlide))
    throw new BadRequest(`Send 1 to ${MAX_VIDEO_SLIDES} slides, each with a dwell time of at most ${MAX_VIDEO_MS} ms`)
  if (!isObject(headmatter))
    throw new BadRequest('Send the headmatter')
  if (clicks !== 'each' && clicks !== 'last')
    throw new BadRequest('clicks must be "each" or "last"')
  const media = readMedia(body.media)
  return { slides, headmatter, clicks, ...(media ? { media } : {}) }
}

/**
 * The renderer's HTTP API: `GET /health`, `POST /render` with 1 to 6 slides
 * (and an optional `width`, `height` and `media`), answered with PNGs, and
 * `POST /video` with a whole deck, answered with progress and then a WebM
 * (see VIDEO_STREAM_TYPE).
 */
export function rendererHandler(drawer: Drawer): RequestListener {
  return async (request, response) => {
    const send = (status: number, body: unknown) => {
      response.writeHead(status, { 'content-type': 'application/json' })
      response.end(JSON.stringify(body))
    }
    if (request.method === 'GET' && request.url === '/health')
      return send(200, { ok: true })
    if (request.method !== 'POST' || (request.url !== '/render' && request.url !== '/video'))
      return send(404, { error: 'Not found' })

    try {
      const body = await readJson(request)
      if (request.url === '/render') {
        const { slides, options } = readRender(body)
        return send(200, { slides: await drawer.draw(slides, options) })
      }
      return await streamVideo(drawer, readVideo(body), response)
    }
    catch (error) {
      if (error instanceof BadRequest)
        return send(error.status, { error: error.message })
      if (error instanceof BusyError)
        return send(503, { error: 'The renderer is busy' })
      console.error('Rendering failed', error)
      send(500, { error: 'Rendering failed' })
    }
  }
}

/**
 * Records the video and streams it in the framing VIDEO_STREAM_TYPE
 * describes. The answer starts with the first progress line, so a request
 * the drawer refuses at once (busy) still gets a plain 503.
 */
async function streamVideo(drawer: Drawer, video: VideoRequest, response: ServerResponse) {
  let started = false
  const line = (value: unknown) => {
    if (!started) {
      started = true
      response.writeHead(200, { 'content-type': VIDEO_STREAM_TYPE, 'cache-control': 'no-store' })
    }
    response.write(`${JSON.stringify(value)}\n`)
  }
  // The API gave up (a timeout, or it stopped): stop recording too.
  const stop = new AbortController()
  response.on('close', () => {
    if (!response.writableFinished)
      stop.abort()
  })

  let recorded: RecordedVideo | undefined
  try {
    recorded = await drawer.record(video, progress => line({ type: 'progress', progress: Math.min(1, Math.max(0, progress)) }), stop.signal)
    const { size } = await stat(recorded.path)
    line({ type: 'video', bytes: size })
    await pipeline(createReadStream(recorded.path), response)
  }
  catch (error) {
    // A refusal before anything was sent (busy) gets a plain status. Every
    // reason meant for the person comes as an error line.
    if (!started && !(error instanceof VideoError))
      throw error
    if (!(error instanceof VideoError))
      console.error('Recording failed', error)
    if (!response.destroyed) {
      line({ type: 'error', message: error instanceof VideoError ? error.message : 'The video could not be recorded.' })
      response.end()
    }
  }
  finally {
    await recorded?.discard()
  }
}
