import { computed } from 'vue'
import { isPrintMode, slidev } from './context'
import { clicks, frontmatter, totalClicks } from './state'

/**
 * The parts of `@slidev/client` that Deyslide components use, for the
 * preview. It shows one slide, active, on screen, and reports print mode
 * while the editor exports it. The web build aliases `@slidev/client`
 * here, and so does the root tsconfig.
 */
export function useIsSlideActive() {
  return computed(() => true)
}

export function useSlideContext() {
  return {
    $slidev: slidev,
    $nav: computed(() => slidev.nav),
    $clicks: computed(() => clicks.value),
    $frontmatter: frontmatter.value,
    $renderContext: computed(() => 'slide'),
  }
}

export function useNav() {
  return {
    isPrintMode,
    isPresenter: computed(() => false),
    clicks: computed(() => clicks.value),
    clicksTotal: computed(() => totalClicks.value),
  }
}
