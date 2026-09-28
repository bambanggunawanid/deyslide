// Adds the `slidev` key to Vite's config type.
import type {} from '@slidev/types'
import { vueOptions } from '@deyslide/components/compiler-options'
import { defineConfig } from 'vite'

export default defineConfig({
  slidev: {
    // TresJS preset plus `motion-canvas-player`, so `<Tres*>` tags and the
    // player compile as native elements without "failed to resolve" warnings.
    vue: vueOptions,
  },
})
