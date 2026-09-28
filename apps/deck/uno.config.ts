import { presetDeyslide } from '@deyslide/components/uno-preset'
import { defineConfig } from 'unocss'

/**
 * Slidev merges this file with its own UnoCSS config. The Deyslide tokens
 * and shortcuts come from the shared preset, so the web app matches.
 */
export default defineConfig({
  presets: [presetDeyslide()],
})
