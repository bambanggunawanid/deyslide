// Adds the `slidev` key to Vite's config type.
import type {} from '@slidev/types'
import { defineConfig } from 'vite'
import { vueOptions } from './src/compiler-options.ts'

export default defineConfig({
  slidev: {
    // TresJS preset plus `motion-canvas-player`, so `<Tres*>` tags and the
    // player compile as native elements without "failed to resolve" warnings.
    vue: vueOptions,
  },
})
