import type { Ref } from 'vue'
import { onBeforeUnmount, onMounted, ref } from 'vue'

/**
 * Becomes true the first time `target` has a visible size, then stays true.
 *
 * Slidev keeps neighbour slides mounted but hidden. Waiting for real space
 * before creating the WebGL canvas avoids "canvas has no area" warnings and
 * keeps hidden slides from holding GPU contexts they cannot use yet.
 */
export function useHasArea(target: Ref<HTMLElement | null | undefined>): Ref<boolean> {
  const hasArea = ref(false)
  let observer: ResizeObserver | undefined

  function check(width: number, height: number) {
    if (width <= 0 || height <= 0)
      return
    observer?.disconnect()
    observer = undefined
    // Mounting the canvas starts its own ResizeObserver. Doing that inside
    // this callback triggers "ResizeObserver loop completed" errors, so the
    // flip waits for the next frame.
    requestAnimationFrame(() => {
      hasArea.value = true
    })
  }

  onMounted(() => {
    const element = target.value
    if (!element)
      return
    if (typeof ResizeObserver === 'undefined') {
      hasArea.value = true
      return
    }
    const rect = element.getBoundingClientRect()
    if (rect.width > 0 && rect.height > 0) {
      hasArea.value = true
      return
    }
    observer = new ResizeObserver((entries) => {
      for (const entry of entries)
        check(entry.contentRect.width, entry.contentRect.height)
    })
    observer.observe(element)
  })

  onBeforeUnmount(() => observer?.disconnect())

  return hasArea
}
