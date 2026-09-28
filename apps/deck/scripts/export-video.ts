/**
 * Records the deck into a WebM video.
 *
 * 1. Starts a Slidev dev server (only dev mode exposes `window.__slidev__`).
 * 2. Opens it in Chromium through Playwright with video recording on.
 * 3. Steps through every click and slide, holding each one for its dwell time.
 *
 * Usage: pnpm export:video [--output exports/talk.webm] [--width 1920]
 *        [--height 1080] [--dwell 3000] [--port 3931] [--executable-path <chromium>]
 */
import type { ChildProcess } from 'node:child_process'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-chromium'
import { dwellFor, parseVideoArgs } from './video-plan.ts'

interface SlidevWindow {
  __slidev__?: {
    nav: {
      hasNext: boolean
      next: () => Promise<void>
      currentSlideNo: number
      clicks: number
      currentSlideRoute: { meta: { slide: { frontmatter: Record<string, unknown> } } }
    }
  }
}

async function waitForServer(url: string, timeoutMs = 60000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(url)
      if (response.ok)
        return
    }
    catch {}
    await new Promise(done => setTimeout(done, 500))
  }
  throw new Error(`Slidev did not start on ${url} within ${timeoutMs} ms`)
}

// The deck package (apps/deck), whatever folder the script is started from.
const deckDir = fileURLToPath(new URL('..', import.meta.url))

function startSlidev(port: number): ChildProcess {
  return spawn('pnpm', ['exec', 'slidev', '--port', String(port), '--bind', '127.0.0.1'], {
    cwd: deckDir,
    stdio: ['ignore', 'inherit', 'inherit'],
  })
}

async function main() {
  const options = parseVideoArgs(process.argv.slice(2))
  const url = `http://127.0.0.1:${options.port}`
  const videoDir = await mkdtemp(join(tmpdir(), 'deyslide-video-'))
  const server = startSlidev(options.port)

  try {
    await waitForServer(url)

    const browser = await chromium.launch({ executablePath: options.executablePath })
    const size = { width: options.width, height: options.height }
    const context = await browser.newContext({
      viewport: size,
      deviceScaleFactor: 1,
      recordVideo: { dir: videoDir, size },
    })
    const page = await context.newPage()

    await page.goto(`${url}/1`, { waitUntil: 'networkidle' })
    await page.waitForFunction(() => !!(window as SlidevWindow).__slidev__)
    await page.evaluate(() => document.fonts.ready)

    for (;;) {
      const frontmatter = await page.evaluate(
        () => (window as SlidevWindow).__slidev__!.nav.currentSlideRoute.meta.slide.frontmatter,
      )
      const where = await page.evaluate(() => {
        const nav = (window as SlidevWindow).__slidev__!.nav
        return `slide ${nav.currentSlideNo}, click ${nav.clicks}`
      })
      const dwell = dwellFor(frontmatter, options.dwellMs)
      console.log(`Recording ${where} for ${dwell} ms`)
      await page.waitForTimeout(dwell)

      const hasNext = await page.evaluate(() => (window as SlidevWindow).__slidev__!.nav.hasNext)
      if (!hasNext)
        break
      await page.evaluate(() => (window as SlidevWindow).__slidev__!.nav.next())
    }

    const video = page.video()
    await context.close()
    if (!video)
      throw new Error('Playwright did not record a video')
    const output = resolve(options.output)
    await mkdir(dirname(output), { recursive: true })
    await video.saveAs(output)
    await browser.close()
    console.log(`Saved ${output}`)
  }
  finally {
    server.kill()
    await rm(videoDir, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
