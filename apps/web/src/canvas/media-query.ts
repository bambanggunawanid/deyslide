import type { Ref } from 'vue'
import { onBeforeUnmount, onMounted, ref } from 'vue'

/** Whether a CSS media query matches, following changes (the window resized, a phone turned). */
export function useMediaQuery(query: string): Readonly<Ref<boolean>> {
  const matches = ref(false)
  let list: MediaQueryList | undefined
  const read = () => {
    matches.value = Boolean(list?.matches)
  }
  onMounted(() => {
    list = window.matchMedia?.(query)
    read()
    list?.addEventListener?.('change', read)
  })
  onBeforeUnmount(() => list?.removeEventListener?.('change', read))
  return matches
}
