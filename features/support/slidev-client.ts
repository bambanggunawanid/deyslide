import { computed, ref } from 'vue'

/**
 * Test double for the parts of `@slidev/client` that Deyslide components use.
 * Steps change these refs to simulate navigation, export and preview modes.
 */
export const slidevTestState = {
  isSlideActive: ref(true),
  renderContext: ref<string>('slide'),
  isPrintMode: ref(false),
}

export function resetSlidevTestState() {
  slidevTestState.isSlideActive.value = true
  slidevTestState.renderContext.value = 'slide'
  slidevTestState.isPrintMode.value = false
}

export function useIsSlideActive() {
  return computed(() => slidevTestState.isSlideActive.value)
}

export function useSlideContext() {
  return {
    $renderContext: slidevTestState.renderContext,
  }
}

export function useNav() {
  return {
    isPrintMode: computed(() => slidevTestState.isPrintMode.value),
  }
}
