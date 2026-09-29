import { presetDeyslide } from '@deyslide/components/uno-preset'
import { defineConfig, presetWind3, transformerDirectives } from 'unocss'
import { SLIDEV_SHORTCUTS } from './src/preview/uno-shortcuts'

export default defineConfig({
  presets: [presetWind3(), presetDeyslide()],
  shortcuts: SLIDEV_SHORTCUTS,
  // Slidev's style sheets, used by the preview, are written with `@apply` and `theme()`.
  transformers: [transformerDirectives()],
  content: {
    pipeline: {
      include: [/\.(vue|[jt]sx?|html)($|\?)/, /@slidev[/\\](client|theme-default)[/\\].*\.(css|vue)($|\?)/],
    },
  },
})
