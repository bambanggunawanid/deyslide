import type { InjectionKey, Ref } from 'vue'
import { computed, getCurrentInstance, inject, reactive, readonly, shallowRef } from 'vue'
import { isPrintMode } from './context'
import { clicks, frontmatter, headmatter, totalClicks } from './state'

/**
 * What one mounted slide reads about itself: its clicks, its frontmatter
 * and whether it is the slide on screen. The slide on screen follows the
 * preview's state. While presenting, the slide being left stays mounted
 * until its transition ends, and keeps what it showed: its clicks do not
 * follow the slide that comes in.
 */
export interface SlideScope {
  clicks: Readonly<Ref<number>>
  totalClicks: Readonly<Ref<number>>
  frontmatter: Readonly<Ref<Record<string, unknown>>>
  /** False for the slide on its way out, as in Slidev. */
  active: Readonly<Ref<boolean>>
  /** Slidev's `$slidev` for this slide. */
  slidev: SlidevContext
}

/** Slidev's `$slidev`, for one slide. */
export type SlidevContext = ReturnType<typeof slidevContext>

function slidevContext(scope: Omit<SlideScope, 'slidev'>) {
  return readonly(reactive({
    nav: {
      clicks: scope.clicks,
      clicksTotal: scope.totalClicks,
      isPrintMode,
      isPresenter: false,
    },
    configs: headmatter,
    themeConfigs: computed(() => {
      const config = headmatter.value.themeConfig
      return typeof config === 'object' && config !== null ? config as Record<string, unknown> : {}
    }),
  }))
}

function scopeOf(parts: Omit<SlideScope, 'slidev'>): SlideScope {
  return { ...parts, slidev: slidevContext(parts) }
}

/** The slide on screen. Slides read it unless they are mounted under a scope of their own. */
export const liveScope: SlideScope = scopeOf({
  clicks: computed(() => clicks.value),
  totalClicks: computed(() => totalClicks.value),
  frontmatter: computed(() => frontmatter.value),
  active: computed(() => true),
})

export const SLIDE_SCOPE: InjectionKey<SlideScope> = Symbol('slide-scope')

/** What a slide showed when it started to leave. */
interface Frozen {
  clicks: number
  totalClicks: number
  frontmatter: Record<string, unknown>
}

/**
 * A scope for one mounted slide: live while the slide is on screen, and
 * fixed at what it showed once `freeze()` says it is leaving.
 */
export function createSlideScope(): { scope: SlideScope, freeze: () => void } {
  const frozen = shallowRef<Frozen>()
  const scope = scopeOf({
    clicks: computed(() => frozen.value ? frozen.value.clicks : clicks.value),
    totalClicks: computed(() => frozen.value ? frozen.value.totalClicks : totalClicks.value),
    frontmatter: computed(() => frozen.value ? frozen.value.frontmatter : frontmatter.value),
    active: computed(() => !frozen.value),
  })
  return {
    scope,
    freeze() {
      frozen.value ??= { clicks: clicks.value, totalClicks: totalClicks.value, frontmatter: frontmatter.value }
    },
  }
}

/** The scope of the slide being set up or drawn now, or the live one outside a slide. */
export function currentScope(): SlideScope {
  return getCurrentInstance() ? inject(SLIDE_SCOPE, liveScope) : liveScope
}
