import type { VueWrapper } from '@vue/test-utils'
import type { DeckSession } from '../apps/web/src/deck/session'
import type { PresentAction, PresentDeck, PresentPosition } from '../apps/web/src/present/navigation'
import type { RenderRequest } from '../apps/web/src/preview/protocol'
import type { WebApp } from './support/web'
import { describeFeature, loadFeature } from '@amiceli/vitest-cucumber'
import { flushPromises } from '@vue/test-utils'
import { expect, vi } from 'vitest'
import * as Y from 'yjs'
import type { PresentChannel } from '../apps/web/src/platform/platform'
import type { PresentMessage } from '../apps/web/src/present/presentation'
import { MemoryGuestStorage } from '../apps/web/src/guest/memory-storage'
import { GuestStore } from '../apps/web/src/guest/store'
import { clearMediaLinks } from '../apps/web/src/platform/media'
import { isFullscreen, presentChannel, setFullscreen, startPlatform } from '../apps/web/src/platform/platform'
import { Autoplay, autoplayNext, dwellMs, goTo, keyAction, last, LAST_CLICKS, next, pointerAction, previous, first as firstSlide, settle, slideNumber } from '../apps/web/src/present/navigation'
import { slideTitle } from '../apps/web/src/present/outline'
import { CloudStore } from '../apps/web/src/projects/cloud-store'
import demoMarkdown from '../apps/deck/slides.md?raw'
import { deckToYDoc, fromMarkdown } from '../packages/deck-model/src'
import { FakeAccountService } from './support/account'
import { answerHeldRenders, previewAnswers, previewCaptures, previewRequests, resetEditorDoubles } from './support/editor-doubles'
import { accountDeck, changeSlide, openReady } from './support/live-decks'
import { FakeMediaApi } from './support/media-api'
import { FakePresentHub } from './support/present-channel'
import { FakeProjectApi } from './support/project-api'
import { find, findAll, mountWebApp, text } from './support/web'

// A stand in for the Deyslide app, for the channel scenarios: its commands, its events and its windows.
const app = vi.hoisted(() => ({
  platform: 'linux',
  label: 'main',
  invoke: vi.fn(),
  emitted: [] as { event: string, payload: unknown }[],
  listeners: [] as { event: string, handler: (event: { payload: unknown }) => void }[],
  fullscreen: false,
  setFullscreen: vi.fn(),
}))

vi.mock('@tauri-apps/api/core', () => ({ invoke: app.invoke }))
vi.mock('@tauri-apps/api/event', () => ({
  listen: async (event: string, handler: (event: { payload: unknown }) => void) => {
    const listener = { event, handler }
    app.listeners.push(listener)
    return () => {
      app.listeners.splice(app.listeners.indexOf(listener), 1)
    }
  },
  emit: async (event: string, payload: unknown) => {
    app.emitted.push({ event, payload: structuredClone(payload) })
  },
}))
vi.mock('@tauri-apps/api/webviewWindow', () => ({ getCurrentWebviewWindow: () => ({ label: app.label }) }))
vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({
    isFullscreen: async () => app.fullscreen,
    setFullscreen: async (on: boolean) => {
      app.fullscreen = on
      app.setFullscreen(on)
    },
  }),
}))

const feature = await loadFeature('./present.feature')

/** The demo deck's slides by title, and how many clicks each has. */
const DEMO = [
  { title: 'Deyslide', clicks: 0 },
  { title: 'Teaching: code that morphs', clicks: 2 },
  { title: 'Spatial zoom', clicks: 3 },
  { title: 'Algorithm animation', clicks: 0 },
  { title: 'Live workshop Q&A', clicks: 0 },
]

/** A deck for the transition scenario: slide 2 has 2 clicks and its own transition. */
const MOVES = `---
transition: slide-left
---

# Moves one

---
transition: fade
---

# Moves two

<v-clicks>

- A
- B

</v-clicks>

---

# Moves three
`

/** A deck that plays by itself quickly: every step stays 50 ms. */
const QUICK = `---
videoDwell: 0.05
---

# Quick one

---
videoDwell: 0.05
---

# Quick two

---
videoDwell: 0.05
---

# Quick three
`

/** A deck whose second slide does not compile. */
const BROKEN = `# Fine one

---

# Broken two

<div v-if="(">broken</div>

---

# Fine three
`

/** A deck whose second slide has a click for each item. */
const growing = (items: number) => `# Grow one

---

# Grow two

${Array.from({ length: items }, (_, item) => `<v-click>Item ${item + 1}</v-click>`).join('\n\n')}

---

# Grow three
`

/** A deck whose first slide has speaker notes with a link and a click marker. */
const NOTED = `# Noted one

<v-click>Shown later</v-click>

<!--
Read [the guide](https://example.com/guide) first.
[click] Then show the list.
-->

---

# Noted two
`

/** How many clicks a slide has, by its title, as the preview would say. */
const CLICKS: Record<string, number> = {
  ...Object.fromEntries(DEMO.map(slide => [slide.title, slide.clicks])),
  'Moves two': 2,
  'Noted one': 1,
}

/** A window the browser opened or found by its name, for the browser channel scenarios. */
interface FakeWindow {
  name: string
  closed: boolean
  focus: ReturnType<typeof vi.fn>
  location: FakeLocation
}

/** A window's address. Setting `href` loads a page, and is kept in `loads`. */
class FakeLocation {
  readonly loads: string[] = []
  private url: URL

  constructor(href: string) {
    this.url = new URL(href, 'http://localhost:3000/')
  }

  get href() {
    return this.url.href
  }

  set href(value: string) {
    this.loads.push(value)
    this.url = new URL(value, 'http://localhost:3000/')
  }

  get origin() {
    return this.url.origin
  }

  get pathname() {
    return this.url.pathname
  }
}

function titleOf(request: RenderRequest | undefined) {
  return request ? slideTitle(request.slide.content) : undefined
}

describeFeature(feature, ({ Scenario, ScenarioOutline, AfterEachScenario }) => {
  // Moving through a talk ------------------------------------------------------

  let deck: PresentDeck
  let at: PresentPosition
  let autoplay: Autoplay | undefined
  let typed: number | undefined

  const known = (clicks: (number | undefined)[]): PresentDeck => ({ slides: clicks.length, clicks })
  const demoDeck = () => known(DEMO.map(slide => slide.clicks))

  function talkAt(slide: number, clicks: number, deckNow = demoDeck()) {
    deck = deckNow
    at = { slide: slide - 1, clicks }
  }

  function expectAt(slide: number, clicks: number) {
    expect(at).toEqual({ slide: slide - 1, clicks })
  }

  function startAutoplay(loop = false, dwell = (slide: number) => 4000) {
    vi.useFakeTimers()
    autoplay = new Autoplay({
      dwellMs: () => dwell(at.slide),
      advance: () => {
        const target = autoplayNext(deck, at, loop)
        if (!target)
          return false
        at = target
        return true
      },
    })
    autoplay.start()
  }

  // The pages -------------------------------------------------------------------

  let web: WebApp | undefined
  let second: WebApp | undefined
  let hub: FakePresentHub | undefined
  let guest: GuestStore
  let projectId: string
  let deckId: string
  let budi: DeckSession | undefined
  let fullscreen: Element | null = null
  /** Channels a scenario opened, and what each heard, by name. */
  let channels: PresentChannel<PresentMessage>[] = []
  let heard: Record<string, PresentMessage[]> = {}
  /** Every window the fake browser knows, by name, and the calls to window.open. */
  let windows = new Map<string, FakeWindow>()
  let openCalls: [string, string][] = []

  AfterEachScenario(async () => {
    // Windows from one scenario are gone in the next, as after a reload.
    for (const open of windows.values())
      open.closed = true
    windows = new Map()
    openCalls = []
    window.name = ''
    await leaveApp()
    autoplay?.stop()
    autoplay = undefined
    vi.useRealTimers()
    budi?.close()
    budi = undefined
    second?.wrapper.unmount()
    second = undefined
    web?.unmount()
    web = undefined
    hub = undefined
    titles = DEMO.map(slide => slide.title)
    resetEditorDoubles()
    vi.restoreAllMocks()
    clearMediaLinks()
    fullscreen = null
    delete (document as { fullscreenElement?: unknown }).fullscreenElement
    delete (document.documentElement as { requestFullscreen?: unknown }).requestFullscreen
    delete (document as { exitFullscreen?: unknown }).exitFullscreen
  })

  async function deckInBrowser(markdown?: string, name = 'Sorting') {
    guest = await GuestStore.open(new MemoryGuestStorage())
    projectId = (await guest.createProject('Talks')).id
    deckId = (await guest.createDeck(projectId, name, markdown ? 'blank' : 'demo')).id
    if (markdown)
      await guest.saveDeck(projectId, deckId, fromMarkdown(markdown))
  }

  function answerRenders() {
    previewAnswers.clicks = request => CLICKS[slideTitle(request.slide.content)] ?? 0
  }

  async function mount(path: string, extra: Partial<Parameters<typeof mountWebApp>[0]> = {}) {
    hub ??= new FakePresentHub()
    answerRenders()
    return mountWebApp({ guest, path, provide: hub.provide, ...extra })
  }

  const presentPath = () => `/p/${projectId}/d/${deckId}/present`
  const presenterPath = () => `/p/${projectId}/d/${deckId}/presenter`

  async function present(markdown?: string, query = '') {
    hub = new FakePresentHub()
    await deckInBrowser(markdown)
    web = await mount(`${presentPath()}${query}`)
    await vi.waitFor(() => expect(find('[data-testid="present-stage"]')).not.toBeNull())
    await web.settle()
  }

  /** Signs Ana in on a fake server, with the app mounted and every openDeck call kept. */
  async function signedIn(api: FakeProjectApi, opened: unknown[] = []) {
    const service = new FakeAccountService()
    service.addAccount('ana@example.com', 'correct horse', 'Ana')
    await service.signIn({ email: 'ana@example.com', password: 'correct horse' })
    hub = new FakePresentHub()
    answerRenders()
    web = await mountWebApp({ service, api, provide: hub.provide })
    const store = web.workspace.store.value
    const open = store.openDeck.bind(store)
    vi.spyOn(store, 'openDeck').mockImplementation((project, deck, options) => {
      opened.push(options)
      return open(project, deck, options)
    })
    return store
  }

  /** The slide frame a page shows, not the hidden ones that draw pictures or exports. */
  function shownFrame(root: VueWrapper, within?: string) {
    return root.findAllComponents({ name: 'SlidePreviewFrame' })
      .find(frame => frame.element.getAttribute('data-testid') === 'preview-frame' && (!within || frame.element.closest(within)))
  }

  function shownRequest(root: VueWrapper = web!.wrapper, within?: string) {
    return shownFrame(root, within)?.props('request') as RenderRequest | undefined
  }

  async function expectShown(slide: number, clicks: number, root: VueWrapper = web!.wrapper, within?: string) {
    await vi.waitFor(() => {
      const request = shownRequest(root, within)
      expect(titleOf(request)).toBe(slideTitleAt(slide))
      expect(request?.clicks).toBe(clicks)
    })
  }

  /** A step that checks the audience view shows what its text says: "... slide 2 at click 1". */
  const shownStep = (title: string) => [title, () => {
    const [slide, clicks] = title.match(/\d+/g)!.map(Number)
    return expectShown(slide, clicks)
  }] as const

  /** The title of slide n of the deck on show. */
  let titles: string[] = DEMO.map(slide => slide.title)
  const slideTitleAt = (slide: number) => titles[slide - 1]

  async function press(key: string, root?: VueWrapper) {
    const event = new KeyboardEvent('keydown', { key: key === 'Space' ? ' ' : key, bubbles: true, cancelable: true })
    ;(root?.element.ownerDocument.body ?? document.body).dispatchEvent(event)
    await flushPromises()
  }

  /** Something the audience view's slide frame passes on: a press or a key on the slide. */
  async function fromSlide(event: 'pointer' | 'key', payload: Record<string, unknown>) {
    shownFrame(web!.wrapper, '[data-testid="present-page"]')!.vm.$emit(event, payload)
    await flushPromises()
  }

  async function tapInSlide(x: number, interactive: boolean) {
    const press = { pointerId: 3, pointerType: 'mouse', button: 0, x, y: 300, interactive }
    await fromSlide('pointer', { ...press, phase: 'down' })
    await fromSlide('pointer', { ...press, phase: 'up' })
  }

  const keyInSlide = (key: string, target: string) => fromSlide('key', { key, ctrlKey: false, altKey: false, metaKey: false, shiftKey: false, target })

  /** The fake browser: window.open finds a window by its name, else opens a blank one. */
  function fakeBrowserWindows() {
    vi.spyOn(window, 'open').mockImplementation((url, name) => {
      const key = String(name ?? '')
      openCalls.push([String(url ?? ''), key])
      let found = windows.get(key)
      if (!found || found.closed) {
        found = { name: key, closed: false, focus: vi.fn(), location: new FakeLocation('about:blank') }
        windows.set(key, found)
      }
      if (url)
        found.location.href = String(url)
      return found as unknown as Window
    })
  }

  /** A window the browser already shows, as one left open before this page loaded. */
  function openWindow(name: string, href: string) {
    const open: FakeWindow = { name, closed: false, focus: vi.fn(), location: new FakeLocation(href) }
    windows.set(name, open)
    return open
  }

  async function pointer(type: 'pointerdown' | 'pointerup', x: number, pointerType = 'mouse') {
    find('[data-testid="present-stage"]')!.dispatchEvent(new PointerEvent(type, { clientX: x, clientY: 300, pointerId: 1, pointerType, button: 0, bubbles: true }))
    await flushPromises()
  }

  async function tap(x: number) {
    await pointer('pointerdown', x)
    await pointer('pointerup', x)
  }

  /** A finger across the slide, or with `pointerType` 'mouse', a mouse drag. */
  async function swipe(from: number, to: number, pointerType = 'touch') {
    await pointer('pointerdown', from, pointerType)
    await pointer('pointerup', to, pointerType)
  }

  /** The page's full screen, as a browser keeps it. */
  function fakeFullscreen() {
    Object.defineProperty(document, 'fullscreenElement', { configurable: true, get: () => fullscreen })
    document.documentElement.requestFullscreen = vi.fn(async () => {
      fullscreen = document.documentElement
    })
    document.exitFullscreen = vi.fn(async () => {
      fullscreen = null
    })
  }

  // Moving through a talk ------------------------------------------------------

  /** The numbers in a step's text, in order. */
  const numbers = (title: string) => title.match(/\d+/g)!.map(Number)
  /** A step that sets up the talk where its text says: "a talk on slide 4 at click 0". */
  const talkStep = (title: string) => [title, () => talkAt(numbers(title)[0], numbers(title)[1])] as const
  /** A step that checks the talk is where its text says. */
  const atStep = (title: string) => [title, () => expectAt(numbers(title)[0], numbers(title)[1])] as const
  /** A step that lets time pass, then checks where the talk is: "after 3999 ms the talk is on slide 1 at click 0". */
  const laterStep = (title: string) => [title, () => {
    const [ms, slide, clicks] = numbers(title)
    vi.advanceTimersByTime(ms)
    expectAt(slide, clicks)
  }] as const
  const moveOn = () => {
    at = next(deck, at)
  }
  const goBack = () => {
    at = previous(deck, at)
  }

  Scenario('Next steps through a slide\'s clicks, then to the next slide', ({ Given, When, Then }) => {
    Given(...talkStep('a talk on slide 2 at click 0'))
    When('the presenter moves on 3 times', () => {
      for (let step = 0; step < 3; step++)
        moveOn()
    })
    Then(...atStep('the talk is on slide 3 at click 0'))
  })

  Scenario('Going back into a slide opens it at its last click, as in Slidev', ({ Given, When, Then }) => {
    Given(...talkStep('a talk on slide 4 at click 0'))
    When('the presenter goes back', goBack)
    Then(...atStep('the talk is on slide 3 at click 3'))
    When('the presenter goes back again', goBack)
    Then(...atStep('the talk is on slide 3 at click 2'))
  })

  Scenario('Going back into a slide whose clicks are not known yet asks for every click', ({ Given, When, Then }) => {
    Given('a talk on slide 4 at click 0, where only slide 4\'s clicks are known', () => talkAt(4, 0, known([undefined, undefined, undefined, 0, undefined])))
    When('the presenter goes back', goBack)
    Then('the talk is on slide 3 asking for every click', () => expectAt(3, LAST_CLICKS))
    When('the preview says slide 3 has 3 clicks', () => {
      deck = known([undefined, undefined, 3, 0, undefined])
      at = settle(deck, at)
    })
    Then(...atStep('the talk is on slide 3 at click 3'))
  })

  Scenario('A slide whose clicks are not known yet steps one click at a time', ({ Given, When, Then }) => {
    Given('a talk on slide 2 at click 0, where no clicks are known', () => talkAt(2, 0, known([undefined, undefined, undefined, undefined, undefined])))
    When('the presenter moves on', moveOn)
    Then(...atStep('the talk is on slide 2 at click 1'))
    When('the preview says slide 2 has 0 clicks', () => {
      deck = known([undefined, 0, undefined, undefined, undefined])
      at = settle(deck, at)
    })
    Then(...atStep('the talk is on slide 2 at click 0'))
  })

  Scenario('The talk stops at either end', ({ Given, When, Then }) => {
    Given(...talkStep('a talk on slide 5 at click 0'))
    When('the presenter moves on', moveOn)
    Then(...atStep('the talk is still on slide 5 at click 0'))
    Given(...talkStep('a talk on slide 1 at click 0'))
    When('the presenter goes back', goBack)
    Then(...atStep('the talk is still on slide 1 at click 0'))
  })

  Scenario('Going to a slide, the first and the last', ({ Given, When, Then }) => {
    Given(...talkStep('a talk on slide 3 at click 2'))
    When('the presenter goes to slide 2', () => {
      at = goTo(deck, 1)
    })
    Then(...atStep('the talk is on slide 2 at click 0'))
    When('the presenter goes to slide 9', () => {
      at = goTo(deck, 8)
    })
    Then(...atStep('the talk is on slide 5 at click 0'))
    When('the presenter goes to the first slide', () => {
      at = firstSlide(deck)
    })
    Then(...atStep('the talk is on slide 1 at click 0'))
    When('the presenter goes to the last slide', () => {
      at = last(deck)
    })
    Then(...atStep('the talk is back on slide 5 at click 0'))
  })

  ScenarioOutline('A typed slide number', ({ When, Then }, variables) => {
    When('the presenter types "<typed>" to go to a slide', () => {
      typed = slideNumber(demoDeck(), variables.typed)
    })
    Then('the talk goes to <where>', () => {
      expect(typed === undefined ? 'nowhere' : `slide ${typed + 1}`).toBe(variables.where)
    })
  })

  Scenario('Autoplay shows each step for the slide\'s videoDwell seconds, else 4 seconds', ({ Given, When, Then, And }) => {
    const frontmatter: Record<string, unknown>[] = DEMO.map(() => ({}))
    Given('a talk on slide 1 at click 0, where slide 2 has videoDwell 2', () => {
      frontmatter[1] = { videoDwell: 2 }
      talkAt(1, 0)
    })
    When('autoplay starts', () => startAutoplay(false, slide => dwellMs(frontmatter[slide])))
    Then(...laterStep('after 3999 ms the talk is on slide 1 at click 0'))
    And(...laterStep('after 1 ms more the talk is on slide 2 at click 0'))
    And(...laterStep('after 1999 ms more the talk is still on slide 2 at click 0'))
    And(...laterStep('after another 1 ms the talk is on slide 2 at click 1'))
  })

  Scenario('A move by hand gives the new step its whole time', ({ Given, When, Then, And }) => {
    Given(...talkStep('a talk on slide 1 at click 0'))
    When('autoplay starts', () => startAutoplay())
    And('after 3000 ms the presenter moves on by hand', () => {
      vi.advanceTimersByTime(3000)
      moveOn()
      autoplay!.restart()
    })
    Then(...laterStep('after 3999 ms the talk is on slide 2 at click 0'))
    And(...laterStep('after 1 ms more the talk is on slide 2 at click 1'))
  })

  Scenario('Autoplay stops at the end unless it loops', ({ Given, When, Then }) => {
    Given(...talkStep('a talk on slide 5 at click 0'))
    When('autoplay starts', () => startAutoplay())
    Then('after 4000 ms autoplay has stopped on slide 5 at click 0', () => {
      vi.advanceTimersByTime(4000)
      expect(autoplay!.running).toBe(false)
      expectAt(5, 0)
    })
    Given(...talkStep('the same talk on slide 5 at click 0'))
    When('autoplay starts with the loop on', () => startAutoplay(true))
    Then('after 4000 ms the talk is on slide 1 at click 0 and autoplay still runs', () => {
      vi.advanceTimersByTime(4000)
      expectAt(1, 0)
      expect(autoplay!.running).toBe(true)
    })
  })

  ScenarioOutline('Keys while presenting', ({ When, Then }, variables) => {
    let action: PresentAction | undefined
    When('the presenter presses "<key>"', () => {
      const [modifier, key] = variables.key.includes('+') ? variables.key.split('+') : ['', variables.key]
      action = keyAction({ key: key === 'Space' ? ' ' : key, ctrlKey: modifier === 'Control', altKey: false, metaKey: false })
    })
    Then('the key means "<action>"', () => {
      expect(action ?? 'nothing').toBe(variables.action)
    })
  })

  ScenarioOutline('Taps and swipes on the slide', ({ When, Then }, variables) => {
    let action: string | undefined
    When('the presenter <gesture> on a 900 pixel wide screen', () => {
      const gesture = variables.gesture as string
      const numbers = gesture.match(/\d+/g)!.map(Number)
      // Taps and swipes are a finger's unless the gesture names a mouse.
      const pointerType = gesture.includes('mouse') ? 'mouse' : 'touch'
      if (gesture.startsWith('taps') || gesture.startsWith('clicks'))
        action = pointerAction({ x: numbers[0], y: 200 }, { x: numbers[0], y: 200 }, 900, pointerType)
      else if (gesture.startsWith('swipes') || gesture.startsWith('drags a mouse'))
        action = pointerAction({ x: numbers[0], y: 200 }, { x: numbers[1], y: 210 }, 900, pointerType)
      else
        action = pointerAction({ x: numbers[1], y: 200 }, { x: numbers[1], y: 200 + numbers[0] }, 900, pointerType)
    })
    Then('the gesture means "<action>"', () => {
      expect(action ?? 'nothing').toBe(variables.action)
    })
  })

  // The pages ----------------------------------------------------------------------

  Scenario('The deck page and the project page have a Present button', ({ Given, When, Then, And }) => {
    Given('the demo deck "Sorting" is in this browser', () => deckInBrowser())
    When('I press Present next to the deck on the project page', async () => {
      web = await mount(`/p/${projectId}`)
      await web.click('[data-present="Sorting"]')
    })
    Then('the audience view shows slide 1 of 5 alone, without the site header', async () => {
      await vi.waitFor(() => expect(text('[data-testid="present-position"]')).toBe('1 / 5'))
      expect(web!.router.currentRoute.value.name).toBe('present')
      expect(find('header')).toBeNull()
      await expectShown(1, 0)
    })
    When('I go back to the deck page and press Present', async () => {
      await web!.router.push({ name: 'deck', params: { projectId, deckId } })
      await web!.click('[data-testid="present-deck"]')
    })
    Then('the audience view shows slide 1 of 5 alone again', async () => {
      await vi.waitFor(() => expect(text('[data-testid="present-position"]')).toBe('1 / 5'))
      expect(find('header')).toBeNull()
    })
    And('the deck page has a "Presenter view" button too', async () => {
      await web!.router.push({ name: 'deck', params: { projectId, deckId } })
      await web!.click('[data-testid="presenter-deck"]')
      await vi.waitFor(() => expect(web!.router.currentRoute.value.name).toBe('presenter'))
      await vi.waitFor(() => expect(find('[data-testid="presenter-page"]')).not.toBeNull())
    })
  })

  Scenario('A viewer of a shared deck presents it, and the deck opens once', ({ Given, When, Then }) => {
    const opened: unknown[] = []
    let store: Awaited<ReturnType<typeof signedIn>>
    let frame: Element | undefined
    Given('Budi shared the demo deck "Sorting" with Ana as a viewer', async () => {
      const api = new FakeProjectApi()
      const now = Date.now()
      projectId = 'shared-project'
      deckId = 'shared-deck'
      api.sharedProjects.push({
        id: projectId,
        name: 'Algorithms 101',
        createdAt: now,
        updatedAt: now,
        shared: { owner: { name: 'Budi', email: 'budi@example.com' }, role: null },
        decks: [{ id: deckId, name: 'Sorting', slideCount: 5, createdAt: now, updatedAt: now, role: 'viewer' }],
      })
      api.putDeckState(deckId, Y.encodeStateAsUpdate(deckToYDoc(fromMarkdown(demoMarkdown))))
      store = await signedIn(api, opened)
    })
    When('Ana presents the deck', async () => {
      await web!.router.push(presentPath())
    })
    Then('the audience view shows slide 1 of 5', async () => {
      await vi.waitFor(() => expect(text('[data-testid="present-position"]')).toBe('1 / 5'))
      await expectShown(1, 0)
      frame = shownFrame(web!.wrapper)?.element
    })
    When('the project lists refresh 3 times', async () => {
      for (let time = 0; time < 3; time++) {
        await (store as CloudStore).refresh()
        await web!.settle()
      }
    })
    Then('the deck was opened once, read only, and the slide frame stayed the same', async () => {
      await new Promise(resolve => setTimeout(resolve, 50))
      await web!.settle()
      expect(opened).toEqual([{ readOnly: true }])
      expect(shownFrame(web!.wrapper)?.element).toBe(frame)
      expect(text('[data-testid="present-position"]')).toBe('1 / 5')
    })
  })

  Scenario('A deck that cannot be opened says why, in both views', ({ Given, When, Then }) => {
    const OFFLINE = 'Offline. Changes sync when you are back online.'
    Given('Ana is signed in, with the demo deck "Sorting" in the account, and the connection is down', async () => {
      const api = new FakeProjectApi()
      ;({ projectId, deckId } = await accountDeck(api, demoMarkdown))
      api.goOffline()
      await signedIn(api)
    })
    When('Ana presents the deck', async () => {
      await web!.router.push(presentPath())
    })
    Then('the audience view says "Offline. Changes sync when you are back online."', async () => {
      await vi.waitFor(() => expect(text('[data-testid="present-problem"]')).toBe(OFFLINE))
    })
    When('Ana opens the presenter view instead', async () => {
      await web!.router.push(presenterPath())
    })
    Then('the presenter view says "Offline. Changes sync when you are back online." and shows no slide counter', async () => {
      await vi.waitFor(() => expect(text('[data-testid="presenter-problem"]')).toBe(OFFLINE))
      expect(find('[data-testid="presenter-slide"]')).toBeNull()
    })
  })

  Scenario('Presenting opens the deck read only, and live changes show up', ({ Given, When, Then }) => {
    let api: FakeProjectApi
    let opened: { options: unknown, session: Promise<DeckSession> }[] = []
    Given('Ana is signed in, with the demo deck "Sorting" in the account', async () => {
      const service = new FakeAccountService()
      service.addAccount('ana@example.com', 'correct horse', 'Ana')
      await service.signIn({ email: 'ana@example.com', password: 'correct horse' })
      api = new FakeProjectApi()
      ;({ projectId, deckId } = await accountDeck(api, demoMarkdown))
      hub = new FakePresentHub()
      answerRenders()
      web = await mountWebApp({ service, api, provide: hub.provide })
      const store = web.workspace.store.value
      const open = store.openDeck.bind(store)
      opened = []
      vi.spyOn(store, 'openDeck').mockImplementation((project, deck, options) => {
        const session = open(project, deck, options)
        opened.push({ options, session })
        return session
      })
    })
    When('Ana presents the deck', async () => {
      await web!.router.push(presentPath())
      await expectShown(1, 0)
    })
    Then('the deck was opened read only', async () => {
      expect(opened.map(item => item.options)).toEqual([{ readOnly: true }])
      expect((await opened[0].session).readOnly.value).toBe(true)
    })
    When('Budi changes the title of slide 1 to "Changed live" in another browser', async () => {
      budi = await openReady(await CloudStore.open(api), projectId, deckId)
      changeSlide(budi, 1, markdown => markdown.replace('<span class="dey-title">Deyslide</span>', 'Changed live'))
    })
    Then('the audience view shows the title "Changed live"', async () => {
      await vi.waitFor(() => expect(titleOf(shownRequest())).toBe('Changed live'))
      // An edit swaps the slide in place: no transition.
      expect(shownRequest()?.transition).toBeUndefined()
    })
  })

  Scenario('Project images show in the talk, the overview and the presenter view', ({ Given, When, Then }) => {
    const CAT = '/api/media/cat/file'
    const signedCat = { [CAT]: expect.stringMatching(/^https:\/\/storage\.example\/cat\?signature=\d+$/) }
    const withCat = (request: RenderRequest | undefined) => Boolean(request?.slide.content.includes(CAT))
    Given('Ana is signed in, with a deck in the account that shows a project image on slides 1 and 2', async () => {
      const api = new FakeProjectApi()
      ;({ projectId, deckId } = await accountDeck(api, `# One\n\n![Cat](${CAT})\n\n---\n\n# Two\n\n![Cat](${CAT})\n\n---\n\n# Three\n`, 'Pets'))
      const media = new FakeMediaApi()
      media.add(projectId, 'cat.png', { id: 'cat' })
      media.deckIn(deckId, projectId)
      vi.spyOn(globalThis, 'fetch').mockImplementation(media.fetch)
      vi.spyOn(URL, 'createObjectURL').mockImplementation(() => 'blob:picture')
      vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
      await signedIn(api)
    })
    When('Ana presents the deck', async () => {
      await web!.router.push(presentPath())
      await vi.waitFor(() => expect(find('[data-testid="present-stage"]')).not.toBeNull())
    })
    Then('the audience view\'s slide gets a signed link for the image', async () => {
      await vi.waitFor(() => expect(shownRequest()?.media).toEqual(signedCat))
    })
    When('the presenter presses "o"', () => press('o'))
    Then('the overview\'s pictures of slides 1 and 2 get the signed link too', async () => {
      await vi.waitFor(() => expect(findAll('[data-overview-slide] img')).toHaveLength(3))
      const pictures = previewRequests.filter(request => request.mode === 'print' && withCat(request))
      expect(pictures).toHaveLength(2)
      for (const picture of pictures)
        expect(picture.media).toEqual(signedCat)
    })
    When('Ana opens the presenter view of the deck', async () => {
      await web!.router.push(presenterPath())
      await vi.waitFor(() => expect(find('[data-testid="presenter-current"]')).not.toBeNull())
    })
    Then('its slide and its next step get the signed link', async () => {
      await vi.waitFor(() => expect(shownRequest(web!.wrapper, '[data-testid="presenter-current"]')?.media).toEqual(signedCat))
      await vi.waitFor(() => expect(shownRequest(web!.wrapper, '[data-testid="presenter-next"]')?.media).toEqual(signedCat))
    })
  })

  Scenario('Keys step through clicks and slides, with a transition only between slides', ({ Given, When, Then }) => {
    const expectMove = async (slide: number, clicks: number, transition?: { name: string, back: boolean }) => {
      await expectShown(slide, clicks)
      expect(shownRequest()?.transition).toEqual(transition)
      expect(shownRequest()?.mode).toBe('present')
    }
    Given('a deck whose transition is "slide-left", with a second slide of 2 clicks whose transition is "fade", is presented in this browser', async () => {
      titles = ['Moves one', 'Moves two', 'Moves three']
      await present(MOVES)
    })
    Then('the audience view shows slide 1 at click 0, without a transition', () => expectMove(1, 0))
    When('the presenter presses "ArrowRight"', () => press('ArrowRight'))
    Then('the audience view shows slide 2 at click 0, coming in with "slide-left", the transition of slide 1', () => expectMove(2, 0, { name: 'slide-left', back: false }))
    When('the presenter presses "Space" and "n"', async () => {
      await press('Space')
      await expectShown(2, 1)
      await press('n')
    })
    Then('the audience view shows slide 2 at click 2, without a transition', () => expectMove(2, 2))
    When('the presenter presses "ArrowRight" again', () => press('ArrowRight'))
    Then('the audience view shows slide 3 at click 0, coming in with "fade", the transition of slide 2', () => expectMove(3, 0, { name: 'fade', back: false }))
    When('the presenter presses "ArrowLeft"', () => press('ArrowLeft'))
    Then('the audience view shows slide 2 at click 2, coming back with "fade", the transition of slide 2', () => expectMove(2, 2, { name: 'fade', back: true }))
    When('the presenter presses "End" and then "Home"', async () => {
      await press('End')
      await expectShown(3, 0)
      await press('Home')
    })
    Then('the audience view shows slide 1 at click 0', async () => {
      await expectMove(1, 0, { name: 'slide-left', back: true })
      titles = DEMO.map(slide => slide.title)
    })
  })

  Scenario('A slide that does not compile does not stop the talk', ({ Given, When, Then }) => {
    Given('a deck whose second slide does not compile is presented in this browser', async () => {
      titles = ['Fine one', 'Broken two', 'Fine three']
      previewAnswers.error = request => slideTitle(request.slide.content) === 'Broken two' ? 'Unexpected token )' : undefined
      await present(BROKEN)
    })
    When('the presenter presses "ArrowRight"', () => press('ArrowRight'))
    Then('the audience view shows slide 2 at click 0 and the error', async () => {
      await expectShown(2, 0)
      await vi.waitFor(() => expect(text('[data-testid="slide-error"]')).toBe('Unexpected token )'))
    })
    When('the presenter presses "ArrowRight" again', () => press('ArrowRight'))
    Then(...shownStep('the audience view shows slide 3 at click 0'))
    When('the presenter presses "ArrowLeft" twice', async () => {
      await press('ArrowLeft')
      await expectShown(2, 0)
      await press('ArrowLeft')
    })
    Then('the audience view shows slide 1 at click 0', async () => {
      await expectShown(1, 0)
      titles = DEMO.map(slide => slide.title)
    })
  })

  Scenario('Keys pressed before a slide is drawn all count', ({ Given, When, Then, And }) => {
    Given('the demo deck "Sorting" is presented in this browser, with a preview slow to draw', async () => {
      previewAnswers.slow = true
      await present()
    })
    When('the presenter presses "ArrowRight" 3 times before slide 1 is drawn', async () => {
      for (let time = 0; time < 3; time++)
        await press('ArrowRight')
    })
    And('the preview draws the slides', async () => {
      answerHeldRenders()
      await flushPromises()
    })
    Then(...shownStep('the audience view shows slide 2 at click 2'))
  })

  Scenario('Going back twice before a slide is drawn stops at its click before the last', ({ Given, When, Then, And }) => {
    Given('the demo deck "Sorting" is presented from slide 3 in this browser, with a preview slow to draw', async () => {
      previewAnswers.slow = true
      await present(undefined, '?slide=3')
    })
    When('the presenter presses "ArrowLeft" twice before slide 3 is drawn', async () => {
      await press('ArrowLeft')
      await press('ArrowLeft')
    })
    And('the preview draws the slides', async () => {
      answerHeldRenders()
      await flushPromises()
    })
    Then(...shownStep('the audience view shows slide 2 at click 1'))
  })

  Scenario('A slide that gains a click while presenting opens at its new last click', ({ Given, When, Then, And }) => {
    Given('a deck whose second slide has 2 clicks is presented in this browser, on slide 3', async () => {
      titles = ['Grow one', 'Grow two', 'Grow three']
      await present(growing(2))
      previewAnswers.clicks = request => (request.slide.content.match(/<v-click>/g) ?? []).length
      // Through slide 2 and its clicks, so its count is known.
      for (const [slide, clicks] of [[2, 0], [2, 1], [2, 2], [3, 0]]) {
        await press('ArrowRight')
        await expectShown(slide, clicks)
      }
    })
    When('someone adds a third click to slide 2', async () => {
      await guest.saveDeck(projectId, deckId, fromMarkdown(growing(3)))
      // The page reads the deck again a moment after it changes.
      await new Promise(resolve => setTimeout(resolve, 150))
      await flushPromises()
    })
    And('the presenter presses "ArrowLeft"', () => press('ArrowLeft'))
    Then('the audience view shows slide 2 at click 3', async () => {
      await expectShown(2, 3)
      titles = DEMO.map(slide => slide.title)
    })
  })

  Scenario('Taps and swipes move the talk', ({ Given, When, Then }) => {
    Given('the demo deck "Sorting" is presented in this browser', () => present())
    When('the presenter taps the right side of the slide', () => tap(window.innerWidth - 100))
    Then(...shownStep('the audience view shows slide 2 at click 0'))
    When('the presenter swipes left on the slide', () => swipe(600, 400))
    Then(...shownStep('the audience view shows slide 2 at click 1'))
    When('the presenter taps the left third of the slide', () => tap(50))
    Then(...shownStep('the audience view is back on slide 2 at click 0'))
    When('the presenter swipes right on the slide', () => swipe(300, 600))
    Then(...shownStep('the audience view shows slide 1 at click 0'))
    When('the presenter drags the mouse from right to left across the slide, to select its text', () => swipe(600, 300, 'mouse'))
    Then('the audience view still shows slide 1 at click 0', async () => {
      await flushPromises()
      await expectShown(1, 0)
    })
  })

  Scenario('A press on the slide\'s own controls is left to the slide', ({ Given, When, Then }) => {
    Given('the demo deck "Sorting" is presented in this browser', () => present())
    When('the presenter presses a button inside the slide', () => tapInSlide(window.innerWidth - 100, true))
    Then('the audience view still shows slide 1 at click 0', async () => {
      await flushPromises()
      await expectShown(1, 0)
    })
    When('the presenter taps the slide itself, on its right side', () => tapInSlide(window.innerWidth - 100, false))
    Then(...shownStep('the audience view shows slide 2 at click 0'))
    When('the presenter presses "ArrowRight" while the slide has the focus', () => keyInSlide('ArrowRight', 'none'))
    Then(...shownStep('the audience view shows slide 2 at click 1'))
    When('the presenter presses "ArrowRight" while typing in a field inside the slide', () => keyInSlide('ArrowRight', 'text'))
    Then('the audience view still shows slide 2 at click 1', async () => {
      await flushPromises()
      await expectShown(2, 1)
    })
  })

  Scenario('Ticking Loop or pressing a control leaves the keys to the talk', ({ Given, When, Then }) => {
    const loopBox = () => find('[data-testid="present-loop"]') as HTMLInputElement
    const keyOn = async (element: Element, key: string) => {
      element.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
      await flushPromises()
    }
    Given('the demo deck "Sorting" is presented in this browser', () => present())
    Then('a press on the controls does not take the focus', () => {
      for (const control of ['present-fullscreen', 'present-previous', 'present-loop']) {
        const press = new MouseEvent('mousedown', { bubbles: true, cancelable: true })
        find(`[data-testid="${control}"]`)!.dispatchEvent(press)
        expect(press.defaultPrevented).toBe(true)
      }
    })
    When('the presenter ticks Loop and presses "ArrowRight" on it', async () => {
      loopBox().click()
      await flushPromises()
      expect(loopBox().checked).toBe(true)
      await keyOn(loopBox(), 'ArrowRight')
    })
    Then(...shownStep('the audience view shows slide 2 at click 0'))
    When('the presenter presses "Space" on the Loop box', () => keyOn(loopBox(), ' '))
    Then('the audience view still shows slide 2 at click 0', async () => {
      await flushPromises()
      await expectShown(2, 0)
    })
  })

  Scenario('On a touch screen, a button brings back the controls without moving the talk', ({ Given, When, Then }) => {
    const controls = () => find('[data-testid="present-controls"]')!
    const finger = async (type: 'pointerdown' | 'pointerup', x: number) => {
      find('[data-testid="present-stage"]')!.dispatchEvent(new PointerEvent(type, { clientX: x, clientY: 300, pointerId: 9, pointerType: 'touch', button: 0, bubbles: true }))
      await flushPromises()
    }
    Given('the demo deck "Sorting" is presented on a touch screen', () => present())
    When('the presenter taps the right side of the slide with a finger', async () => {
      // The controls shown on opening hide once nothing moves.
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      find('[data-testid="present-page"]')!.dispatchEvent(new PointerEvent('pointermove', { bubbles: true }))
      vi.advanceTimersByTime(2000)
      await flushPromises()
      expect(controls().style.display).toBe('none')
      await finger('pointerdown', window.innerWidth - 100)
      await finger('pointerup', window.innerWidth - 100)
    })
    Then('the audience view shows slide 2 at click 0, and the controls stay hidden', async () => {
      await expectShown(2, 0)
      expect(controls().style.display).toBe('none')
      expect(find('[data-testid="present-menu"]')).not.toBeNull()
    })
    When('the presenter taps the button that shows the controls', () => web!.click('[data-testid="present-menu"]'))
    Then('the controls show and the audience view still shows slide 2 at click 0', async () => {
      expect(controls().style.display).toBe('')
      expect(find('[data-testid="present-menu"]')).toBeNull()
      await expectShown(2, 0)
      vi.useRealTimers()
    })
  })

  Scenario('The overview shows every slide, and a click goes there', ({ Given, When, Then, And }) => {
    Given('the demo deck "Sorting" is presented in this browser', async () => {
      let pictures = 0
      vi.spyOn(URL, 'createObjectURL').mockImplementation(() => `blob:picture-${++pictures}`)
      vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
      await present()
    })
    When('the presenter presses "o"', () => press('o'))
    Then('the overview shows 5 slides with their titles, slide 1 marked as the one on screen', async () => {
      await vi.waitFor(() => expect(findAll('[data-overview-slide]')).toHaveLength(5))
      expect(findAll('[data-overview-slide]').map(tile => [...tile.querySelectorAll('span span')].map(part => part.textContent?.trim()))).toEqual(DEMO.map((slide, index) => [String(index + 1), slide.title]))
      expect(find('[data-overview-slide="1"]')!.getAttribute('aria-current')).toBe('true')
    })
    And('the overview draws a picture of each slide in print mode at its last click', async () => {
      await vi.waitFor(() => expect(findAll('[data-overview-slide] img')).toHaveLength(5))
      const drawn = previewRequests.filter(request => request.mode === 'print')
      expect(drawn.map(titleOf)).toEqual(DEMO.map(slide => slide.title))
      expect(drawn.every(request => request.clicks === LAST_CLICKS)).toBe(true)
      expect(previewCaptures).toEqual([0.25, 0.25, 0.25, 0.25, 0.25])
    })
    When('the presenter picks slide 4 in the overview', async () => {
      find('[data-overview-slide="4"]')!.click()
      await flushPromises()
    })
    Then('the overview is closed and the audience view shows slide 4 at click 0', async () => {
      expect(find('[data-testid="present-overview-grid"]')).toBeNull()
      await expectShown(4, 0)
    })
  })

  Scenario('Tiles still waiting for their picture say so', ({ Given, When, Then }) => {
    Given('the demo deck "Sorting" is presented in this browser, with a preview slow to draw', async () => {
      let pictures = 0
      vi.spyOn(URL, 'createObjectURL').mockImplementation(() => `blob:picture-${++pictures}`)
      vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
      previewAnswers.slow = true
      await present()
    })
    When('the presenter presses "o"', () => press('o'))
    Then('every tile of the overview says its picture is being drawn', async () => {
      await vi.waitFor(() => expect(findAll('[data-overview-slide]')).toHaveLength(5))
      expect(findAll('[data-overview-slide] [data-overview-waiting]').map(tile => tile.textContent?.trim())).toEqual(Array.from({ length: 5 }, () => 'Drawing...'))
      expect(findAll('[data-overview-slide] img')).toHaveLength(0)
    })
    When('the preview draws the slides', async () => {
      answerHeldRenders()
      await flushPromises()
    })
    Then('every tile shows its picture, and none says it is being drawn', async () => {
      await vi.waitFor(() => expect(findAll('[data-overview-slide] img')).toHaveLength(5))
      expect(findAll('[data-overview-waiting]')).toHaveLength(0)
    })
  })

  Scenario('The overview draws the slide on screen first', ({ Given, When, Then }) => {
    Given('the demo deck "Sorting" is presented from slide 3 in this browser', async () => {
      let pictures = 0
      vi.spyOn(URL, 'createObjectURL').mockImplementation(() => `blob:picture-${++pictures}`)
      vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
      await present(undefined, '?slide=3')
      await expectShown(3, 0)
    })
    When('the presenter presses "o"', () => press('o'))
    Then('the overview draws slides 3, 4, 5, 1 and 2, in that order', async () => {
      await vi.waitFor(() => expect(findAll('[data-overview-slide] img')).toHaveLength(5))
      const drawn = previewRequests.filter(request => request.mode === 'print')
      expect(drawn.map(titleOf)).toEqual([2, 3, 4, 0, 1].map(index => DEMO[index].title))
    })
  })

  Scenario('Go to a slide by its number', ({ Given, When, Then }) => {
    const typeNumber = async (value: string) => {
      const input = find('[data-testid="goto-input"]') as HTMLInputElement
      input.value = value
      input.dispatchEvent(new Event('input'))
      await flushPromises()
      find('[data-testid="goto-form"]')!.dispatchEvent(new Event('submit', { cancelable: true }))
      await flushPromises()
    }
    Given('the demo deck "Sorting" is presented in this browser', () => present())
    When('the presenter presses "g" and types "9"', async () => {
      await press('g')
      await vi.waitFor(() => expect(find('[data-testid="goto-input"]')).not.toBeNull())
      await typeNumber('9')
    })
    Then('the page says "Type a slide number from 1 to 5."', () => {
      expect(text('[data-testid="goto-form"] [role="alert"]')).toBe('Type a slide number from 1 to 5.')
    })
    When('the presenter types "3" instead', () => typeNumber('3'))
    Then('the audience view shows slide 3 at click 0', async () => {
      expect(find('[data-testid="goto-form"]')).toBeNull()
      await expectShown(3, 0)
    })
  })

  Scenario('A tap beside the slide number form closes it', ({ Given, When, Then }) => {
    Given('the demo deck "Sorting" is presented in this browser', () => present())
    When('the presenter presses "g" and then taps the slide', async () => {
      await press('g')
      await vi.waitFor(() => expect(find('[data-testid="goto-form"]')).not.toBeNull())
      await tap(window.innerWidth - 100)
    })
    Then('the form is closed and the audience view still shows slide 1 at click 0', async () => {
      expect(find('[data-testid="goto-form"]')).toBeNull()
      await expectShown(1, 0)
    })
  })

  Scenario('Escape leaves the overview, then full screen, then the talk', ({ Given, When, Then }) => {
    Given('the demo deck "Sorting" is presented in this browser, full screen', async () => {
      fakeFullscreen()
      await present()
      await press('f')
      await vi.waitFor(() => expect(fullscreen).toBe(document.documentElement))
    })
    When('the presenter presses "o" and then "Escape"', async () => {
      await press('o')
      await vi.waitFor(() => expect(find('[data-testid="present-overview-grid"]')).not.toBeNull())
      await press('Escape')
    })
    Then('the overview is closed and the page is still full screen', async () => {
      await vi.waitFor(() => expect(find('[data-testid="present-overview-grid"]')).toBeNull())
      expect(fullscreen).toBe(document.documentElement)
    })
    When('the presenter presses "Escape"', () => press('Escape'))
    Then('the page is no longer full screen', async () => {
      await vi.waitFor(() => expect(fullscreen).toBeNull())
      expect(web!.router.currentRoute.value.name).toBe('present')
    })
    When('the presenter presses "Escape" again', () => press('Escape'))
    Then('the deck page shows again', async () => {
      await vi.waitFor(() => expect(web!.router.currentRoute.value.name).toBe('deck'))
      await vi.waitFor(() => expect(find('[data-testid="deck-name"]')?.textContent?.trim()).toBe('Sorting'))
    })
  })

  Scenario('Escape in the audience window a presenter view opened closes it', ({ Given, When, Then }) => {
    let close: ReturnType<typeof vi.spyOn>
    Given('the demo deck "Sorting" is presented in the audience window its presenter view opened', async () => {
      hub = new FakePresentHub()
      await deckInBrowser()
      window.name = `deyslide-present:${deckId}`
      close = vi.spyOn(window, 'close').mockImplementation(() => {})
      web = await mount(presentPath())
      await vi.waitFor(() => expect(find('[data-testid="present-stage"]')).not.toBeNull())
    })
    Then('the controls offer no Presenter view', async () => {
      await vi.waitFor(() => expect(find('[data-testid="present-presenter"]')).toBeNull())
      expect(find('[data-testid="present-exit"]')).not.toBeNull()
    })
    When('the presenter presses "Escape"', () => press('Escape'))
    Then('the window closes, and the page does not open the editor', async () => {
      await vi.waitFor(() => expect(close).toHaveBeenCalledTimes(1))
      await web!.settle()
      expect(web!.router.currentRoute.value.name).toBe('present')
    })
  })

  Scenario('In the desktop app, Escape keeps the audience window on the talk', ({ Given, When, Then }) => {
    Given('the demo deck "Sorting" is presented in the app\'s audience window', async () => {
      hub = new FakePresentHub()
      await deckInBrowser()
      await inApp('linux')
      app.label = `present-${deckId}`
      web = await mount(presentPath())
      await vi.waitFor(() => expect(find('[data-testid="present-stage"]')).not.toBeNull())
    })
    Then('the controls offer neither Presenter view nor Exit', async () => {
      await vi.waitFor(() => expect(find('[data-testid="present-presenter"]')).toBeNull())
      expect(find('[data-testid="present-exit"]')).toBeNull()
    })
    When('the presenter presses "Escape"', () => press('Escape'))
    Then('the window stays on the talk', async () => {
      await new Promise(resolve => setTimeout(resolve, 20))
      await web!.settle()
      expect(web!.router.currentRoute.value.name).toBe('present')
      await expectShown(1, 0)
    })
  })

  Scenario('Cinematic mode plays the talk by itself', ({ Given, When, Then, And }) => {
    Given('a deck whose slides each set videoDwell to 0.05 seconds is presented in this browser', async () => {
      titles = ['Quick one', 'Quick two', 'Quick three']
      await present(QUICK)
    })
    When('the presenter presses "a"', () => press('a'))
    Then('the mode switch says Cinematic', () => {
      expect(find('[data-testid="mode-cinematic"]')!.getAttribute('aria-pressed')).toBe('true')
      expect(find('[data-testid="mode-teaching"]')!.getAttribute('aria-pressed')).toBe('false')
    })
    And(...shownStep('the talk moves on by itself to slide 2 at click 0'))
    When('the presenter presses "a" again', () => press('a'))
    Then('the mode switch says Live Teaching', () => {
      expect(find('[data-testid="mode-teaching"]')!.getAttribute('aria-pressed')).toBe('true')
      titles = DEMO.map(slide => slide.title)
    })
  })

  Scenario('The address can start Cinematic mode with the loop on', ({ Given, Then, And }) => {
    Given('a deck whose slides each set videoDwell to 0.05 seconds is presented in this browser with "?mode=cinematic&loop=1"', async () => {
      titles = ['Quick one', 'Quick two', 'Quick three']
      await present(QUICK, '?mode=cinematic&loop=1')
    })
    Then('the mode switch says Cinematic and Loop is ticked', () => {
      expect(find('[data-testid="mode-cinematic"]')!.getAttribute('aria-pressed')).toBe('true')
      expect((find('[data-testid="present-loop"]') as HTMLInputElement).checked).toBe(true)
    })
    And('the talk plays to slide 3 and starts again from slide 1', async () => {
      await expectShown(3, 0)
      await expectShown(1, 0)
      expect(find('[data-testid="mode-cinematic"]')!.getAttribute('aria-pressed')).toBe('true')
      titles = DEMO.map(slide => slide.title)
    })
  })

  Scenario('The cursor and the controls hide after 2 seconds without moving', ({ Given, When, Then }) => {
    const page = () => find('[data-testid="present-page"]')!
    Given('the demo deck "Sorting" is presented in this browser', () => present())
    When('the pointer rests for 2 seconds', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      page().dispatchEvent(new PointerEvent('pointermove', { bubbles: true }))
      vi.advanceTimersByTime(1999)
      await flushPromises()
      expect(page().dataset.idle).toBe('false')
      vi.advanceTimersByTime(1)
      await flushPromises()
    })
    Then('the cursor and the controls are hidden', () => {
      expect(page().dataset.idle).toBe('true')
      expect(page().classList).toContain('cursor-none')
      expect(find('[data-testid="present-controls"]')!.style.display).toBe('none')
    })
    When('the pointer moves', async () => {
      page().dispatchEvent(new PointerEvent('pointermove', { bubbles: true }))
      await flushPromises()
    })
    Then('the controls show again', () => {
      expect(page().classList).not.toContain('cursor-none')
      expect(find('[data-testid="present-controls"]')!.style.display).toBe('')
      vi.useRealTimers()
    })
  })

  Scenario('Once the pointer rests, the slide hides it too, and its own buttons still work', ({ Given, When, Then, And }) => {
    const slideFrame = () => shownFrame(web!.wrapper, '[data-testid="present-page"]')!
    Given('the demo deck "Sorting" is presented in this browser', () => present())
    When('the pointer rests for 2 seconds on a button inside the slide', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      await fromSlide('pointer', { phase: 'move', pointerId: 3, pointerType: 'mouse', button: -1, x: window.innerWidth - 100, y: 300, interactive: true })
      expect(slideFrame().props('hideCursor')).toBe(false)
      vi.advanceTimersByTime(2000)
      await flushPromises()
    })
    Then('the slide is asked to hide the cursor, and nothing is laid over the slide', () => {
      expect(find('[data-testid="present-page"]')!.dataset.idle).toBe('true')
      expect(slideFrame().props('hideCursor')).toBe(true)
      // Only the stage that holds the slide fills the page; a layer above it would take the next press from the slide.
      expect(findAll('[data-testid="present-page"] .inset-0').map(layer => layer.getAttribute('data-testid'))).toEqual(['present-stage'])
    })
    When('the presenter presses that button', () => tapInSlide(window.innerWidth - 100, true))
    Then('the audience view still shows slide 1 at click 0', async () => {
      await flushPromises()
      await expectShown(1, 0)
    })
    And('the slide is asked to show the cursor again', () => {
      expect(slideFrame().props('hideCursor')).toBe(false)
      vi.useRealTimers()
    })
  })

  Scenario('Presenting starts on the slide open in the editor, and each view keeps the slide', ({ Given, When, Then, And }) => {
    const editorAt = async (slide: number) => {
      await vi.waitFor(() => expect(web!.router.currentRoute.value.name).toBe('deck'))
      await vi.waitFor(() => expect(text('[data-testid="slide-position"]')).toBe(`Slide ${slide} of 5`))
    }
    const presenterAt = async (slide: number) => {
      await vi.waitFor(() => expect(web!.router.currentRoute.value.name).toBe('presenter'))
      await vi.waitFor(() => expect(text('[data-testid="presenter-slide"]')).toBe(`Slide ${slide} of 5`))
      await expectShown(slide, 0, web!.wrapper, '[data-testid="presenter-current"]')
    }
    Given('the demo deck "Sorting" is open in the editor on slide 3', async () => {
      await deckInBrowser()
      web = await mount(`/p/${projectId}/d/${deckId}`)
      await editorAt(1)
      await web.click('[data-testid="next-slide"]')
      await web.click('[data-testid="next-slide"]')
      await editorAt(3)
    })
    When('I press Present', () => web!.click('[data-testid="present-deck"]'))
    Then('the audience view shows slide 3 of 5', async () => {
      await vi.waitFor(() => expect(text('[data-testid="present-position"]')).toBe('3 / 5'))
      await expectShown(3, 0)
    })
    When('the presenter presses "ArrowRight" and opens the presenter view from the controls', async () => {
      // Slide 3 has 3 clicks; End goes past them to slide 5, so step there by number instead.
      for (let step = 0; step < 4; step++)
        await press('ArrowRight')
      await expectShown(4, 0)
      await web!.click('[data-testid="present-presenter"]')
    })
    Then('the presenter view shows slide 4 of 5', () => presenterAt(4))
    And('it asked to open the audience window on slide 4', () => {
      expect(hub!.opened.at(-1)).toEqual({ projectId, deckId, url: `${presentPath()}?slide=4` })
    })
    When('the presenter presses "Escape" in the presenter view', () => press('Escape'))
    Then('the editor shows slide 4 of 5', async () => {
      await editorAt(4)
      // The editor keeps its own slide from here, so the address lets it go.
      await vi.waitFor(() => expect(web!.router.currentRoute.value.query.slide).toBeUndefined())
    })
    When('I open the presenter view from the editor', () => web!.click('[data-testid="presenter-deck"]'))
    Then('the presenter view shows slide 4 of 5 again', () => presenterAt(4))
  })

  Scenario('The presenter view shows the slide, the next step, the notes, a timer and the clock', ({ Given, Then, And, When }) => {
    Given('the demo deck "Sorting" is open in the presenter view', async () => {
      vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] })
      hub = new FakePresentHub()
      await deckInBrowser()
      web = await mount(presenterPath())
      await vi.waitFor(() => expect(find('[data-testid="presenter-current"]')).not.toBeNull())
    })
    Then('it shows slide 1 of 5, the next step "Slide 2" and the notes "Welcome everyone."', async () => {
      expect(text('[data-testid="presenter-slide"]')).toBe('Slide 1 of 5')
      await expectShown(1, 0, web!.wrapper, '[data-testid="presenter-current"]')
      await vi.waitFor(() => expect(text('[data-testid="presenter-next"] h2')).toBe('Next: Slide 2'))
      expect(titleOf(shownRequest(web!.wrapper, '[data-testid="presenter-next"]'))).toBe(DEMO[1].title)
      expect(text('[data-testid="presenter-notes"]')).toMatch(/^Welcome everyone\./)
    })
    And('it asked to open the audience window at the present page of the deck, on slide 1', () => {
      expect(hub!.opened).toEqual([{ projectId, deckId, url: `${presentPath()}?slide=1` }])
    })
    When('the presenter presses its Next button 2 times', async () => {
      await web!.click('[data-testid="presenter-next-step"]')
      await expectShown(2, 0, web!.wrapper, '[data-testid="presenter-current"]')
      await web!.click('[data-testid="presenter-next-step"]')
    })
    Then('it shows slide 2 at click 1, the next step "Click 2 of slide 2" and the notes "Step 1: ask the room"', async () => {
      await expectShown(2, 1, web!.wrapper, '[data-testid="presenter-current"]')
      expect(text('[data-testid="presenter-click"]')).toBe('Click 1 of 2')
      expect(text('[data-testid="presenter-next"] h2')).toBe('Next: Click 2 of slide 2')
      const upcoming = shownRequest(web!.wrapper, '[data-testid="presenter-next"]')
      expect([titleOf(upcoming), upcoming?.clicks]).toEqual([DEMO[1].title, 2])
      expect(text('[data-testid="presenter-notes"]')).toMatch(/^Step 1: ask the room/)
    })
    When('65 seconds pass', async () => {
      vi.advanceTimersByTime(65_000)
      await flushPromises()
    })
    Then('the timer reads "01:05"', () => {
      expect(text('[data-testid="presenter-timer"]')).toBe('01:05')
    })
    When('the presenter resets the timer', () => web!.click('[data-testid="presenter-reset"]'))
    Then('the timer reads "00:00"', () => {
      expect(text('[data-testid="presenter-timer"]')).toBe('00:00')
    })
  })

  Scenario('The presenter view\'s notes follow the clicks, and their links open beside it', ({ Given, When, Then, And }) => {
    const current = () => find('[data-testid="presenter-notes"] [aria-current="true"]')?.textContent?.trim()
    Given('a deck whose speaker notes have a link and a click marker is open in the presenter view', async () => {
      titles = ['Noted one', 'Noted two']
      hub = new FakePresentHub()
      await deckInBrowser(NOTED)
      web = await mount(presenterPath())
      await expectShown(1, 0, web.wrapper, '[data-testid="presenter-current"]')
    })
    Then('the notes show the part before the marker as the current one, and no marker text', async () => {
      await vi.waitFor(() => expect(current()).toBe('Read the guide first.'))
      expect(findAll('[data-testid="presenter-notes"] [data-note-clicks]').map(part => part.textContent?.trim())).toEqual(['Read the guide first.', 'Then show the list.'])
      expect(text('[data-testid="presenter-notes"]')).not.toContain('[click]')
    })
    And('the link in the notes opens in a new window', () => {
      const link = find('[data-testid="presenter-notes"] a')!
      expect(link.getAttribute('href')).toBe('https://example.com/guide')
      expect(link.getAttribute('target')).toBe('_blank')
      expect(link.getAttribute('rel')).toContain('noopener')
    })
    When('the presenter presses its Next button', () => web!.click('[data-testid="presenter-next-step"]'))
    Then('the notes show the part after the marker as the current one', async () => {
      await expectShown(1, 1, web!.wrapper, '[data-testid="presenter-current"]')
      expect(current()).toBe('Then show the list.')
      expect(text('[data-testid="presenter-click"]')).toBe('Click 1 of 1')
    })
    When('the presenter presses its Next button again', () => web!.click('[data-testid="presenter-next-step"]'))
    Then('the presenter view shows slide 2 of 2 and no click counter, since that slide has no clicks', async () => {
      await expectShown(2, 0, web!.wrapper, '[data-testid="presenter-current"]')
      expect(text('[data-testid="presenter-slide"]')).toBe('Slide 2 of 2')
      expect(find('[data-testid="presenter-click"]')).toBeNull()
      titles = DEMO.map(slide => slide.title)
    })
  })

  Scenario('Clicking the slides in the presenter view leaves the keys to it', ({ Given, Then }) => {
    Given('the demo deck "Sorting" is open in the presenter view', async () => {
      hub = new FakePresentHub()
      await deckInBrowser()
      web = await mount(presenterPath())
      await expectShown(1, 0, web.wrapper, '[data-testid="presenter-current"]')
    })
    Then('its slides take no clicks and no focus', async () => {
      await vi.waitFor(() => expect(findAll('[data-testid="presenter-page"] [data-testid="preview-frame"]')).toHaveLength(2))
      for (const frame of findAll('[data-testid="presenter-page"] [data-testid="preview-frame"]')) {
        expect(frame.classList).toContain('pointer-events-none')
        expect(frame.getAttribute('tabindex')).toBe('-1')
      }
    })
  })

  Scenario('A click on the presenter view\'s buttons leaves Space and Enter to the talk', ({ Given, Then }) => {
    Given('the demo deck "Sorting" is open in the presenter view', async () => {
      hub = new FakePresentHub()
      await deckInBrowser()
      web = await mount(presenterPath())
      await expectShown(1, 0, web.wrapper, '[data-testid="presenter-current"]')
    })
    Then('a press on its Previous, Next, Reset and audience buttons does not take the focus', () => {
      // A button that kept the focus would take the next Space or Enter, and press itself again.
      for (const control of ['presenter-previous', 'presenter-next-step', 'presenter-reset', 'open-audience']) {
        const press = new MouseEvent('mousedown', { bubbles: true, cancelable: true })
        find(`[data-testid="${control}"]`)!.dispatchEvent(press)
        expect(press.defaultPrevented, control).toBe(true)
      }
    })
  })

  Scenario('On a phone, the presenter view puts the notes before the next step', ({ Given, Then, And }) => {
    const parts = () => findAll('[data-testid="presenter-page"] section[aria-label]')
    Given('the demo deck "Sorting" is open in the presenter view', async () => {
      hub = new FakePresentHub()
      await deckInBrowser()
      web = await mount(presenterPath())
      await expectShown(1, 0, web.wrapper, '[data-testid="presenter-current"]')
    })
    Then('the page shows the slide on screen, then the notes, then the next step', () => {
      // Narrow screens stack the parts in the order of the page.
      expect(parts().map(part => part.getAttribute('aria-label'))).toEqual(['On screen', 'Speaker notes', 'Next'])
    })
    And('on wide screens the next step and the notes sit beside the slide', () => {
      const [current, notes, upcoming] = parts()
      expect(current.className).toContain('lg:row-span-2')
      expect(upcoming.className).toContain('lg:col-start-2')
      expect(upcoming.className).toContain('lg:row-start-1')
      expect(notes.className).toContain('lg:col-start-2')
      expect(notes.className).toContain('lg:row-start-2')
    })
  })

  Scenario('The presenter and audience windows stay in step, and either can drive', ({ Given, When, Then }) => {
    const presenterShows = (slide: number, clicks: number) => expectShown(slide, clicks, web!.wrapper, '[data-testid="presenter-current"]')
    const audienceShows = (slide: number, clicks: number) => expectShown(slide, clicks, second!.wrapper, '[data-testid="present-page"]')
    Given('the demo deck "Sorting" is open in the presenter view and the audience view, in two windows', async () => {
      hub = new FakePresentHub()
      await deckInBrowser()
      web = await mount(presenterPath())
      await presenterShows(1, 0)
      second = await mount(presentPath())
      await audienceShows(1, 0)
    })
    When('the presenter presses Next in the presenter view', () => web!.click('[data-testid="presenter-next-step"]'))
    Then('both windows show slide 2 at click 0', async () => {
      await presenterShows(2, 0)
      await audienceShows(2, 0)
    })
    When('the presenter taps the right side of the slide in the audience view', async () => {
      // Both pages share one document here, and both would hear a key, so the tap goes to the audience's slide.
      const stage = second!.wrapper.element.querySelector('[data-testid="present-stage"]')!
      stage.dispatchEvent(new PointerEvent('pointerdown', { clientX: 800, clientY: 300, pointerId: 1, button: 0, bubbles: true }))
      stage.dispatchEvent(new PointerEvent('pointerup', { clientX: 800, clientY: 300, pointerId: 1, button: 0, bubbles: true }))
      await flushPromises()
    })
    Then('both windows show slide 2 at click 1', async () => {
      await presenterShows(2, 1)
      await audienceShows(2, 1)
    })
    When('the audience view is opened again', async () => {
      second!.wrapper.unmount()
      second = await mount(presentPath())
    })
    Then('it asks where the talk is and goes to slide 2 at click 1', async () => {
      await audienceShows(2, 1)
      expect(hub!.messages(deckId).filter(message => message.type === 'hello').length).toBeGreaterThanOrEqual(2)
    })
  })

  Scenario('On Android the presenter view has no second window', ({ Given, Then }) => {
    Given('the demo deck "Sorting" is open in the presenter view on a phone with one window', async () => {
      hub = new FakePresentHub()
      hub.canOpenAudience = false
      await deckInBrowser()
      web = await mount(presenterPath())
      await vi.waitFor(() => expect(find('[data-testid="presenter-current"]')).not.toBeNull())
    })
    Then('it offers the audience view in the same window instead of opening a window', async () => {
      expect(find('[data-testid="open-audience"]')).toBeNull()
      expect(find('[data-testid="audience-view"]')).not.toBeNull()
      expect(hub!.opened).toEqual([])
      await web!.click('[data-testid="audience-view"]')
      expect(web!.router.currentRoute.value.name).toBe('present')
    })
  })

  // The channel between the windows ---------------------------------------------------

  function openChannel(name: string, deck: string) {
    const channel = presentChannel<PresentMessage>(deck)
    channels.push(channel)
    heard[name] = []
    channel.listen(message => heard[name].push(message))
    return channel
  }

  async function inApp(platform: string) {
    vi.stubEnv('VITE_APP', '1')
    app.platform = platform
    app.label = 'main'
    app.emitted.length = 0
    app.listeners.length = 0
    app.fullscreen = false
    app.setFullscreen.mockClear()
    app.invoke.mockReset()
    app.invoke.mockImplementation(async (command: string) => command === 'app_info' ? { version: '0.2.0', platform: app.platform, serverUrl: 'https://deyslide.example' } : undefined)
    await startPlatform()
  }

  /** Closes the scenario's channels and leaves the app, if a scenario went into it. */
  async function leaveApp() {
    for (const channel of channels)
      channel.close()
    channels = []
    heard = {}
    vi.unstubAllEnvs()
    await startPlatform()
  }

  Scenario('In the browser, the windows talk over a BroadcastChannel and the audience opens with window.open', ({ Given, When, Then }) => {
    let presenter: PresentChannel<PresentMessage>
    Given('two browser windows present the deck "d1", and one presents the deck "d2"', () => {
      presenter = openChannel('presenter', 'd1')
      openChannel('audience', 'd1')
      openChannel('other deck', 'd2')
    })
    When('a window of the deck "d1" posts where the talk is', () => {
      presenter.post({ type: 'go', slide: 2, slideId: 's-3', clicks: 1 })
    })
    Then('the other window of "d1" hears it, and the window of "d2" does not', async () => {
      await vi.waitFor(() => expect(heard.audience).toEqual([{ type: 'go', slide: 2, slideId: 's-3', clicks: 1 }]))
      expect(heard.presenter).toEqual([])
      expect(heard['other deck']).toEqual([])
    })
    When('the presenter opens the audience window twice', async () => {
      fakeBrowserWindows()
      expect(await presenter.openAudience({ projectId: 'p1', deckId: 'd1', url: '/p/p1/d/d1/present' })).toBe(true)
      expect(windows.get('deyslide-present:d1')!.focus).toHaveBeenCalledTimes(1)
      expect(await presenter.openAudience({ projectId: 'p1', deckId: 'd1', url: '/p/p1/d/d1/present' })).toBe(true)
    })
    Then('the browser opened one window named "deyslide-present:d1", loaded "/p/p1/d/d1/present" in it once, and brought it forward the second time', () => {
      expect([...windows.keys()]).toEqual(['deyslide-present:d1'])
      const audience = windows.get('deyslide-present:d1')!
      expect(audience.location.loads).toEqual(['/p/p1/d/d1/present'])
      expect(audience.focus).toHaveBeenCalledTimes(2)
    })
  })

  Scenario('A presenter view that reloads finds its audience window without loading it again', ({ Given, When, Then }) => {
    let presenter: PresentChannel<PresentMessage>
    let audience: FakeWindow
    Given('the audience window of the deck "d1" shows its talk, opened before the presenter view reloaded', () => {
      fakeBrowserWindows()
      audience = openWindow('deyslide-present:d1', '/p/p1/d/d1/present?slide=2')
      presenter = openChannel('presenter', 'd1')
    })
    When('the presenter opens the audience window', async () => {
      expect(await presenter.openAudience({ projectId: 'p1', deckId: 'd1', url: '/p/p1/d/d1/present' })).toBe(true)
    })
    Then('the browser found that window by its name, did not load it again, and brought it forward', () => {
      expect(openCalls).toEqual([['', 'deyslide-present:d1']])
      expect([...windows.values()]).toEqual([audience])
      expect(audience.location.loads).toEqual([])
      expect(audience.focus).toHaveBeenCalledTimes(1)
    })
  })

  Scenario('An audience window that went to another page shows the talk again', ({ Given, When, Then }) => {
    let presenter: PresentChannel<PresentMessage>
    let audience: FakeWindow
    Given('the audience window of the deck "d1" shows the deck\'s editor', async () => {
      fakeBrowserWindows()
      presenter = openChannel('presenter', 'd1')
      // Opened by this page, which then saw it go to the editor.
      expect(await presenter.openAudience({ projectId: 'p1', deckId: 'd1', url: '/p/p1/d/d1/present' })).toBe(true)
      audience = windows.get('deyslide-present:d1')!
      audience.location.href = '/p/p1/d/d1'
      audience.location.loads.length = 0
    })
    When('the presenter opens the audience window', async () => {
      expect(await presenter.openAudience({ projectId: 'p1', deckId: 'd1', url: '/p/p1/d/d1/present' })).toBe(true)
    })
    Then('the browser loaded "/p/p1/d/d1/present" in that window again', () => {
      expect(audience.location.loads).toEqual(['/p/p1/d/d1/present'])
      expect([...windows.values()]).toEqual([audience])
    })
  })

  Scenario('In the desktop app, the windows talk through the app', ({ Given, When, Then, And }) => {
    let presenter: PresentChannel<PresentMessage>
    Given('the Deyslide app on a computer, in its main window', async () => {
      await inApp('linux')
      presenter = openChannel('presenter', 'd1')
    })
    When('the presenter opens the audience window of the deck "d1" in the project "p1"', async () => {
      expect(presenter.canOpenAudience).toBe(true)
      expect(await presenter.openAudience({ projectId: 'p1', deckId: 'd1', url: '#/p/p1/d/d1/present' })).toBe(true)
    })
    Then('the app got the command "present_open" for that deck', () => {
      expect(app.invoke.mock.calls.filter(([command]) => command === 'present_open').map(call => call.slice(0, 2))).toEqual([['present_open', { projectId: 'p1', deckId: 'd1' }]])
    })
    When('the presenter window posts where the talk is', async () => {
      presenter.post({ type: 'go', slide: 1, clicks: 0 })
      await flushPromises()
    })
    Then('the app sent the event "present-sync" for the deck "d1" from the main window', async () => {
      await vi.waitFor(() => expect(app.emitted).toEqual([{ event: 'present-sync', payload: { deckId: 'd1', message: { type: 'go', slide: 1, clicks: 0 }, from: 'main' } }]))
    })
    And('a "present-sync" from the audience window reaches the page, while its own and other decks\' do not', async () => {
      await vi.waitFor(() => expect(app.listeners.some(listener => listener.event === 'present-sync')).toBe(true))
      const send = (payload: unknown) => app.listeners.filter(listener => listener.event === 'present-sync').forEach(listener => listener.handler({ payload }))
      send({ deckId: 'd1', message: { type: 'go', slide: 3, clicks: 2 }, from: 'present-d1' })
      send({ deckId: 'd1', message: { type: 'go', slide: 4, clicks: 0 }, from: 'main' })
      send({ deckId: 'd2', message: { type: 'go', slide: 0, clicks: 0 }, from: 'present-d2' })
      expect(heard.presenter).toEqual([{ type: 'go', slide: 3, clicks: 2 }])
    })
  })

  Scenario('On Android the presenter has one window', ({ Given, Then }) => {
    Given('the Deyslide app on Android', () => inApp('android'))
    Then('the present channel cannot open an audience window, and asking for one opens nothing', async () => {
      const channel = openChannel('presenter', 'd1')
      expect(channel.canOpenAudience).toBe(false)
      expect(await channel.openAudience({ projectId: 'p1', deckId: 'd1', url: '#/p/p1/d/d1/present' })).toBe(false)
      channel.post({ type: 'hello' })
      expect(app.invoke.mock.calls.map(([command]) => command)).toEqual(['app_info'])
      expect(app.emitted).toEqual([])
    })
  })

  Scenario('Full screen in the desktop app sets the window full screen', ({ Given, When, Then }) => {
    Given('the Deyslide app on a computer, in its main window', () => inApp('linux'))
    When('the page asks for full screen, and then to leave it', async () => {
      await setFullscreen(!(await isFullscreen()))
      expect(await isFullscreen()).toBe(true)
      await setFullscreen(false)
    })
    Then('the app window was set full screen, and then back', async () => {
      expect(app.setFullscreen.mock.calls).toEqual([[true], [false]])
    })
  })
})
