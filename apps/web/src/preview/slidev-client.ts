import { computed } from 'vue'

/**
 * The parts of `@slidev/client` that Deyslide components use, for the
 * preview. It always shows one slide, active, on screen. The web build
 * aliases `@slidev/client` here, and so does the root tsconfig.
 */
export function useIsSlideActive() {
  return computed(() => true)
}

export function useSlideContext() {
  return { $renderContext: computed(() => 'slide') }
}

export function useNav() {
  return { isPrintMode: computed(() => false) }
}
