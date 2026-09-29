import vue from '@vitejs/plugin-vue'
import unocss from 'unocss/vite'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [vue(), unocss()],
  server: {
    // `pnpm dev:server` runs the API here, the same way nginx routes /api/ in production.
    proxy: { '/api': 'http://127.0.0.1:3001' },
  },
})
