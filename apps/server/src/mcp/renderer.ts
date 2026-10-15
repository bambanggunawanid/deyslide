import type { FileHandle } from 'node:fs/promises'
import type { IncomingMessage } from 'node:http'
import { open, rm } from 'node:fs/promises'
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

export interface RenderOptions {
  /** The image size, 1280 by 720 when left out. Exports ask for 1920 by 1080. */
  width?: number
  height?: number
  /** Media links the slides use (`/api/media/<id>/file`), each mapped to a `data:` URL: the renderer has no network. */
  media?: Record<string, string>
  /** Gives up on the request. */
  signal?: AbortSignal
}

/** One slide of a video, held on screen for `dwellMs` at each step. */
export interface VideoSlide {
  content: string
  frontmatter: Record<string, unknown>
  first: boolean
  dwellMs: number
}

export interface VideoRequest {
  slides: VideoSlide[]
  headmatter: Record<string, unknown>
  /** `each` plays every click step, `last` shows each slide once with all of its steps. */
  clicks: 'each' | 'last'
  media?: Record<string, string>
}

export interface VideoOptions {
  /** Where the WebM goes. */
  file: string
  /** The share recorded so far, from 0 to 1. */
  onProgress?: (progress: number) => void
  /** Stops the recording. */
  signal?: AbortSignal
}

/** Draws slides to images. A separate service in production, a fake in tests. */
export interface SlideRenderer {
  render: (slides: SlideToRender[], options?: RenderOptions) => Promise<RenderedSlide[]>
  /**
   * Presents the slides and records them into a 1920 by 1080 WebM. Optional,
   * so a renderer that only draws (a test double of render_slides) still
   * fits; the API then says video export is not available.
   */
  video?: (request: VideoRequest, options: VideoOptions) => Promise<void>
}

export class RendererUnavailableError extends Error {}
/** The renderer is working on other requests and took no more (503). Asking again later works. */
export class RendererBusyError extends RendererUnavailableError {}
/** The renderer refused the request as it was sent (a 4xx answer), so asking again does not help. `detail` is its reason. */
export class RendererRefusedError extends RendererUnavailableError {
  readonly detail: string

  constructor(message: string, detail: string) {
    super(message)
    this.detail = detail
  }
}
/** The renderer could not draw the slides it was sent. The message says why, in words for the person exporting. */
export class RenderError extends Error {}

/**
 * The renderer ends a recording itself within about 12 minutes: up to 45
 * seconds to count click steps, 10 minutes of video, 30 seconds of slower
 * drawing than planned. This leaves a minute more to save and send it.
 */
export const VIDEO_TIMEOUT_MS = 13 * 60_000
/** A line of the video stream longer than this is not one the renderer sent. */
const MAX_LINE_BYTES = 64 * 1024

async function textOf(response: IncomingMessage) {
  const chunks: Buffer[] = []
  for await (const chunk of response)
    chunks.push(chunk as Buffer)
  return Buffer.concat(chunks).toString('utf8')
}

/** The error for an answer other than 200: busy, refused, or anything else. */
function answerError(status: number | undefined, text: string) {
  const message = `The renderer answered ${status}: ${text.slice(0, 200)}`
  if (status === 503)
    return new RendererBusyError(message)
  if (status !== undefined && status >= 400 && status < 500) {
    let detail = text.slice(0, 200)
    try {
      detail = String((JSON.parse(text) as { error?: unknown }).error ?? detail)
    }
    catch {}
    return new RendererRefusedError(message, detail)
  }
  return new RendererUnavailableError(message)
}

/**
 * The renderer service, over HTTP. `address` is an http URL, or
 * `unix:/path/to/socket` for the production container, which has no network.
 */
export class HttpSlideRenderer implements SlideRenderer {
  private readonly address: string
  private readonly timeoutMs: number
  private readonly videoTimeoutMs: number

  constructor(address: string, timeoutMs = 60_000, videoTimeoutMs = VIDEO_TIMEOUT_MS) {
    this.address = address
    this.timeoutMs = timeoutMs
    this.videoTimeoutMs = videoTimeoutMs
  }

  private target(path: string) {
    if (this.address.startsWith('unix:'))
      return { socketPath: this.address.slice('unix:'.length), path }
    const url = new URL(this.address)
    return { host: url.hostname, port: url.port, path: `${url.pathname.replace(/\/$/, '')}${path}` }
  }

  render(slides: SlideToRender[], { signal, ...options }: RenderOptions = {}): Promise<RenderedSlide[]> {
    const body = JSON.stringify({ slides, ...options })
    return new Promise((resolve, reject) => {
      const call = request({
        ...this.target('/render'),
        method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
        timeout: this.timeoutMs,
        ...(signal ? { signal } : {}),
      }, (response) => {
        const chunks: Buffer[] = []
        response.on('data', chunk => chunks.push(chunk))
        response.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8')
          if (response.statusCode !== 200)
            return reject(answerError(response.statusCode, text))
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

  /**
   * Asks for a video and writes it to `file`. The renderer answers with
   * lines of JSON (progress, then the video's length in bytes, or an error)
   * followed by the WebM itself; see VIDEO_STREAM_TYPE in apps/renderer.
   */
  async video(video: VideoRequest, { file, onProgress, signal: stop }: VideoOptions): Promise<void> {
    const timeout = AbortSignal.timeout(this.videoTimeoutMs)
    const signal = stop ? AbortSignal.any([timeout, stop]) : timeout
    const body = JSON.stringify(video)
    let output: FileHandle | undefined
    try {
      const response = await new Promise<IncomingMessage>((resolve, reject) => {
        const call = request({
          ...this.target('/video'),
          method: 'POST',
          headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
          signal,
        }, resolve)
        call.on('error', reject)
        call.end(body)
      })
      if (response.statusCode !== 200)
        throw answerError(response.statusCode, await textOf(response))

      output = await open(file, 'w')
      let pending: Buffer = Buffer.alloc(0)
      /** Bytes of video still to come, once the line announcing it arrived. */
      let left: number | undefined
      for await (const chunk of response as AsyncIterable<Buffer>) {
        pending = pending.length ? Buffer.concat([pending, chunk]) : chunk
        let end: number
        while (left === undefined && (end = pending.indexOf(10)) >= 0) {
          const message = readLine(pending.subarray(0, end))
          pending = pending.subarray(end + 1)
          if (message.type === 'progress' && typeof message.progress === 'number')
            onProgress?.(message.progress)
          else if (message.type === 'error')
            throw new RenderError(String(message.message))
          else if (message.type === 'video' && Number.isInteger(message.bytes))
            left = message.bytes as number
        }
        if (left === undefined) {
          if (pending.length > MAX_LINE_BYTES)
            throw new RendererUnavailableError('The renderer sent an unreadable answer')
          continue
        }
        const part = pending.subarray(0, left)
        await output.write(part)
        left -= part.length
        pending = Buffer.alloc(0)
      }
      if (left !== 0)
        throw new RendererUnavailableError('The renderer stopped before the video was complete')
      await output.close()
      output = undefined
    }
    catch (error) {
      await output?.close()
      await rm(file, { force: true })
      if (error instanceof RenderError || error instanceof RendererUnavailableError)
        throw error
      if (stop?.aborted)
        throw stop.reason
      if (timeout.aborted)
        throw new RendererUnavailableError('The renderer took too long to record the video')
      throw new RendererUnavailableError(`The renderer is unreachable: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
}

function readLine(line: Buffer): Record<string, unknown> {
  try {
    const value = JSON.parse(line.toString('utf8')) as unknown
    if (typeof value === 'object' && value !== null)
      return value as Record<string, unknown>
  }
  catch {}
  throw new RendererUnavailableError('The renderer sent an unreadable answer')
}
