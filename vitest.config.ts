import { fileURLToPath } from 'node:url'
import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vitest/config'
import { vueOptions } from './packages/components/src/compiler-options.ts'

export default defineConfig({
  plugins: [vue(vueOptions)],
  resolve: {
    alias: [
      // Slidev provides `@slidev/client` only inside a running deck.
      // Tests swap in a small double that exposes the same composables.
      // Only the bare name: the preview imports Slidev's layouts from subpaths.
      { find: /^@slidev\/client$/, replacement: fileURLToPath(new URL('./features/support/slidev-client.ts', import.meta.url)) },
    ],
  },
  test: {
    environment: 'happy-dom',
    include: ['features/**/*.spec.ts'],
    // vitest-cucumber runs every Gherkin step as its own test. Vitest 5 clears
    // mock calls between tests by default, which would erase a call made in a
    // When step before the Then step can assert on it.
    clearMocks: false,
  },
})
