import { computed, reactive, readonly } from 'vue'
import { clicks, headmatter, mode, totalClicks } from './state'

/** True while the slide is drawn for an export, like Slidev's print mode. */
export const isPrintMode = computed(() => mode.value === 'print')

/**
 * Slidev's `$slidev` for the one slide the preview shows: `nav` with the
 * click state and print mode, and the deck settings as `configs`. Slides
 * read it; only the editor moves through clicks.
 */
export const slidev = readonly(reactive({
  nav: {
    clicks,
    clicksTotal: totalClicks,
    isPrintMode,
    isPresenter: false,
  },
  configs: headmatter,
  themeConfigs: computed(() => {
    const config = headmatter.value.themeConfig
    return typeof config === 'object' && config !== null ? config as Record<string, unknown> : {}
  }),
}))
