import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { vueOptions } from '@deyslide/components/compiler-options'
import vue from '@vitejs/plugin-vue'
import unocss from 'unocss/vite'
import { defineConfig } from 'vite'

// The preview runs in a sandboxed iframe, whose origin is "null". Its module
// scripts are cross origin requests, so the server must allow that origin.
const previewCors = { origin: 'null' }

export default defineConfig({
  // TresJS elements and `motion-canvas-player` compile as native elements.
  plugins: [vue(vueOptions), unocss()],
  // The Motion Canvas bundles, so `/animations/...` works in slides as in the demo deck.
  publicDir: fileURLToPath(new URL('../deck/public', import.meta.url)),
  resolve: {
    alias: [
      // Deyslide components ask Slidev for slide state. The preview answers instead.
      { find: /^@slidev\/client$/, replacement: fileURLToPath(new URL('./src/preview/slidev-client.ts', import.meta.url)) },
    ],
  },
  build: {
    // three.js (for the 3D scene component) and some Shiki grammars are large
    // chunks that load only when a slide uses them.
    chunkSizeWarningLimit: 1000,
    rollupOptions: {
      input: {
        main: fileURLToPath(new URL('./index.html', import.meta.url)),
        preview: fileURLToPath(new URL('./preview.html', import.meta.url)),
      },
    },
  },
  server: {
    cors: previewCors,
    // `pnpm dev:server` runs the API here, the same way nginx routes /api/ in
    // production. `vite preview` uses the same proxy; the end to end tests point
    // it at their own API with DEYSLIDE_API_URL.
    proxy: { '/api': process.env.DEYSLIDE_API_URL ?? 'http://127.0.0.1:3001' },
  },
  preview: {
    cors: previewCors,
  },
})
