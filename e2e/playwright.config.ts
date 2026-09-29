import process from 'node:process'
import { defineConfig, devices } from '@playwright/test'

const API_PORT = 3101
const WEB_PORT = 4180
const WEB_URL = `http://127.0.0.1:${WEB_PORT}`

// A Chromium other than Playwright's own, for machines that already have one.
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_PATH || undefined

export default defineConfig({
  testDir: '.',
  testMatch: '*.e2e.ts',
  fullyParallel: true,
  reporter: [['list']],
  use: {
    baseURL: WEB_URL,
    trace: 'retain-on-failure',
    launchOptions: { executablePath },
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'], launchOptions: { executablePath } } },
    { name: 'phone', use: { ...devices['Pixel 7'], launchOptions: { executablePath } } },
  ],
  webServer: [
    {
      command: 'node e2e/server.ts',
      cwd: '..',
      url: `http://127.0.0.1:${API_PORT}/api/health`,
      env: { E2E_API_PORT: String(API_PORT), E2E_PUBLIC_URL: WEB_URL },
      reuseExistingServer: false,
      timeout: 60_000,
    },
    {
      command: `pnpm --filter @deyslide/web build && pnpm --filter @deyslide/web exec vite preview --host 127.0.0.1 --port ${WEB_PORT} --strictPort`,
      cwd: '..',
      url: WEB_URL,
      env: { DEYSLIDE_API_URL: `http://127.0.0.1:${API_PORT}` },
      reuseExistingServer: false,
      timeout: 120_000,
    },
  ],
})
