import { defineConfig } from 'vite'

// One file. playwright-core stays outside: the renderer container installs
// the same version next to it, matching the Chromium in its image.
export default defineConfig({
  build: {
    ssr: 'src/main.ts',
    outDir: 'dist',
    target: 'node22',
    minify: false,
    rollupOptions: {
      external: ['playwright-core'],
      output: { entryFileNames: 'renderer.mjs', codeSplitting: false },
    },
  },
  ssr: { noExternal: true, target: 'node' },
})
