// @vitest-environment node
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'
import { describeFeature, loadFeature } from '@amiceli/vitest-cucumber'
import { expect } from 'vitest'
import { HOST_PATH, serveSite } from '../apps/renderer/src/site.ts'

const feature = await loadFeature('./preview-host-page.feature')

interface Message { type: string, id?: string, mode?: string, [key: string]: unknown }
type Listener = (event: { source: unknown, data: Message }) => void

/**
 * The window and preview frame the host page's script sees, in place of
 * Chromium's: what the page posts to the frame is kept, and replies are
 * delivered as messages from the frame.
 */
class FakeHost {
  readonly posted: Message[] = []
  private readonly listeners: Listener[] = []
  readonly frame = { postMessage: (message: Message) => this.posted.push(message) }
  readonly window = {
    addEventListener: (type: string, listener: Listener) => {
      if (type === 'message')
        this.listeners.push(listener)
    },
    renderSlide: undefined as ((request: Message) => Promise<Message>) | undefined,
  }

  readonly document = { getElementById: (id: string) => id === 'preview' ? { contentWindow: this.frame } : null }

  reply(data: Message) {
    for (const listener of this.listeners)
      listener({ source: this.frame, data })
  }
}

function slide(extra: Partial<Message> = {}): Message {
  return { type: 'deyslide:render', slide: { content: '# One', frontmatter: {}, first: false }, headmatter: {}, clicks: 0, ...extra }
}

describeFeature(feature, ({ Scenario, AfterEachScenario }) => {
  let host: FakeHost
  let site: Awaited<ReturnType<typeof serveSite>> | undefined
  let folder: string | undefined
  let render: Promise<Message> | undefined
  let settled: Message | undefined

  AfterEachScenario(async () => {
    site?.close()
    site = undefined
    if (folder)
      await rm(folder, { recursive: true, force: true })
    folder = undefined
    render = undefined
    settled = undefined
  })

  /** Serves the page as the renderer does, then runs its script against the fake window. */
  async function openHostPage() {
    folder = await mkdtemp(join(tmpdir(), 'deyslide-host-'))
    site = await serveSite(folder)
    const page = await (await fetch(`${site.origin}${HOST_PATH}`)).text()
    expect(page).toContain('<iframe id="preview" sandbox="allow-scripts" src="/preview.html"')
    const script = /<script>([\s\S]*?)<\/script>/.exec(page)?.[1]
    expect(script).toBeTruthy()
    host = new FakeHost()
    runInNewContext(script!, { window: host.window, document: host.document })
    host.reply({ type: 'deyslide:ready' })
  }

  /** Starts a render and notes its reply when it comes. */
  async function startRender(request: Message) {
    const before = host.posted.length
    render = host.window.renderSlide!(request)
    void render.then((reply) => {
      settled = reply
    })
    // The page waits for the frame to be ready before it posts.
    await expect.poll(() => host.posted.length).toBe(before + 1)
  }

  const lastPosted = () => host.posted.at(-1)!

  Scenario('A reply meant for an earlier render is not taken for the current one', ({ Given, When, And, Then }) => {
    Given('the renderer\'s host page is open and its preview frame is ready', openHostPage)
    When('the page renders a slide', () => startRender(slide()))
    And('the frame replies with an error for an earlier render', () => {
      expect(lastPosted().id).toBeTruthy()
      host.reply({ type: 'deyslide:error', id: 'render-0', message: 'missing is not defined' })
    })
    Then('the render is still waiting', async () => {
      await new Promise(resolve => setTimeout(resolve, 20))
      expect(settled).toBeUndefined()
    })
    When('the frame replies "rendered" for that slide', () => {
      host.reply({ type: 'deyslide:rendered', id: lastPosted().id, clicks: 2 })
    })
    Then('the render resolves with that reply', async () => {
      expect(await render).toEqual({ type: 'deyslide:rendered', id: lastPosted().id, clicks: 2 })
    })
  })

  Scenario('Slides are drawn as for an export unless a mode is named', ({ Given, When, Then }) => {
    Given('the renderer\'s host page is open and its preview frame is ready', openHostPage)
    When('the page renders a slide without a mode', () => startRender(slide()))
    Then('the frame is asked to draw it in print mode', () => {
      expect(lastPosted()).toMatchObject({ type: 'deyslide:render', mode: 'print' })
    })
    When('the page renders a slide in present mode', () => startRender(slide({ mode: 'present' })))
    Then('the frame is asked to draw it in present mode', () => {
      expect(lastPosted()).toMatchObject({ type: 'deyslide:render', mode: 'present' })
    })
  })
})
