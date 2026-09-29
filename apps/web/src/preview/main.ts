import './sandbox-storage'
import initUnocssRuntime from '@unocss/runtime'
import { presetDeyslide } from '@deyslide/components/uno-preset'
import { presetWind3 } from '@unocss/preset-wind3'
import { createApp } from 'vue'
import { installPreview } from './install'
import PreviewApp from './PreviewApp.vue'
import { SLIDEV_SHORTCUTS } from './uno-shortcuts'
// Slidev loads the same reset, so boxes size the same way (a layout's padding stays inside the slide).
import '@unocss/reset/tailwind.css'
import './styles.css'

// Slides use any utility class, so styles are generated as they appear.
initUnocssRuntime({
  defaults: { presets: [presetWind3(), presetDeyslide()], shortcuts: SLIDEV_SHORTCUTS },
})

const app = createApp(PreviewApp)
installPreview(app)
// A slide's own expressions can throw while rendering. Show that instead of a blank slide.
app.config.errorHandler = (error) => {
  window.dispatchEvent(new CustomEvent('deyslide:slide-error', { detail: error instanceof Error ? error.message : String(error) }))
}
app.mount('#preview')
