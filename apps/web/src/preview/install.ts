import type { App } from 'vue'
import { defineAsyncComponent } from 'vue'
import { vClick } from './directives'
import MagicMove from './MagicMove.vue'
import { clicks } from './state'
import VDrag from './VDrag.vue'

/** Registers what slides may use: Deyslide components, Slidev's Magic Move, v-drag and v-click, and `$clicks`. */
export function installPreview(app: App) {
  // three.js and the Motion Canvas player are large, so they load when a slide uses them.
  app.component('DeyslideAlgoPlayer', defineAsyncComponent(() => import('@deyslide/components/components/DeyslideAlgoPlayer.vue')))
  app.component('DeyslideLiveSandbox', defineAsyncComponent(() => import('@deyslide/components/components/DeyslideLiveSandbox.vue')))
  app.component('DeyslideScene3D', defineAsyncComponent(() => import('@deyslide/components/components/DeyslideScene3D.vue')))
  app.component('DeyslideShape', defineAsyncComponent(() => import('@deyslide/components/components/DeyslideShape.vue')))
  app.component('MagicMove', MagicMove)
  app.component('VDrag', VDrag)
  app.directive('click', vClick)
  Object.defineProperty(app.config.globalProperties, '$clicks', { get: () => clicks.value })
}
