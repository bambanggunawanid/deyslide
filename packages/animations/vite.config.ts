import type { Plugin, UserConfig } from 'vite'
import { fileURLToPath } from 'node:url'
import motionCanvasPlugin from '@motion-canvas/vite-plugin'
import { defineConfig } from 'vite'

// The plugin ships as CommonJS, so the default export can arrive wrapped.
const motionCanvas = ((motionCanvasPlugin as unknown as { default?: typeof motionCanvasPlugin }).default ?? motionCanvasPlugin)

const root = fileURLToPath(new URL('.', import.meta.url))

/**
 * `@motion-canvas/vite-plugin` 3.x was written for Vite 4. Its project plugin
 * returns `build.target: 'modules'` and esbuild JSX options, which Vite 8
 * (Rolldown and Oxc) rejects or deprecates. This rewrites that one config
 * result into the Vite 8 form and leaves every other plugin untouched.
 */
function adaptForVite8(plugins: Plugin[]): Plugin[] {
  return plugins.map((plugin) => {
    if (plugin.name !== 'motion-canvas:project' || typeof plugin.config !== 'function')
      return plugin
    const original = plugin.config
    return {
      ...plugin,
      async config(...args) {
        const result = (await original.apply(this, args)) as UserConfig | null | void
        if (!result)
          return result
        const rest: UserConfig = { ...result }
        delete rest.esbuild
        return {
          ...rest,
          build: { ...rest.build, target: 'es2022' },
          oxc: {
            jsx: {
              runtime: 'automatic',
              importSource: '@motion-canvas/2d/lib',
            },
          },
        }
      },
    }
  })
}

/**
 * Builds every Motion Canvas project in `src/` into `public/animations/`.
 * Slidev serves that folder, and `<DeyslideAlgoPlayer src="/animations/<name>.js">`
 * loads the bundle at runtime.
 */
export default defineConfig({
  root,
  plugins: adaptForVite8(motionCanvas({
    project: [`${root}src/bubble-sort.ts`],
  })),
  build: {
    outDir: fileURLToPath(new URL('../../apps/deck/public/animations', import.meta.url)),
    emptyOutDir: true,
    rollupOptions: {
      output: {
        // Stable names so slides can reference `/animations/bubble-sort.js`.
        entryFileNames: '[name].js',
        chunkFileNames: '[name].js',
        assetFileNames: '[name][extname]',
      },
    },
  },
})
