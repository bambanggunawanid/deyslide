import { defineConfig } from 'vite'

// One self-contained file, so production runs `node server.mjs` on the stock
// Node image with no install step.
export default defineConfig({
  build: {
    ssr: 'src/main.ts',
    outDir: 'dist',
    target: 'node24',
    minify: false,
    rollupOptions: {
      // Optional drivers that pg only loads when asked for them.
      external: ['pg-native', 'cloudflare:sockets'],
      output: { entryFileNames: 'server.mjs', codeSplitting: false },
    },
  },
  ssr: { noExternal: true, target: 'node' },
})
