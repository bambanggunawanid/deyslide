import type { App, Component } from 'vue'
import { defineAsyncComponent } from 'vue'
import { vClick } from './directives'
import MagicMove from './MagicMove.vue'
import { currentScope } from './scope'
import { loading } from './state'
import VClick from './VClick'
import VDrag from './VDrag.vue'

/** A component whose code loads when a slide first uses it, counted while it loads so a capture can wait. */
function lazy(load: () => Promise<{ default: Component }>) {
  return defineAsyncComponent(async () => {
    loading.value++
    try {
      return await load()
    }
    finally {
      loading.value--
    }
  })
}

/**
 * Registers what slides may use: Deyslide components, Slidev's Magic Move,
 * v-drag, `<v-click>` and `<v-after>` and the `v-click` directive, and
 * Slidev's `$clicks`, `$slidev`, `$nav`, `$frontmatter` and
 * `$renderContext`, each read from the slide that asks.
 */
export function installPreview(app: App) {
  // three.js and the Motion Canvas player are large, so they load when a slide uses them.
  app.component('DeyslideAlgoPlayer', lazy(() => import('@deyslide/components/components/DeyslideAlgoPlayer.vue')))
  app.component('DeyslideLiveSandbox', lazy(() => import('@deyslide/components/components/DeyslideLiveSandbox.vue')))
  app.component('DeyslideScene3D', lazy(() => import('@deyslide/components/components/DeyslideScene3D.vue')))
  app.component('DeyslideShape', lazy(() => import('@deyslide/components/components/DeyslideShape.vue')))
  app.component('MagicMove', MagicMove)
  app.component('VDrag', VDrag)
  app.component('VClick', VClick)
  app.component('VAfter', VClick)
  app.directive('click', vClick)
  const globals = app.config.globalProperties
  Object.defineProperty(globals, '$clicks', { get: () => currentScope().clicks.value })
  Object.defineProperty(globals, '$slidev', { get: () => currentScope().slidev })
  Object.defineProperty(globals, '$nav', { get: () => currentScope().slidev.nav })
  Object.defineProperty(globals, '$frontmatter', { get: () => currentScope().frontmatter.value })
  Object.defineProperty(globals, '$renderContext', { get: () => 'slide' })
}

/** A slide's own expressions can throw while rendering. The frame shows that instead of a blank slide. */
export function reportSlideErrors(app: App) {
  app.config.errorHandler = (error) => {
    window.dispatchEvent(new CustomEvent('deyslide:slide-error', { detail: error instanceof Error ? error.message : String(error) }))
  }
}
