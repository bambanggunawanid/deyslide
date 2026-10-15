import { SLIDE_HEIGHT, SLIDE_WIDTH } from './canvas'
import { fontStylesheetsSettled } from './fonts'
import { loading } from './state'

/** A capture's size at pixel ratio 1: the size of the slide renderer's screenshots. */
export const CAPTURE_WIDTH = 1280
export const CAPTURE_HEIGHT = 720

/** A transparent pixel, drawn in place of an image the frame cannot fetch (one without CORS headers, say). */
const BLANK_IMAGE = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'

/** How long a capture waits for components, fonts and 3D snapshots before it draws what is there. */
const SETTLE_LIMIT_MS = 8000
const POLL_MS = 50

/** Two pixels of a 1280 by 720 picture, in slide units: the slide renderer's allowance for rounding. */
const SLACK = 2 * SLIDE_WIDTH / CAPTURE_WIDTH

/**
 * Whether anything is drawn past the slide's edges, beyond a pixel of
 * rounding. The slide renderer (`apps/renderer/src/draw.ts`) uses the same
 * rule on its screenshots. The slide is measured at its own size, so the
 * answer does not depend on how large the frame is shown.
 */
export function measureOverflow(slide: HTMLElement): boolean {
  const scaled = slide.style.transform
  slide.style.transform = 'none'
  try {
    const bounds = slide.getBoundingClientRect()
    return [...slide.querySelectorAll('*')].some((element) => {
      const box = element.getBoundingClientRect()
      if (box.width === 0 || box.height === 0)
        return false
      return box.right > bounds.right + SLACK || box.bottom > bounds.bottom + SLACK || box.left < bounds.left - SLACK || box.top < bounds.top - SLACK
    })
  }
  finally {
    // Put back before anything paints, so the slide never shows unscaled.
    slide.style.transform = scaled
  }
}

function delay(ms: number) {
  return new Promise<void>(resolve => setTimeout(resolve, Math.max(0, ms)))
}

async function until(done: () => boolean, deadline: number) {
  while (!done() && Date.now() < deadline)
    await delay(POLL_MS)
}

/** Settles with the promise, or at the deadline, whichever comes first. */
function within(promise: Promise<unknown>, deadline: number) {
  return Promise.race([promise.then(() => {}, () => {}), delay(deadline - Date.now())])
}

/** Two painted frames, or the deadline: a frame in a hidden window may never paint. */
function painted(deadline: number) {
  return within(new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))), deadline)
}

/** Slidev's export rule: an element with `data-waitfor` is ready once its selector matches inside it. */
function waitForsMet(root: Element) {
  return [...root.querySelectorAll<HTMLElement>('[data-waitfor]')].every((element) => {
    try {
      return element.querySelector(element.dataset.waitfor ?? '') !== null
    }
    catch {
      // A selector that does not parse can never match. Do not wait for it.
      return true
    }
  })
}

/**
 * Transitions and animations inside the slide that come to an end, such as
 * a Magic Move step or a line a click reveals. One that repeats forever is
 * left out, since nothing could wait for it.
 */
function endingAnimations(root: Element) {
  if (typeof document.getAnimations !== 'function')
    return []
  return document.getAnimations().filter((animation) => {
    const effect = animation.effect as KeyframeEffect | null
    const target = effect?.target ?? null
    return animation.playState === 'running' && target !== null && root.contains(target) && Number.isFinite(effect?.getComputedTiming().endTime)
  })
}

async function animationsDone(root: Element, deadline: number) {
  // One step can start another, so look again until none is left.
  for (let running = endingAnimations(root); running.length && Date.now() < deadline; running = endingAnimations(root))
    await within(Promise.all(running.map(animation => animation.finished)), deadline)
}

/**
 * Waits until components that load lazily have arrived, the deck's font
 * stylesheet and fonts are loaded, every `data-waitfor` is met (a 3D scene
 * in print mode swaps its canvas for an image first) and animations have
 * ended, or until the time limit. A capture never hangs on a slide that
 * does not settle.
 */
export async function settle(root: Element, limitMs = SETTLE_LIMIT_MS) {
  const deadline = Date.now() + limitMs
  await until(() => loading.value === 0, deadline)
  // Until the stylesheet arrives no font file has been asked for, so `document.fonts.ready` would not wait for one.
  await within(fontStylesheetsSettled(), deadline)
  await painted(deadline)
  await until(() => waitForsMet(root), deadline)
  if ('fonts' in document)
    await within(document.fonts.ready, deadline)
  await animationsDone(root, deadline)
  await painted(deadline)
}

/**
 * Draws the slide to a PNG of 1280 by 720 times the pixel ratio, canvases
 * included. It is drawn at its own size, unscaled and without the frame
 * around it, so the picture is the same whatever size the frame is shown
 * at. Images that cannot be fetched are left blank rather than failing the
 * whole picture.
 */
export async function rasterize(slide: HTMLElement, pixelRatio: number): Promise<ArrayBuffer> {
  // Loaded on the first capture: editing never needs it.
  const { toBlob } = await import('html-to-image')
  const blob = await toBlob(slide, {
    width: SLIDE_WIDTH,
    height: SLIDE_HEIGHT,
    canvasWidth: CAPTURE_WIDTH,
    canvasHeight: CAPTURE_HEIGHT,
    pixelRatio,
    // The copy carries the slide's computed offsets, logical ones included, which would otherwise win.
    style: { position: 'relative', inset: '0 auto auto 0', insetBlock: '0 auto', insetInline: '0 auto', translate: 'none', transform: 'none' },
    includeQueryParams: true,
    imagePlaceholder: BLANK_IMAGE,
    onImageErrorHandler: () => {},
  })
  if (!blob)
    throw new Error('The slide could not be drawn.')
  return blob.arrayBuffer()
}
