import type { ElementSize, SizesMessage } from './protocol'
import { mode } from './state'

// Tells the editor how large each positioned element is laid out. Text with
// auto height only has a height once the slide lays it out, and the editor
// cannot measure inside this sandboxed frame.

/** Positioned elements on screen, by `data-id`. */
const shown = new Map<Element, string>()
let pending: ReturnType<typeof setTimeout> | undefined
let observer: ResizeObserver | undefined

function report() {
  pending = undefined
  if (mode.value !== 'edit')
    return
  const sizes = Object.create(null) as Record<string, ElementSize>
  for (const [element, id] of shown) {
    if (element instanceof HTMLElement)
      sizes[id] = { w: element.offsetWidth, h: element.offsetHeight }
  }
  const message: SizesMessage = { type: 'deyslide:sizes', sizes }
  window.parent.postMessage(message, '*')
}

/** One message for everything that changed at once. */
function schedule() {
  pending ??= setTimeout(report)
}

/** Measures a positioned element while it is on screen, and whenever its size changes. Returns a function that stops. */
export function measureElement(element: Element, id: string): () => void {
  observer ??= new ResizeObserver(schedule)
  shown.set(element, id)
  observer.observe(element)
  schedule()
  return () => {
    shown.delete(element)
    observer?.unobserve(element)
    if (shown.size === 0) {
      observer?.disconnect()
      observer = undefined
    }
    schedule()
  }
}
