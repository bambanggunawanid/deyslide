import { presetDeyslide } from '@deyslide/components/uno-preset'
import { defineConfig, presetWind3 } from 'unocss'

export default defineConfig({
  presets: [presetWind3(), presetDeyslide()],
})
