import process from 'node:process'
import vue from '@vitejs/plugin-vue'
import unocss from 'unocss/vite'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [vue(), unocss()],
  server: {
    // `pnpm dev:server` runs the API here, the same way nginx routes /api/ in
    // production. `vite preview` uses the same proxy; the end to end tests point
    // it at their own API with DEYSLIDE_API_URL.
    proxy: { '/api': process.env.DEYSLIDE_API_URL ?? 'http://127.0.0.1:3001' },
  },
})
