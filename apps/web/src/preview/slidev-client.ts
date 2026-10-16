import { computed } from 'vue'
import { isPrintMode } from './context'
import { currentScope } from './scope'

/**
 * The parts of `@slidev/client` that Deyslide components use, for the
 * preview. Each slide answers for itself: the slide on screen is active and
 * follows the clicks, and while presenting, the slide on its way out keeps
 * what it showed. The editor reports print mode while it exports. The web
 * build aliases `@slidev/client` here, and so does the root tsconfig.
 */
export function useIsSlideActive() {
  return currentScope().active
}

export function useSlideContext() {
  const scope = currentScope()
  return {
    $slidev: scope.slidev,
    $nav: computed(() => scope.slidev.nav),
    $clicks: scope.clicks,
    $frontmatter: scope.frontmatter.value,
    $renderContext: computed(() => 'slide'),
  }
}

export function useNav() {
  const scope = currentScope()
  return {
    isPrintMode,
    isPresenter: computed(() => false),
    clicks: scope.clicks,
    clicksTotal: scope.totalClicks,
  }
}
