import type { Component } from 'vue'
import type { CapturedSlide, RenderRequest } from '../preview/protocol'
import type { RenderedSlide, RenderRequestEvent } from './native'
import { splitSlides } from '@deyslide/deck-model'
import { createApp, h, shallowRef } from 'vue'
import SlidePreviewFrame from '../editor/SlidePreviewFrame.vue'
import { LAST_CLICKS } from '../preview/protocol'
import { toBase64 } from '../projects/base64'
import { onRenderRequest, renderRespond } from './native'

// Draws slides for Claude Code on this computer. `deyslide mcp` asks the
// app over its render bridge; the app hands each request to the main
// window's page, which draws the slides with the same preview the editor
// uses, in a frame nobody sees, and answers with the images. Each request
// gets a frame of its own: slides can run code in their frame, so one deck
// must never see what another deck's slides hold.


/** How long one slide may take to show, components and fonts included. */
const SLIDE_TIMEOUT_MS = 15_000

/** What the frame component offers: the preview frame, or a double in tests. */
interface FrameHandle {
  capture: (pixelRatio?: number) => Promise<CapturedSlide>
}

type Shown = { clicks: number } | { error: string }

/**
 * A preview frame inside the window but out of sight: drawn like any other
 * page content (a frame off screen or hidden would not draw), at the size
 * slides are drawn at, behind the page and taking no clicks.
 */
class BridgeFrame {
  private readonly element: HTMLDivElement
  private readonly app: ReturnType<typeof createApp>
  private readonly request = shallowRef<RenderRequest>()
  private handle: FrameHandle | null = null
  private waiting?: { id: string, finish: (shown: Shown) => void }

  constructor(frame: Component, width: number, height: number) {
    this.element = document.createElement('div')
    Object.assign(this.element.style, {
      position: 'fixed',
      left: '0',
      top: '0',
      width: `${width}px`,
      height: `${height}px`,
      opacity: '0',
      pointerEvents: 'none',
      zIndex: '-1',
      overflow: 'hidden',
    })
    this.element.setAttribute('aria-hidden', 'true')
    this.element.dataset.testid = 'render-bridge'
    document.body.append(this.element)
    this.app = createApp({
      render: () => h(frame, {
        ref: (instance: unknown) => {
          this.handle = instance as FrameHandle | null
        },
        request: this.request.value,
        onRendered: ({ id, clicks }: { id?: string, clicks: number }) => {
          if (this.waiting && id === this.waiting.id)
            this.waiting.finish({ clicks })
        },
        // The frame only passes on errors about the slide it shows.
        onError: (message: string) => this.waiting?.finish({ error: message }),
      }),
    })
    this.app.mount(this.element)
  }

  /** Shows a slide and waits until it is drawn, it fails, or it takes too long. */
  show(request: RenderRequest & { id: string }): Promise<Shown> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => finish({ error: `The slide took longer than ${SLIDE_TIMEOUT_MS / 1000} seconds to render.` }), SLIDE_TIMEOUT_MS)
      const finish = (shown: Shown) => {
        clearTimeout(timer)
        if (this.waiting?.id === request.id)
          this.waiting = undefined
        resolve(shown)
      }
      this.waiting = { id: request.id, finish }
      this.request.value = request
    })
  }

  async capture(): Promise<CapturedSlide> {
    if (!this.handle)
      return { overflow: false, error: 'The slide could not be drawn.' }
    return this.handle.capture()
  }

  destroy() {
    this.waiting?.finish({ error: 'The Deyslide window stopped drawing slides.' })
    this.app.unmount()
    this.element.remove()
  }
}

const failed = (error: string): RenderedSlide => ({ clicks: 0, overflow: false, error })

const messageOf = (error: unknown) => error instanceof Error ? error.message : String(error)

async function drawOne(frame: BridgeFrame, request: RenderRequest & { id: string }): Promise<RenderedSlide> {
  const shown = await frame.show(request)
  // A slide that fails to compile leaves the previous slide on screen, so it gets no image.
  if ('error' in shown)
    return failed(shown.error)
  const captured = await frame.capture()
  return {
    ...(captured.png ? { png: toBase64(new Uint8Array(captured.png)) } : {}),
    clicks: shown.clicks,
    overflow: captured.overflow,
    ...(captured.error ? { error: captured.error } : {}),
  }
}

/** Draws each requested slide in print mode, so every step shows in its final state. */
async function draw(frame: BridgeFrame, event: RenderRequestEvent): Promise<RenderedSlide[]> {
  let source: ReturnType<typeof splitSlides>
  try {
    source = splitSlides(event.markdown)
  }
  catch (error) {
    return event.slides.map(() => failed(`The deck could not be read: ${messageOf(error)}`))
  }
  // The first slide's frontmatter holds the deck's settings.
  const headmatter = source[0]?.frontmatter ?? {}
  const results: RenderedSlide[] = []
  for (const [index, wanted] of event.slides.entries()) {
    const slide = source[wanted.number - 1]
    if (!slide) {
      results.push(failed(`The deck has ${source.length} slides, so there is no slide ${wanted.number}.`))
      continue
    }
    results.push(await drawOne(frame, {
      type: 'deyslide:render',
      id: `${event.id}:${index}`,
      slide: { content: slide.content, frontmatter: slide.frontmatter, first: wanted.number === 1 },
      headmatter,
      clicks: wanted.clicks === 'last' ? LAST_CLICKS : wanted.clicks,
      mode: 'print',
    }))
  }
  return results
}

export interface RenderBridgeOptions {
  /** The frame to draw in. Tests pass a double of the preview frame. */
  frame?: Component
}

/**
 * Answers the app's render requests, one at a time. Call it once, in the
 * main window: the app sends requests there alone. Resolves with a
 * function that stops answering.
 */
export async function startRenderBridge({ frame = SlidePreviewFrame }: RenderBridgeOptions = {}) {
  /** The frame of the request being drawn. */
  let shown: BridgeFrame | undefined
  let line = Promise.resolve()

  async function answer(event: RenderRequestEvent) {
    let slides: RenderedSlide[]
    try {
      shown = new BridgeFrame(frame, event.width || 1280, event.height || 720)
      slides = await draw(shown, event)
    }
    catch (error) {
      slides = event.slides.map(() => failed(messageOf(error)))
    }
    finally {
      shown?.destroy()
      shown = undefined
    }
    await renderRespond(event.id, slides)
  }

  const stop = await onRenderRequest((event) => {
    line = line.then(() => answer(event)).catch((error) => {
      console.error('Deyslide could not answer a render request:', error)
    })
  })

  return () => {
    stop()
    shown?.destroy()
    shown = undefined
  }
}
