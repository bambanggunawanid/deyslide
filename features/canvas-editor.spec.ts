import type { DeckSession } from '../apps/web/src/deck/session'
import type { Project } from '../apps/web/src/guest/types'
import type { RenderRequest } from '../apps/web/src/preview/protocol'
import type { Position, PositionedElement } from '../packages/deck-model/src'
import type { WebApp } from './support/web'
import { describeFeature, loadFeature } from '@amiceli/vitest-cucumber'
import { expect, vi } from 'vitest'
import * as Y from 'yjs'
import { EditorView } from '../apps/web/node_modules/@codemirror/view/dist/index.js'
import { slideElements } from '../apps/web/src/canvas/elements'
import SlideStage from '../apps/web/src/canvas/SlideStage.vue'
import { publishPresence } from '../apps/web/src/deck/presence'
import { LOCAL_ORIGIN } from '../apps/web/src/deck/session'
import { GuestStore } from '../apps/web/src/guest/store'
import { MemoryGuestStorage } from '../apps/web/src/guest/memory-storage'
import { clearMediaLinks, mediaAddress } from '../apps/web/src/platform/media'
import { LAYOUTS } from '../apps/web/src/preview/layouts'
import { LAST_CLICKS } from '../apps/web/src/preview/protocol'
import { CloudStore } from '../apps/web/src/projects/cloud-store'
import { deckMarkdown, deckToYDoc, deleteSlide, duplicateSlide, fromMarkdown, moveSlide, readDeckDoc, setNotes, updateElement } from '../packages/deck-model/src'
import { FakeAccountService } from './support/account'
import { FakeAssistantApi } from './support/assistant-api'
import { previewPositions, previewRequests, renderPreviews, reportPreviewSizes, resetEditorDoubles } from './support/editor-doubles'
import { FakeIntersectionObserver } from './support/intersection-observer'
import { accountDeck, changeSlide, introduce, openReady } from './support/live-decks'
import { FakeMediaApi } from './support/media-api'
import { FakeProjectApi } from './support/project-api'
import { FakeResizeObserver } from './support/resize-observer'
import { find, findAll, mountWebApp, text } from './support/web'

const feature = await loadFeature('./canvas-editor.feature')

// happy-dom lays nothing out: the stage learns its size from this fake, and
// at 980 by 551.25 pixels one pixel is one canvas unit.
vi.stubGlobal('ResizeObserver', FakeResizeObserver)

/** Decks the scenarios open. Markdown samples stay here because Gherkin reads `#` as a comment. */
const SAMPLES = {
  // A rectangle at 100, 100 of 200 by 100 and a note at 500, 300 of 200 by 100.
  Shapes: [
    '---',
    'theme: default',
    'layout: default',
    '---',
    '',
    '<v-drag pos="100,100,200,100,0" data-id="box">',
    '',
    '<DeyslideShape shape="rect" />',
    '',
    '</v-drag>',
    '',
    '<v-drag pos="500,300,200,100,0" data-id="note">',
    '',
    'Hello',
    '',
    '</v-drag>',
    '',
  ].join('\n'),
  Three: '# Intro\n\n---\n\n# Middle\n\n---\n\n# End\n',
  // Two slides whose boxes share the id "box": ids only have to differ within a slide.
  Twins: [
    '<v-drag pos="100,100,200,100,0" data-id="box">\n\n<DeyslideShape shape="rect" />\n\n</v-drag>',
    '---',
    '<v-drag pos="100,100,200,100,0" data-id="box">\n\n<DeyslideShape shape="ellipse" />\n\n</v-drag>\n',
  ].join('\n\n'),
  // The blank deck's title: auto height.
  Title: '<v-drag pos="80,200,820,NaN,0" data-id="title">\n\n# Graphs\n\n</v-drag>\n',
  // Markdown that flows in the slide, above and below a box, and speaker notes.
  Flow: [
    '---',
    'theme: default',
    '---',
    '',
    '# Sorting',
    '',
    '<v-drag pos="600,300,200,100,0" data-id="box">',
    '',
    '<DeyslideShape shape="rect" />',
    '',
    '</v-drag>',
    '',
    'Bubble sort swaps neighbours.',
    '',
    '<!--',
    'Mention the cost.',
    '-->',
    '',
  ].join('\n'),
  // A backdrop laid over the slide by its class, then a box, then Markdown that flows.
  Backdrop: [
    '---',
    'theme: default',
    '---',
    '',
    '<div class="absolute inset-0 bg-slate-800"></div>',
    '',
    '# Sorting',
    '',
    '<v-drag pos="600,300,200,100,0" data-id="box">',
    '',
    '<DeyslideShape shape="rect" />',
    '',
    '</v-drag>',
    '',
    'Bubble sort swaps neighbours.',
    '',
  ].join('\n'),
  // Two columns: one Markdown block, split by a slot marker.
  Columns: [
    '---',
    'layout: two-cols',
    '---',
    '',
    '# Left',
    '',
    '::right::',
    '',
    '# Right',
    '',
  ].join('\n'),
  Twenty: Array.from({ length: 20 }, (_, index) => `# Slide ${index + 1}\n`).join('\n---\n\n'),
}

type Sample = keyof typeof SAMPLES

/** The middle of each element of the "Shapes" deck. */
const RECTANGLE = { x: 200, y: 150 }
const NOTE = { x: 600, y: 350 }
const EMPTY = { x: 400, y: 450 }
/** A part of the note that a rectangle added in the middle of the slide leaves uncovered. */
const NOTE_EDGE = { x: 650, y: 380 }

interface PointerOptions {
  id?: number
  touch?: boolean
  shift?: boolean
  alt?: boolean
}

describeFeature(feature, ({ Scenario, AfterEachScenario }) => {
  let web: WebApp
  let api: FakeProjectApi
  let assistant: FakeAssistantApi
  let projectId: string
  let deckId: string
  let budi: DeckSession | undefined
  /** The deck open on Ana's phone as well. */
  let anaPhone: DeckSession | undefined
  let anaId: string
  let restoreMatchMedia: (() => void) | undefined
  /** The project's media library, in scenarios that have one, and the images it starts with. */
  let media: FakeMediaApi | undefined
  let images: string[] = []
  let restoreFetch: (() => void) | undefined
  let restoreObserver: (() => void) | undefined

  AfterEachScenario(() => {
    restoreFetch?.()
    restoreFetch = undefined
    restoreObserver?.()
    restoreObserver = undefined
    media = undefined
    images = []
    clearMediaLinks()
    FakeIntersectionObserver.reset()
    budi?.close()
    budi = undefined
    anaPhone?.close()
    anaPhone = undefined
    web?.unmount()
    restoreMatchMedia?.()
    restoreMatchMedia = undefined
    resetEditorDoubles()
    FakeResizeObserver.reset()
  })

  const stageComponent = () => web.wrapper.findComponent(SlideStage)
  const session = () => stageComponent().props('session') as DeckSession
  const slideId = () => stageComponent().props('slideId') as string
  const stage = () => find('[data-testid="slide-stage"]')!
  const elements = (): PositionedElement[] => slideElements(session().doc, slideId())
  const element = (id: string) => elements().find(item => item.id === id)
  const pos = (id: string) => element(id)?.pos
  const box = (id: string) => find(`[data-element="${id}"]`)!
  const selectedIds = () => findAll('[data-testid="element-box"][data-selected]').map(item => item.dataset.element)
  const handles = (id: string) => findAll(`[data-element="${id}"] [data-testid="resize-handle"]`)
  const editor = () => find('[data-testid="inline-editor"]')
  const strip = () => findAll('[data-testid="strip-slide"]').map(item => `${text(`[data-slide-id="${item.dataset.slideId}"] [data-testid="strip-number"]`)} ${text(`[data-slide-id="${item.dataset.slideId}"] [data-testid="strip-title"]`)}`)
  const currentInStrip = () => findAll('[data-testid="strip-slide"]').findIndex(item => item.querySelector('[aria-current="true"]')) + 1

  function pointer(type: string, at: { x: number, y: number }, { id = 1, touch = false, shift = false, alt = false }: PointerOptions = {}, target: Element = stage()) {
    const event = new PointerEvent(type, {
      clientX: at.x,
      clientY: at.y,
      pointerId: id,
      pointerType: touch ? 'touch' : 'mouse',
      isPrimary: id === 1,
      button: 0,
      shiftKey: shift,
      altKey: alt,
      bubbles: true,
      cancelable: true,
    })
    target.dispatchEvent(event)
    return event
  }

  /** Presses at `from` and moves to `to` in a few steps, without letting go. */
  function dragTo(from: { x: number, y: number }, to: { x: number, y: number }, options: PointerOptions = {}, target?: Element) {
    pointer('pointerdown', from, options, target)
    for (let step = 1; step <= 4; step++)
      pointer('pointermove', { x: from.x + (to.x - from.x) * step / 4, y: from.y + (to.y - from.y) * step / 4 }, options)
  }

  async function release(at: { x: number, y: number }, options: PointerOptions = {}) {
    pointer('pointerup', at, options)
    await web.settle()
  }

  async function drag(from: { x: number, y: number }, to: { x: number, y: number }, options: PointerOptions = {}, target?: Element) {
    dragTo(from, to, options, target)
    await release(to, options)
  }

  /** Presses and lets go at one point. Returns the press. */
  async function pressAndRelease(at: { x: number, y: number }, options: PointerOptions = {}) {
    const press = pointer('pointerdown', at, options)
    pointer('pointerup', at, options)
    await web.settle()
    return press
  }

  async function tap(at: { x: number, y: number }, options: PointerOptions = {}) {
    await pressAndRelease(at, options)
  }

  /** Enter on an element, as a browser handles it: a focused button is pressed unless the key was taken. */
  async function pressEnter(target: HTMLElement) {
    const event = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
    target.dispatchEvent(event)
    if (!event.defaultPrevented && target instanceof HTMLButtonElement)
      target.click()
    await web.settle()
  }

  /** The page sees a touch screen: its pointer is coarse. */
  function touchScreen() {
    const original = window.matchMedia
    window.matchMedia = ((query: string) => ({ matches: query.includes('coarse'), media: query, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia
    restoreMatchMedia = () => {
      window.matchMedia = original
    }
  }

  async function key(name: string, { ctrl = false, shift = false } = {}, target: Element = document.activeElement ?? document.body) {
    target.dispatchEvent(new KeyboardEvent('keydown', { key: name, ctrlKey: ctrl, shiftKey: shift, bubbles: true, cancelable: true }))
    await web.settle()
  }

  async function signedIn() {
    const service = new FakeAccountService()
    service.addAccount('ana@example.com', 'correct horse', 'Ana')
    await service.signIn({ email: 'ana@example.com', password: 'correct horse' })
    return service
  }

  async function showDeck() {
    await web.router.push({ name: 'deck', params: { projectId, deckId } })
    await vi.waitFor(() => expect(find('[data-testid="slide-stage"]')).not.toBeNull())
    FakeResizeObserver.resizeAll(980, 551.25)
    await web.settle()
  }

  async function openDeck(name: Sample, { assistantOn = false } = {}) {
    const service = await signedIn()
    anaId = service.signedIn!.id
    api = new FakeProjectApi()
    ;({ projectId, deckId } = await accountDeck(api, SAMPLES[name], name))
    for (const image of images)
      media?.add(projectId, image)
    media?.deckIn(deckId, projectId)
    assistant = new FakeAssistantApi({ on: assistantOn })
    web = await mountWebApp({ service, api, assistant, media })
    await showDeck()
    // Editing starts once the deck has synced.
    await vi.waitFor(() => expect(stage().dataset.locked).toBeUndefined())
  }

  const anaOpens = (Given: (title: string, run: () => Promise<void>) => void) =>
    Given('Ana has the deck "Shapes" open in the Design view', () => openDeck('Shapes'))

  async function select(at: { x: number, y: number }) {
    await tap(at)
  }

  const expectPos = (id: string, expected: Partial<Position>) => expect(pos(id)).toMatchObject(expected)

  /** Lays the strip's items out as a browser would: down the side, or across on a phone. */
  function layStrip(across: boolean) {
    for (const [index, item] of findAll('[data-testid="strip-slide"]').entries()) {
      const [left, top, width, height] = across ? [index * 150, 0, 140, 40] : [0, index * 50, 160, 40]
      item.getBoundingClientRect = () => ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON: () => ({}) }) as DOMRect
    }
  }

  async function stripShows(expected: string[], current: number) {
    await vi.waitFor(() => expect(strip()).toEqual(expected))
    await vi.waitFor(() => expect(currentInStrip()).toBe(current))
  }

  // The inspector -------------------------------------------------------------------

  const field = (name: string) => find(`[data-testid="field-${name}"]`) as HTMLInputElement
  const problemOf = (name: string) => text(`[data-testid="field-${name}-problem"]`)
  const inspectorTitle = () => text('[data-testid="inspector-title"]')
  const slideFrontmatter = () => readDeckDoc(session().doc).slides.find(item => item.id === slideId())!.frontmatter
  const order = () => elements().map(item => item.id)
  const props = (id: string) => (element(id) as Extract<PositionedElement, { props: unknown }>).props as Record<string, unknown>

  /** Types a value into an inspector field and leaves it, as tabbing out would. */
  async function enter(name: string, value: string) {
    const input = await web.waitFor(`[data-testid="field-${name}"]`) as HTMLInputElement
    input.focus()
    input.value = value
    input.dispatchEvent(new Event('input', { bubbles: true }))
    input.dispatchEvent(new Event('change', { bubbles: true }))
    await web.settle()
  }

  async function choose(testId: string, value: string) {
    const select = await web.waitFor(`[data-testid="${testId}"]`) as HTMLSelectElement
    select.value = value
    select.dispatchEvent(new Event('change', { bubbles: true }))
    await web.settle()
  }

  /** The CodeMirror view inside an editor element. */
  const editorView = (selector: string) => EditorView.findFromDOM(find(`${selector} .cm-editor`)!)!

  /** The page sees a screen of this kind. */
  function screenIs({ coarse = false, phone = false, wide = false }) {
    const original = window.matchMedia
    window.matchMedia = ((query: string) => ({
      matches: (query.includes('coarse') && coarse) || (query.includes('max-width: 767px') && phone) || (query.includes('min-width: 1024px') && wide),
      media: query,
      addEventListener() {},
      removeEventListener() {},
    })) as unknown as typeof window.matchMedia
    restoreMatchMedia = () => {
      window.matchMedia = original
    }
  }

  /** Pages ask the fake media library for signed links, through `fetch`. */
  function useMediaLinks(library: FakeMediaApi) {
    const original = globalThis.fetch
    globalThis.fetch = library.fetch as typeof fetch
    restoreFetch = () => {
      globalThis.fetch = original
    }
  }

  /** The strip's slides report whether they are in view through this fake. */
  function watchStrip() {
    const original = window.IntersectionObserver
    window.IntersectionObserver = FakeIntersectionObserver as unknown as typeof IntersectionObserver
    restoreObserver = () => {
      window.IntersectionObserver = original
    }
  }

  /** Opens a deck shared with Ana as a viewer. */
  async function openShared(name: Sample) {
    const service = await signedIn()
    api = new FakeProjectApi()
    const now = Date.now()
    const shared: Project = {
      id: 'shared-project',
      name: 'Algorithms 101',
      createdAt: now,
      updatedAt: now,
      shared: { owner: { name: 'Budi', email: 'budi@example.com' }, role: null },
      decks: [{ id: 'shared-deck', name, slideCount: 1, createdAt: now, updatedAt: now, role: 'viewer' }],
    }
    api.sharedProjects.push(shared)
    api.putDeckState('shared-deck', Y.encodeStateAsUpdate(deckToYDoc(fromMarkdown(SAMPLES[name]))))
    projectId = shared.id
    deckId = 'shared-deck'
    web = await mountWebApp({ service, api })
    await showDeck()
    await vi.waitFor(() => expect(find('[data-testid="view-only"]')).not.toBeNull())
  }

  /** The slide numbers, counted from 1, whose strip item shows a picture. */
  const pictured = () => findAll('[data-testid="strip-slide"]')
    .map((item, index) => item.querySelector('[data-testid="strip-thumbnail"]') ? index + 1 : 0)
    .filter(Boolean)
  const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, index) => from + index)
  /** The preview frames of the strip's pictures, with what each was asked to draw. */
  const pictureRequests = () => web.wrapper.findAllComponents({ name: 'SlidePreviewFrame' })
    .map(frame => frame.props('request') as RenderRequest | undefined)
    .filter((request): request is RenderRequest => request?.mode === 'print')
  /** Reports the strip's slides in view when their number (from 1) passes `inView`. Other watched elements are not reported. */
  function stripInView(inView: (number: number) => boolean) {
    const ids = findAll('[data-testid="strip-slide"]').map(item => item.dataset.slideId)
    FakeIntersectionObserver.report((target) => {
      const id = (target as HTMLElement).dataset?.slideId
      return id === undefined ? undefined : inView(ids.indexOf(id) + 1)
    })
  }
  /** Strip items some observer watches. */
  const watchedStripItems = () => FakeIntersectionObserver.instances.flatMap(observer => [...observer.targets]).filter(target => (target as HTMLElement).dataset?.slideId)

  Scenario('Clicking selects an element, and Shift adds another', ({ Given, When, Then, And }) => {
    anaOpens(Given)
    When('Ana clicks the rectangle', () => select(RECTANGLE))
    Then('the rectangle is selected, with eight resize handles and one for turning', () => {
      expect(selectedIds()).toEqual(['box'])
      expect(handles('box').map(handle => handle.dataset.handle)).toEqual(['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'])
      expect(find('[data-element="box"] [data-testid="rotate-handle"]')).not.toBeNull()
    })
    And('others are told that Ana selected the rectangle', () => {
      expect(session().awareness.getLocalState()?.selection).toEqual(['box'])
    })
    When('Ana clicks the note with Shift held', () => tap(NOTE, { shift: true }))
    Then('the rectangle and the note are both selected, without handles', () => {
      expect(selectedIds()).toEqual(['box', 'note'])
      expect(findAll('[data-testid="resize-handle"]')).toEqual([])
    })
    When('Ana clicks an empty part of the slide', () => tap(EMPTY))
    Then('nothing is selected', () => {
      expect(selectedIds()).toEqual([])
      expect(session().awareness.getLocalState()?.selection).toEqual([])
    })
    And('the strip has one slide, which it cannot delete', () => {
      expect(strip()).toEqual(['1 Hello'])
      expect((find('[data-testid="delete-slide"]') as HTMLButtonElement).disabled).toBe(true)
    })
  })

  Scenario('Shift takes an element back out, a click picks one of several, and Escape clears', ({ Given, When, And, Then }) => {
    anaOpens(Given)
    When('Ana clicks the rectangle, then the note with Shift held', async () => {
      await select(RECTANGLE)
      await tap(NOTE, { shift: true })
      expect(selectedIds()).toEqual(['box', 'note'])
    })
    And('Ana clicks the note again with Shift held', () => tap(NOTE, { shift: true }))
    Then('only the rectangle is selected', () => {
      expect(selectedIds()).toEqual(['box'])
    })
    When('Ana adds the note with Shift once more, then clicks it alone', async () => {
      await tap(NOTE, { shift: true })
      expect(selectedIds()).toEqual(['box', 'note'])
      await tap(NOTE)
    })
    Then('only the note is selected', () => {
      expect(selectedIds()).toEqual(['note'])
      expect(editor()).toBeNull()
    })
    When('Ana presses Escape on the slide', () => key('Escape'))
    Then('nothing is selected', () => {
      expect(selectedIds()).toEqual([])
    })
  })

  Scenario('Dragging moves an element without compiling the slide again', ({ Given, When, Then, And }) => {
    let rendersBefore: number
    anaOpens(Given)
    When('Ana drags the rectangle 47 right and 31 down, and holds it there', async () => {
      rendersBefore = previewRequests.length
      dragTo(RECTANGLE, { x: 247, y: 181 })
      await web.settle()
    })
    Then('the rectangle\'s box is at 147, 131 and the preview got that position', () => {
      expect(box('box').style.left).toBe('147px')
      expect(box('box').style.top).toBe('131px')
      expect(previewPositions.at(-1)).toEqual({ box: { x: 147, y: 131, w: 200, h: 100, rotate: 0 } })
    })
    And('the preview was not asked to render the slide again during the drag', async () => {
      // Long enough for the page to read the deck again after the drag's writes.
      await new Promise(resolve => setTimeout(resolve, 250))
      await web.settle()
      expect(previewRequests.length).toBe(rendersBefore)
    })
    When('Ana lets go', () => release({ x: 247, y: 181 }))
    Then('the deck has the rectangle at 147, 131', () => {
      expectPos('box', { x: 147, y: 131, w: 200, h: 100 })
    })
    And('the preview renders the slide with the rectangle at 147, 131, keeping it there meanwhile', async () => {
      await vi.waitFor(() => expect(previewRequests.at(-1)!.slide.content).toContain('<v-drag pos="147,131,200,100,0" data-id="box">'))
      // Taking the positions away now would show the older render until the new one is ready.
      expect(previewPositions.at(-1)).toEqual({ box: { x: 147, y: 131, w: 200, h: 100, rotate: 0 } })
    })
    When('the preview shows that render', async () => {
      renderPreviews()
      await web.settle()
    })
    Then('the preview no longer needs the drag\'s positions', () => {
      expect(previewPositions.at(-1)).toEqual({})
    })
  })

  Scenario('A drag writes the deck at most every 50 ms, and the pointer reaches others as often', ({ Given, When, Then, And }) => {
    const written: Position[] = []
    const heard: unknown[] = []
    const record = (_update: Uint8Array, origin: unknown) => {
      if (origin === LOCAL_ORIGIN)
        written.push({ ...pos('box')! })
    }
    anaOpens(Given)
    When('Ana drags the rectangle through ten points at once, and holds it', () => {
      session().doc.on('update', record)
      pointer('pointerdown', RECTANGLE)
      for (let step = 1; step <= 10; step++)
        pointer('pointermove', { x: 200 + step * 10, y: 150 })
    })
    Then('the deck changed once, with the first point', () => {
      expect(written).toEqual([expect.objectContaining({ x: 110, y: 100 })])
    })
    And('within 50 ms it changed once more, with the last point', async () => {
      await vi.waitFor(() => expect(written).toHaveLength(2), { timeout: 200, interval: 5 })
      expect(written[1]).toMatchObject({ x: 200, y: 100 })
      session().doc.off('update', record)
    })
    When('Ana lets go, then moves the pointer through ten points on the slide at once', async () => {
      await release({ x: 300, y: 150 })
      // Past the last share of the drag's pointer.
      await new Promise(resolve => setTimeout(resolve, 60))
      const awareness = session().awareness
      awareness.on('change', ({ updated }: { updated: number[] }) => {
        if (updated.includes(awareness.clientID))
          heard.push(awareness.getLocalState()?.pointer)
      })
      for (let step = 1; step <= 10; step++)
        pointer('pointermove', { x: 400 + step * 10, y: 250 })
    })
    Then('others heard of the first point at once, and of the last within 50 ms, and of nothing between', async () => {
      expect(heard).toEqual([{ x: 410, y: 250 }])
      await vi.waitFor(() => expect(heard).toHaveLength(2), { timeout: 200, interval: 5 })
      expect(heard).toEqual([{ x: 410, y: 250 }, { x: 500, y: 250 }])
    })
  })

  Scenario('A gesture writes only the elements it moves', ({ Given, When, And, Then }) => {
    const someoneMoves = (x: number, y: number) => updateElement(session().doc, slideId(), 'box', { pos: { x, y } }, 'someone else')
    anaOpens(Given)
    When('Ana drags the rectangle 50 right, pauses and lets go', async () => {
      dragTo(RECTANGLE, { x: 250, y: 150 })
      // Long enough for the drag's writes to reach the deck and the page.
      await new Promise(resolve => setTimeout(resolve, 200))
      await web.settle()
      await release({ x: 250, y: 150 })
      expectPos('box', { x: 150, y: 100 })
    })
    And('Ana selects the note and holds its right handle still, while someone else puts the rectangle at 10, 10', async () => {
      await select(NOTE)
      // Past a double tap.
      await new Promise(resolve => setTimeout(resolve, 450))
      pointer('pointerdown', { x: 700, y: 350 }, {}, find('[data-element="note"] [data-handle="e"]')!)
      someoneMoves(10, 10)
      await web.settle()
    })
    And('Ana lets go of the handle', () => release({ x: 700, y: 350 }))
    Then('the deck has the rectangle at 10, 10 and the note where it was', () => {
      expectPos('box', { x: 10, y: 10 })
      expectPos('note', { x: 500, y: 300, w: 200, h: 100 })
      expect(editor()).toBeNull()
    })
    When('Ana drags the note 30 down, and meanwhile someone else puts the rectangle at 40, 40', async () => {
      dragTo(NOTE, { x: 600, y: 380 })
      someoneMoves(40, 40)
      await web.settle()
    })
    And('Ana lets go of the note', () => release({ x: 600, y: 380 }))
    Then('the deck has the rectangle at 40, 40 and the note at 500, 330', () => {
      expectPos('box', { x: 40, y: 40 })
      expectPos('note', { x: 500, y: 330 })
    })
  })

  Scenario('Elements moved together each keep part of themselves on the slide', ({ Given, When, Then }) => {
    anaOpens(Given)
    When('Ana selects the rectangle and the note and drags them 600 left with Alt held', async () => {
      await select(RECTANGLE)
      await tap(NOTE, { shift: true })
      await drag(RECTANGLE, { x: -400, y: 150 }, { alt: true })
    })
    Then('the deck has the rectangle 20 units on the slide, at -180, 100, and the note at 220, 300', () => {
      expectPos('box', { x: -180, y: 100 })
      expectPos('note', { x: 220, y: 300 })
    })
  })

  Scenario('A drag on a slide someone deletes leaves the next slide alone', ({ Given, And, When, Then }) => {
    let first: string
    let second: string
    Given('Ana has the deck "Twins" open in the Design view, whose two slides each have a box called "box" at 100, 100', () => openDeck('Twins'))
    And('Budi has the same deck open in another browser', async () => {
      budi = await openReady(await CloudStore.open(api), projectId, deckId)
    })
    When('Ana drags the box on slide 1 300 right and holds it there', async () => {
      ;[first, second] = readDeckDoc(session().doc).slides.map(slide => slide.id)
      expect(slideId()).toBe(first)
      dragTo(RECTANGLE, { x: 500, y: 150 })
      await web.settle()
      expect(box('box').style.left).toBe('400px')
    })
    And('Budi deletes slide 1', () => {
      budi!.transact(() => deleteSlide(budi!.doc, first, LOCAL_ORIGIN))
    })
    Then('Ana\'s page shows the other slide, "Slide 1 of 1"', async () => {
      await vi.waitFor(() => expect(text('[data-testid="slide-position"]')).toBe('Slide 1 of 1'))
      expect(slideId()).toBe(second)
    })
    When('Ana lets go', () => release({ x: 500, y: 150 }))
    Then('the box on that slide is still at 100, 100', () => {
      expectPos('box', { x: 100, y: 100 })
      expect(slideElements(budi!.doc, second)[0].pos).toMatchObject({ x: 100, y: 100 })
    })
  })

  Scenario('A drag snaps to the slide\'s center and shows a guide, unless Alt is held', ({ Given, When, Then }) => {
    anaOpens(Given)
    When('Ana drags the rectangle until its middle is 3 right of the slide\'s center line, and holds it there', async () => {
      dragTo(RECTANGLE, { x: 493, y: 150 })
      await web.settle()
    })
    Then('a guide shows on that line, with the rectangle\'s middle on it', () => {
      const guide = find('[data-testid="snap-guide"]')
      expect(guide?.dataset).toMatchObject({ axis: 'x', at: '490' })
      expect(box('box').style.left).toBe('390px')
    })
    When('Ana lets go', () => release({ x: 493, y: 150 }))
    Then('the deck has the rectangle centered across the slide, and the guide is gone', () => {
      expectPos('box', { x: 390, y: 100 })
      expect(find('[data-testid="snap-guide"]')).toBeNull()
    })
    When('Ana drags the rectangle 3 right with Alt held', async () => {
      // Out past the distance a press may wander before it drags, and back.
      dragTo({ x: 490, y: 150 }, { x: 500, y: 150 }, { alt: true })
      pointer('pointermove', { x: 493, y: 150 }, { alt: true })
      await release({ x: 493, y: 150 }, { alt: true })
    })
    Then('the deck has the rectangle 3 right of the center', () => {
      expectPos('box', { x: 393, y: 100 })
    })
  })

  Scenario('Resizing from a corner, with and without keeping the ratio', ({ Given, When, Then }) => {
    anaOpens(Given)
    When('Ana selects the rectangle and drags its bottom right handle 100 right and 20 down', async () => {
      await select(RECTANGLE)
      await drag({ x: 300, y: 200 }, { x: 400, y: 220 }, {}, find('[data-element="box"] [data-handle="se"]')!)
    })
    Then('the deck has the rectangle at 100, 100, 300 by 120', () => {
      expectPos('box', { x: 100, y: 100, w: 300, h: 120, rotate: 0 })
    })
    When('Ana drags the bottom right handle 60 right with Shift held', () =>
      drag({ x: 400, y: 220 }, { x: 460, y: 220 }, { shift: true }, find('[data-element="box"] [data-handle="se"]')!))
    Then('the deck has the rectangle at 100, 100, 360 by 144', () => {
      expectPos('box', { x: 100, y: 100, w: 360, h: 144, rotate: 0 })
    })
  })

  Scenario('Resizing snaps the edge a handle pulls to the slide\'s center, unless Alt is held', ({ Given, When, Then }) => {
    anaOpens(Given)
    When('Ana selects the rectangle and drags its right handle until its right edge is 3 left of the slide\'s center line, and holds it there', async () => {
      await select(RECTANGLE)
      dragTo({ x: 300, y: 150 }, { x: 487, y: 150 }, {}, find('[data-element="box"] [data-handle="e"]')!)
      await web.settle()
    })
    Then('a guide shows on that line, with the rectangle\'s right edge on it', () => {
      const guide = find('[data-testid="snap-guide"]')
      expect(guide?.dataset).toMatchObject({ axis: 'x', at: '490' })
      expect(box('box').style.left).toBe('100px')
      expect(box('box').style.width).toBe('390px')
    })
    When('Ana lets go of the handle', () => release({ x: 487, y: 150 }))
    Then('the deck has the rectangle at 100, 100, 390 by 100, and the guide is gone', () => {
      expectPos('box', { x: 100, y: 100, w: 390, h: 100, rotate: 0 })
      expect(find('[data-testid="snap-guide"]')).toBeNull()
    })
    When('Ana drags the right handle 3 right with Alt held', async () => {
      // Out past the distance a press may wander before it drags, and back.
      dragTo({ x: 490, y: 150 }, { x: 500, y: 150 }, { alt: true }, find('[data-element="box"] [data-handle="e"]')!)
      pointer('pointermove', { x: 493, y: 150 }, { alt: true })
      await release({ x: 493, y: 150 }, { alt: true })
    })
    Then('the deck has the rectangle 393 wide', () => {
      expectPos('box', { x: 100, y: 100, w: 393, h: 100, rotate: 0 })
    })
  })

  Scenario('A text box with auto height keeps it while its right edge snaps', ({ Given, When, And, Then }) => {
    let added: PositionedElement
    anaOpens(Given)
    When('Ana adds a text box from the toolbar', () => web.click('[data-testid="add-text"]'))
    And('Ana drags its bottom right handle until its right edge is 3 right of the note\'s right edge, near the note\'s top', async () => {
      added = elements().at(-1)!
      // The new box spans 250 to 730 across, and its first guessed height ends at 304,
      // 4 below the note's top: that edge would snap, but the drag does not change the height.
      const corner = { x: 250 + 480, y: 248 + 56 }
      await drag(corner, { x: 703, y: corner.y }, {}, find(`[data-element="${added.id}"] [data-handle="se"]`)!)
    })
    Then('the text box ends at the note\'s right edge and still has an auto height', () => {
      expect(pos(added.id)).toEqual({ x: 250, y: 248, w: 450, h: null, rotate: 0 })
    })
  })

  Scenario('Pressing a handle without moving it changes nothing', ({ Given, When, And, Then }) => {
    let added: PositionedElement
    let steps: number
    anaOpens(Given)
    When('Ana adds a text box from the toolbar', () => web.click('[data-testid="add-text"]'))
    And('Ana presses its bottom right handle and lets go, after the pointer wandered a pixel', async () => {
      added = elements().at(-1)!
      steps = session().undo.undoStack.length
      const corner = { x: 250 + 480, y: 248 + 56 }
      pointer('pointerdown', corner, {}, find(`[data-element="${added.id}"] [data-handle="se"]`)!)
      pointer('pointermove', { x: corner.x + 1, y: corner.y })
      await release({ x: corner.x + 1, y: corner.y })
    })
    Then('the text box still has an auto height, and there is nothing new to undo', () => {
      expect(pos(added.id)).toEqual({ x: 250, y: 248, w: 480, h: null, rotate: 0 })
      expect(session().undo.undoStack).toHaveLength(steps)
    })
  })

  Scenario('Turning with Shift snaps to 15 degrees', ({ Given, When, Then, And }) => {
    anaOpens(Given)
    When('Ana selects the rectangle and turns its rotate handle 40 degrees with Shift held', async () => {
      await select(RECTANGLE)
      // The handle sits 24 pixels above the middle of the top edge.
      const radians = 40 * Math.PI / 180
      const to = { x: 200 + 74 * Math.sin(radians), y: 150 - 74 * Math.cos(radians) }
      await drag({ x: 200, y: 76 }, to, { shift: true }, find('[data-element="box"] [data-testid="rotate-handle"]')!)
    })
    Then('the deck has the rectangle turned 45 degrees', () => {
      expectPos('box', { x: 100, y: 100, w: 200, h: 100, rotate: 45 })
    })
    And('the rectangle\'s box is drawn turned 45 degrees', () => {
      expect(box('box').style.transform).toBe('rotate(45deg)')
    })
  })

  Scenario('An element at the top of the slide can still be turned', ({ Given, When, Then }) => {
    const rotateHandle = () => find('[data-element="box"] [data-testid="rotate-handle"]')!
    anaOpens(Given)
    When('Ana selects the rectangle and moves it up to the top of the slide', async () => {
      await select(RECTANGLE)
      for (let press = 0; press < 10; press++)
        await key('ArrowUp', { shift: true })
      expectPos('box', { x: 100, y: 0 })
    })
    Then('its rotate handle sits below it, inside the stage', () => {
      expect(rotateHandle().dataset.place).toBe('below')
      // Centered 24 pixels below the bottom edge of the 100 high box.
      expect(rotateHandle().style.top).toBe(`${100 + 24 - 5}px`)
    })
    When('Ana turns that handle 40 degrees with Shift held', async () => {
      // From straight below the middle, 74 pixels away, a turn of 40 degrees.
      const radians = (180 + 40) * Math.PI / 180
      const to = { x: 200 + 74 * Math.sin(radians), y: 50 - 74 * Math.cos(radians) }
      await drag({ x: 200, y: 124 }, to, { shift: true }, rotateHandle())
    })
    Then('the deck has the rectangle at 100, 0, turned 45 degrees', () => {
      expectPos('box', { x: 100, y: 0, w: 200, h: 100, rotate: 45 })
    })
  })

  Scenario('Arrow keys nudge the selection', ({ Given, When, Then }) => {
    anaOpens(Given)
    When('Ana selects the rectangle and presses the right arrow', async () => {
      await select(RECTANGLE)
      await key('ArrowRight')
    })
    Then('the deck has the rectangle at 101, 100', () => {
      expectPos('box', { x: 101, y: 100 })
    })
    When('Ana presses the down arrow with Shift held', () => key('ArrowDown', { shift: true }))
    Then('the deck has the rectangle at 101, 110', () => {
      expectPos('box', { x: 101, y: 110 })
    })
  })

  Scenario('Control D copies and Delete removes', ({ Given, When, Then }) => {
    let copy: PositionedElement
    anaOpens(Given)
    When('Ana selects the note and presses Control D', async () => {
      await select(NOTE)
      await key('d', { ctrl: true })
    })
    Then('the slide has a copy of the note at 520, 320, and only the copy is selected', () => {
      expect(elements()).toHaveLength(3)
      copy = elements().find(item => item.id !== 'box' && item.id !== 'note')!
      expect(copy).toMatchObject({ type: 'text', markdown: 'Hello', pos: { x: 520, y: 320, w: 200, h: 100 } })
      expect(selectedIds()).toEqual([copy.id])
    })
    When('Ana presses Delete', () => key('Delete'))
    Then('the copy is gone and nothing is selected', () => {
      expect(elements().map(item => item.id)).toEqual(['box', 'note'])
      expect(selectedIds()).toEqual([])
    })
    When('Ana selects the rectangle and presses Backspace', async () => {
      await select(RECTANGLE)
      await key('Backspace')
    })
    Then('the slide has only the note', () => {
      expect(elements().map(item => item.id)).toEqual(['note'])
    })
  })

  Scenario('Keys belong to an open dialog, not to the canvas behind it', ({ Given, And, When, Then }) => {
    let escape: KeyboardEvent
    anaOpens(Given)
    And('Ana has the rectangle selected and the share dialog open, with focus back on the page', async () => {
      await select(RECTANGLE)
      expect(selectedIds()).toEqual(['box'])
      await web.click('[data-testid="share-deck"]')
      await vi.waitFor(() => expect(find('[data-testid="share-dialog"]')).not.toBeNull())
      ;(document.activeElement as HTMLElement | null)?.blur()
      expect(document.activeElement).toBe(document.body)
    })
    When('Ana presses Delete, an arrow key and Control Z', async () => {
      await key('Delete')
      await key('ArrowRight')
      await key('z', { ctrl: true })
    })
    Then('the rectangle is still there, where it was, and still selected', () => {
      expect(elements().map(item => item.id)).toEqual(['box', 'note'])
      expectPos('box', { x: 100, y: 100 })
      expect(selectedIds()).toEqual(['box'])
    })
    When('Ana presses Escape', async () => {
      escape = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
      window.dispatchEvent(escape)
      await web.settle()
    })
    Then('the canvas leaves Escape to the dialog and keeps the rectangle selected', () => {
      expect(escape.defaultPrevented).toBe(false)
      expect(selectedIds()).toEqual(['box'])
    })
  })

  Scenario('A drag with a pause is one undo step', ({ Given, When, Then }) => {
    anaOpens(Given)
    When('Ana drags the rectangle 40 right, waits longer than half a second, then drags it 40 down and lets go', async () => {
      dragTo(RECTANGLE, { x: 240, y: 150 })
      await new Promise(resolve => setTimeout(resolve, 600))
      pointer('pointermove', { x: 240, y: 190 })
      await release({ x: 240, y: 190 })
    })
    Then('the deck has the rectangle at 140, 140', () => {
      expectPos('box', { x: 140, y: 140 })
    })
    When('Ana presses Control Z', () => key('z', { ctrl: true }))
    Then('the deck has the rectangle at 100, 100', () => {
      expectPos('box', { x: 100, y: 100 })
    })
    When('Ana presses Control Shift Z', () => key('Z', { ctrl: true, shift: true }))
    Then('the deck has the rectangle at 140, 140 again', () => {
      expectPos('box', { x: 140, y: 140 })
    })
    When('Ana presses Control Z, then Control Y', async () => {
      await key('z', { ctrl: true })
      expectPos('box', { x: 100, y: 100 })
      await key('y', { ctrl: true })
    })
    Then('the deck has the rectangle back at 140, 140', () => {
      expectPos('box', { x: 140, y: 140 })
    })
  })

  Scenario('Adding a text box and editing it in place', ({ Given, When, Then }) => {
    let added: PositionedElement
    let view: EditorView
    const typed = () => element(added.id) as Extract<PositionedElement, { type: 'text' }>
    anaOpens(Given)
    When('Ana adds a text box from the toolbar', () => web.click('[data-testid="add-text"]'))
    Then('the slide has a text box saying "New text" in its middle, selected', () => {
      added = elements().at(-1)!
      expect(added).toMatchObject({ type: 'text', markdown: 'New text', pos: { x: 250, y: 248, w: 480, h: null, rotate: 0 } })
      expect(selectedIds()).toEqual([added.id])
    })
    When('Ana double clicks the text box', async () => {
      await tap({ x: 490, y: 276 })
      await tap({ x: 490, y: 276 })
    })
    Then('an editor opens over the text box, as wide as it', () => {
      expect(editor()).not.toBeNull()
      expect(editor()!.parentElement!.style.left).toBe('250px')
      expect(editor()!.parentElement!.style.width).toBe('480px')
      view = EditorView.findFromDOM(editor()!.querySelector('.cm-editor') as HTMLElement)!
      expect(view.state.doc.toString()).toBe('New text')
    })
    When('Ana types " here" at the end', async () => {
      view.dispatch({ changes: { from: view.state.doc.length, insert: ' here' } })
      await web.settle()
    })
    Then('the deck\'s text box says "New text here"', () => {
      expect(typed().markdown).toBe('New text here')
    })
    When('Ana presses Control Z in the editor', () => key('z', { ctrl: true }, view.contentDOM))
    Then('the deck\'s text box says "New text" again, through the deck\'s undo', () => {
      expect(typed().markdown).toBe('New text')
      expect(view.state.doc.toString()).toBe('New text')
      expect(session().undo.redoStack).toHaveLength(1)
    })
    When('Ana presses Escape in the editor', () => key('Escape', {}, view.contentDOM))
    Then('the editor closes and the text box stays selected', () => {
      expect(editor()).toBeNull()
      expect(selectedIds()).toEqual([added.id])
    })
  })

  Scenario('A double tap edits text, and a press outside closes the editor', ({ Given, When, Then, And }) => {
    let presses: PointerEvent[]
    anaOpens(Given)
    When('Ana double taps the note', async () => {
      presses = [await pressAndRelease(NOTE, { touch: true }), await pressAndRelease(NOTE, { touch: true })]
    })
    Then('an editor opens over the note', () => {
      expect(editor()).not.toBeNull()
      expect(editor()!.parentElement!.style.left).toBe('500px')
      expect(editor()!.textContent).toContain('Hello')
    })
    And('no mouse presses follow the taps, so none can select a word in the editor', () => {
      // A press whose default is prevented sends no mouse events after it.
      expect(presses.map(press => press.defaultPrevented)).toEqual([true, true])
    })
    When('Ana taps the rectangle', () => tap(RECTANGLE, { touch: true }))
    Then('the editor closes and the rectangle is selected', () => {
      expect(editor()).toBeNull()
      expect(selectedIds()).toEqual(['box'])
    })
  })

  Scenario('Adding a 3D scene', ({ Given, When, Then, And }) => {
    let added: PositionedElement
    anaOpens(Given)
    When('Ana adds a 3D scene from the toolbar', () => web.click('[data-testid="add-scene3d"]'))
    Then('the slide has a 3D scene of 480 by 300 in its middle, selected', () => {
      added = elements().at(-1)!
      expect(added).toMatchObject({ type: 'scene3d', pos: { x: 250, y: 126, w: 480, h: 300, rotate: 0 } })
      expect(selectedIds()).toEqual([added.id])
    })
    And('the deck\'s Markdown places a DeyslideScene3D component there', () => {
      expect(deckMarkdown(session().doc)).toContain(`<v-drag pos="250,126,480,300,0" data-id="${added.id}">\n\n<DeyslideScene3D />\n\n</v-drag>`)
    })
    And('the inspector shows the 3D scene\'s camera, focus and zoom settings', () => {
      expect(text('[data-testid="inspector-title"]')).toBe('3D scene')
      expect(field('camera-position').placeholder).toBe('7, 5, 9')
      expect(field('focus')).not.toBeNull()
      expect(field('zoom-level')).not.toBeNull()
    })
  })

  Scenario('Adding an image by its link', ({ Given, When, Then }) => {
    anaOpens(Given)
    When('Ana asks for an image and enters "not a link"', async () => {
      await web.click('[data-testid="add-image"]')
      await web.fill('[data-testid="image-url"]', 'not a link')
      await web.submit('[data-testid="image-form"]')
    })
    Then('the toolbar says "Enter a link that starts with https://, http:// or /."', () => {
      expect(text('[data-testid="image-problem"]')).toBe('Enter a link that starts with https://, http:// or /.')
      expect(elements()).toHaveLength(2)
    })
    When('Ana enters "https://example.com/cat.png"', async () => {
      await web.fill('[data-testid="image-url"]', 'https://example.com/cat.png')
      await web.submit('[data-testid="image-form"]')
    })
    Then('the slide has an image of "https://example.com/cat.png" in its middle, selected', () => {
      const added = elements().at(-1)!
      expect(added).toMatchObject({ type: 'image', src: 'https://example.com/cat.png', pos: { x: 290, y: 163, w: 400, h: 225 } })
      expect(selectedIds()).toEqual([added.id])
      expect(find('[data-testid="image-form"]')).toBeNull()
    })
    When('Ana asks for an image again and presses Escape in the link field', async () => {
      await web.click('[data-testid="add-image"]')
      await key('Escape', {}, find('[data-testid="image-url"]')!)
    })
    Then('the link field closes, and the Image button has the focus', () => {
      expect(find('[data-testid="image-form"]')).toBeNull()
      expect(document.activeElement).toBe(find('[data-testid="add-image"]'))
    })
  })

  Scenario('Shortcuts do not fire inside a text field', ({ Given, When, Then }) => {
    anaOpens(Given)
    When('Ana selects the rectangle, opens the image link field and presses Backspace, Delete, an arrow, Control D and Control Z there', async () => {
      await select(RECTANGLE)
      await web.click('[data-testid="add-image"]')
      const field = find('[data-testid="image-url"]')!
      expect(document.activeElement).toBe(field)
      for (const [name, options] of [['Backspace', {}], ['Delete', {}], ['ArrowRight', {}], ['d', { ctrl: true }], ['z', { ctrl: true }]] as const)
        await key(name, options, field)
    })
    Then('the deck still has the rectangle at 100, 100, and the note', () => {
      expect(elements().map(item => item.id)).toEqual(['box', 'note'])
      expectPos('box', { x: 100, y: 100 })
      expect(selectedIds()).toEqual(['box'])
    })
  })

  Scenario('Enter presses a focused button while an element is selected, and edits text from the slide', ({ Given, When, Then }) => {
    anaOpens(Given)
    When('Ana selects the note, focuses the Rectangle button and presses Enter twice', async () => {
      await select(NOTE)
      const button = find('[data-testid="add-rect"]')!
      button.focus()
      await pressEnter(button)
      await pressEnter(button)
    })
    Then('the slide has two new rectangles and no editor opened', () => {
      expect(elements().filter(item => item.type === 'shape')).toHaveLength(3)
      expect(editor()).toBeNull()
    })
    When('Ana selects the note and presses Enter on the slide', async () => {
      await select(NOTE_EDGE)
      expect(selectedIds()).toEqual(['note'])
      await pressEnter(stage())
    })
    Then('an editor opens over the note', () => {
      expect(editor()).not.toBeNull()
      expect(editor()!.parentElement!.style.left).toBe('500px')
    })
  })

  Scenario('Slides are added, copied and deleted in the strip', ({ Given, When, Then }) => {
    Given('Ana has the deck "Three" open in the Design view', () => openDeck('Three'))
    Then('the strip shows "1 Intro", "2 Middle" and "3 End", with slide 1 current', () => stripShows(['1 Intro', '2 Middle', '3 End'], 1))
    When('Ana adds a slide', () => web.click('[data-testid="add-slide"]'))
    Then('the strip shows "1 Intro", "2 Empty slide", "3 Middle" and "4 End", with slide 2 current', async () => {
      await stripShows(['1 Intro', '2 Empty slide', '3 Middle', '4 End'], 2)
      expect(text('[data-testid="slide-position"]')).toBe('Slide 2 of 4')
    })
    When('Ana goes to slide 3 and copies it', async () => {
      await web.click('[data-testid="strip-slide"]:nth-child(3) button')
      expect(text('[data-testid="slide-position"]')).toBe('Slide 3 of 4')
      await web.click('[data-testid="duplicate-slide"]')
    })
    Then('the strip shows "1 Intro", "2 Empty slide", "3 Middle", "4 Middle" and "5 End", with slide 4 current', () =>
      stripShows(['1 Intro', '2 Empty slide', '3 Middle', '4 Middle', '5 End'], 4))
    When('Ana deletes the current slide', () => web.click('[data-testid="delete-slide"]'))
    Then('the strip shows "1 Intro", "2 Empty slide", "3 Middle" and "4 End", with slide 4 current', () =>
      stripShows(['1 Intro', '2 Empty slide', '3 Middle', '4 End'], 4))
  })

  Scenario('Dragging a slide in the strip reorders the deck', ({ Given, When, Then, And }) => {
    Given('Ana has the deck "Three" open in the Design view', () => openDeck('Three'))
    When('Ana drags slide 1 below slide 3 in the strip', async () => {
      layStrip(false)
      const first = findAll('[data-testid="strip-slide"]')[0]
      pointer('pointerdown', { x: 80, y: 20 }, {}, first)
      pointer('pointermove', { x: 80, y: 30 }, {}, first)
      pointer('pointermove', { x: 80, y: 140 }, {}, first)
      await web.settle()
      expect(find('[data-testid="strip-drop"]')).not.toBeNull()
      pointer('pointerup', { x: 80, y: 140 }, {}, first)
      await web.settle()
    })
    Then('the strip shows "1 Middle", "2 End" and "3 Intro", with slide 3 current', () => stripShows(['1 Middle', '2 End', '3 Intro'], 3))
    And('the page still shows the slide "Intro", now "Slide 3 of 3"', () => {
      expect(text('[data-testid="slide-position"]')).toBe('Slide 3 of 3')
      expect(previewRequests.at(-1)!.slide.content).toContain('# Intro')
      expect(readDeckDoc(session().doc).slides.map(slide => slide.id)[2]).toBe(slideId())
    })
  })

  Scenario('A long press on a slide reorders it on touch, and a swipe does not', ({ Given, When, Then }) => {
    Given('Ana has the deck "Three" open in the Design view on a phone', async () => {
      await openDeck('Three')
      layStrip(true)
    })
    When('Ana swipes across slide 1 with a finger', async () => {
      const first = findAll('[data-testid="strip-slide"]')[0]
      pointer('pointerdown', { x: 70, y: 20 }, { touch: true }, first)
      pointer('pointermove', { x: 220, y: 20 }, { touch: true }, first)
      await new Promise(resolve => setTimeout(resolve, 500))
      pointer('pointermove', { x: 370, y: 20 }, { touch: true }, first)
      pointer('pointerup', { x: 370, y: 20 }, { touch: true }, first)
      await web.settle()
    })
    Then('the strip shows "1 Intro", "2 Middle" and "3 End", with slide 1 current', async () => {
      await new Promise(resolve => setTimeout(resolve, 150))
      await stripShows(['1 Intro', '2 Middle', '3 End'], 1)
    })
    When('Ana rests a finger on slide 3 for half a second and drags it before slide 1', async () => {
      const third = findAll('[data-testid="strip-slide"]')[2]
      pointer('pointerdown', { x: 370, y: 20 }, { touch: true }, third)
      await new Promise(resolve => setTimeout(resolve, 500))
      pointer('pointermove', { x: 200, y: 20 }, { touch: true }, third)
      pointer('pointermove', { x: 30, y: 20 }, { touch: true }, third)
      pointer('pointerup', { x: 30, y: 20 }, { touch: true }, third)
      await web.settle()
    })
    Then('the strip shows "1 End", "2 Intro" and "3 Middle", with slide 2 current', () => stripShows(['1 End', '2 Intro', '3 Middle'], 2))
  })

  Scenario('A view only deck shows no handles and no toolbar', ({ Given, When, Then, And }) => {
    Given('Budi shared the deck "Shapes" with Ana as a viewer, and Ana opened it in the Design view', async () => {
      const service = await signedIn()
      api = new FakeProjectApi()
      const now = Date.now()
      const shared: Project = {
        id: 'shared-project',
        name: 'Algorithms 101',
        createdAt: now,
        updatedAt: now,
        shared: { owner: { name: 'Budi', email: 'budi@example.com' }, role: null },
        decks: [{ id: 'shared-deck', name: 'Shapes', slideCount: 1, createdAt: now, updatedAt: now, role: 'viewer' }],
      }
      api.sharedProjects.push(shared)
      api.putDeckState('shared-deck', Y.encodeStateAsUpdate(deckToYDoc(fromMarkdown(SAMPLES.Shapes))))
      projectId = shared.id
      deckId = 'shared-deck'
      web = await mountWebApp({ service, api })
      await showDeck()
      await vi.waitFor(() => expect(elements()).toHaveLength(2))
      expect(find('[data-testid="view-only"]')).not.toBeNull()
    })
    When('Ana clicks the rectangle and drags it 50 right', async () => {
      await select(RECTANGLE)
      await drag(RECTANGLE, { x: 250, y: 150 })
    })
    Then('the rectangle is selected but shows no handles, and the deck did not change', () => {
      expect(selectedIds()).toEqual(['box'])
      expect(handles('box')).toEqual([])
      expect(find('[data-testid="rotate-handle"]')).toBeNull()
      expectPos('box', { x: 100, y: 100 })
    })
    And('there is no toolbar and no buttons to add, copy or delete slides', () => {
      expect(find('[data-testid="element-toolbar"]')).toBeNull()
      expect(find('[data-testid="add-slide"]')).toBeNull()
      expect(find('[data-testid="duplicate-slide"]')).toBeNull()
      expect(find('[data-testid="delete-slide"]')).toBeNull()
    })
    When('Ana presses Delete', () => key('Delete'))
    Then('the deck still has the rectangle at 100, 100, and the note', () => {
      expect(elements().map(item => item.id)).toEqual(['box', 'note'])
      expectPos('box', { x: 100, y: 100 })
    })
  })

  Scenario('The canvas waits while the assistant works', ({ Given, And, When, Then }) => {
    let finish: () => void
    Given('Ana has the deck "Shapes" open in the Design view, with the assistant on', () => openDeck('Shapes', { assistantOn: true }))
    And('Ana selected the rectangle', () => select(RECTANGLE))
    And('Claude takes a while before changing the deck', () => {
      assistant.holdChanges = new Promise((resolve) => {
        finish = resolve
      })
    })
    When('Ana asks the assistant "Add a slide about recursion"', async () => {
      await web.fill('[data-testid="assistant-input"]', 'Add a slide about recursion')
      await web.click('[data-testid="assistant-send"]')
    })
    Then('the rectangle shows no handles and there is no toolbar', () => {
      expect(text('[data-testid="assistant-send"]')).toBe('Working...')
      expect(stage().dataset.locked).toBe('true')
      expect(handles('box')).toEqual([])
      expect(find('[data-testid="element-toolbar"]')).toBeNull()
    })
    And('dragging the rectangle or pressing Delete changes nothing', async () => {
      await drag(RECTANGLE, { x: 260, y: 190 })
      await key('Delete')
      expect(elements().map(item => item.id)).toEqual(['box', 'note'])
      expectPos('box', { x: 100, y: 100 })
    })
    When('Claude finishes', async () => {
      finish()
      await vi.waitFor(() => expect(text('[data-testid="assistant-send"]')).toBe('Send'))
      await web.settle()
    })
    Then('the toolbar is back and the slide can be edited again', () => {
      expect(find('[data-testid="element-toolbar"]')).not.toBeNull()
      expect(stage().dataset.locked).toBeUndefined()
    })
  })

  Scenario('Others\' selections and pointers show on the slide', ({ Given, And, When, Then }) => {
    const anaSeenByBudi = () => budi!.peers.value.find(peer => peer.user.name === 'Ana')
    anaOpens(Given)
    And('Budi has the same deck open in another browser, on slide 1 in the Design view', async () => {
      budi = await openReady(await CloudStore.open(api), projectId, deckId)
      introduce(budi, 'user-budi', 'Budi Santoso')
      publishPresence(budi.awareness, { view: 'design', slideId: readDeckDoc(budi.doc).slides[0].id })
    })
    When('Budi selects the note and points at 300, 200', () => {
      publishPresence(budi!.awareness, { selection: ['note'], pointer: { x: 300, y: 200 } })
    })
    Then('Ana sees the note outlined in Budi\'s color, named "Budi Santoso"', async () => {
      await vi.waitFor(() => expect(find('[data-testid="peer-selection"]')).not.toBeNull())
      const outline = find('[data-testid="peer-selection"]')!
      expect(outline.dataset.peer).toBe('Budi Santoso')
      expect(outline.textContent!.trim()).toBe('Budi Santoso')
      expect(outline.style.left).toBe('500px')
      expect(outline.style.top).toBe('300px')
      expect(outline.getAttribute('style')).toMatch(/border-color: (#46a758|rgb\(70, 167, 88\))/)
    })
    And('Ana sees Budi\'s pointer, named "Budi Santoso", at 300, 200', () => {
      const cursor = find('[data-testid="peer-pointer"]')!
      expect(cursor.dataset.peer).toBe('Budi Santoso')
      expect(cursor.textContent!.trim()).toBe('Budi Santoso')
      expect(cursor.style.left).toBe('300px')
      expect(cursor.style.top).toBe('200px')
    })
    And('the strip shows Budi\'s dot on slide 1', () => {
      expect(findAll('[data-testid="strip-slide"]:nth-child(1) [data-testid="strip-peers"] [data-peer]').map(dot => dot.dataset.peer)).toEqual(['Budi Santoso'])
    })
    When('Ana opens the same deck on a phone too, on slide 1', async () => {
      anaPhone = await openReady(await CloudStore.open(api), projectId, deckId)
      introduce(anaPhone, anaId, 'Ana')
      publishPresence(anaPhone.awareness, { view: 'design', slideId: readDeckDoc(anaPhone.doc).slides[0].id })
      await vi.waitFor(() => expect(session().peers.value.map(peer => peer.user.name).sort()).toEqual(['Ana', 'Budi Santoso']))
      await web.settle()
    })
    Then('the strip still shows only Budi\'s dot on slide 1', () => {
      expect(findAll('[data-testid="strip-slide"]:nth-child(1) [data-testid="strip-peers"] [data-peer]').map(dot => dot.dataset.peer)).toEqual(['Budi Santoso'])
    })
    When('Budi\'s pointer leaves the slide', () => {
      publishPresence(budi!.awareness, { pointer: null })
    })
    Then('Ana no longer sees Budi\'s pointer', async () => {
      await vi.waitFor(() => expect(find('[data-testid="peer-pointer"]')).toBeNull())
      expect(find('[data-testid="peer-selection"]')).not.toBeNull()
    })
    When('Ana moves the pointer to 400, 250 on the slide', () => {
      pointer('pointermove', { x: 400, y: 250 })
    })
    Then('Budi sees Ana\'s pointer at 400, 250', async () => {
      await vi.waitFor(() => expect(anaSeenByBudi()?.pointer).toEqual({ x: 400, y: 250 }))
    })
    When('Ana\'s pointer leaves the slide', () => {
      stage().dispatchEvent(new PointerEvent('pointerleave', { clientX: 990, clientY: 250, pointerId: 1, pointerType: 'mouse' }))
    })
    Then('Budi sees no pointer from Ana', async () => {
      await vi.waitFor(() => expect(anaSeenByBudi()?.pointer).toBeNull())
    })
  })

  Scenario('Two fingers zoom, and the zoom menu and the wheel change it too', ({ Given, Then, When }) => {
    const zoom = () => find('[data-testid="zoom"]') as HTMLSelectElement
    async function choose(value: string) {
      zoom().value = value
      zoom().dispatchEvent(new Event('change'))
      await web.settle()
    }
    anaOpens(Given)
    Then('the zoom shows "Fit" at 100%', () => {
      expect(zoom().value).toBe('fit')
      expect(text('[data-testid="zoom-level"]')).toBe('100%')
    })
    When('Ana spreads two fingers on the slide from 100 to 200 pixels apart', async () => {
      pointer('pointerdown', { x: 440, y: 275 }, { id: 1, touch: true })
      pointer('pointerdown', { x: 540, y: 275 }, { id: 2, touch: true })
      pointer('pointermove', { x: 590, y: 275 }, { id: 2, touch: true })
      pointer('pointermove', { x: 390, y: 275 }, { id: 1, touch: true })
      pointer('pointerup', { x: 390, y: 275 }, { id: 1, touch: true })
      pointer('pointerup', { x: 590, y: 275 }, { id: 2, touch: true })
      await web.settle()
    })
    Then('the zoom is 200%', () => {
      expect(text('[data-testid="zoom-level"]')).toBe('200%')
      expect(find('[data-testid="stage-sheet"]')!.style.width).toBe('1960px')
      // Nothing moved or got selected on the way.
      expectPos('box', { x: 100, y: 100 })
      expect(selectedIds()).toEqual([])
    })
    When('Ana chooses 50% in the zoom menu', () => choose('0.5'))
    Then('the zoom is 50%', () => {
      expect(text('[data-testid="zoom-level"]')).toBe('50%')
    })
    When('Ana chooses Fit in the zoom menu', () => choose('fit'))
    Then('the zoom shows "Fit" at 100% again', () => {
      expect(zoom().value).toBe('fit')
      expect(text('[data-testid="zoom-level"]')).toBe('100%')
    })
    When('Ana turns the wheel up with Control held over the slide', async () => {
      const wheel = new WheelEvent('wheel', { deltaY: -100, bubbles: true, cancelable: true })
      // happy-dom's wheel events carry no keys or pointer position, which browsers give them.
      Object.defineProperties(wheel, { ctrlKey: { value: true }, clientX: { value: 490 }, clientY: { value: 275 } })
      stage().dispatchEvent(wheel)
      await web.settle()
    })
    Then('the zoom is 122%', () => {
      expect(text('[data-testid="zoom-level"]')).toBe('122%')
    })
  })
  Scenario('A pinch that starts on an element leaves it where it was', ({ Given, When, Then, And }) => {
    let steps: number
    anaOpens(Given)
    When('Ana rests a finger on the rectangle and slides it 20 left, then puts a second finger down and spreads both', async () => {
      steps = session().undo.undoStack.length
      pointer('pointerdown', RECTANGLE, { id: 1, touch: true })
      pointer('pointermove', { x: 190, y: 150 }, { id: 1, touch: true })
      pointer('pointermove', { x: 180, y: 150 }, { id: 1, touch: true })
      await web.settle()
      // The move began, and reached the deck.
      expect(pos('box')!.x).toBeLessThan(100)
      pointer('pointerdown', { x: 280, y: 150 }, { id: 2, touch: true })
      pointer('pointermove', { x: 130, y: 150 }, { id: 1, touch: true })
      pointer('pointermove', { x: 330, y: 150 }, { id: 2, touch: true })
      pointer('pointerup', { x: 130, y: 150 }, { id: 1, touch: true })
      pointer('pointerup', { x: 330, y: 150 }, { id: 2, touch: true })
      await web.settle()
    })
    Then('the zoom changed, the deck has the rectangle at 100, 100 and the preview shows it there', () => {
      expect(text('[data-testid="zoom-level"]')).toBe('200%')
      expectPos('box', { x: 100, y: 100 })
      expect(previewPositions.at(-1)!.box).toMatchObject({ x: 100, y: 100 })
    })
    And('there is nothing new to undo or redo', () => {
      expect(session().undo.undoStack).toHaveLength(steps)
      expect(session().undo.redoStack).toHaveLength(0)
    })
  })

  Scenario('On a touch screen a small box keeps its middle free of handles', ({ Given, When, Then }) => {
    let added: PositionedElement
    Given('Ana has the deck "Shapes" open in the Design view on a touch screen', async () => {
      touchScreen()
      await openDeck('Shapes')
    })
    When('Ana adds a text box from the toolbar', () => web.click('[data-testid="add-text"]'))
    Then('the text box shows only its four corner handles, outside it', () => {
      added = elements().at(-1)!
      const shown = handles(added.id)
      expect(shown.map(handle => handle.dataset.handle)).toEqual(['nw', 'ne', 'se', 'sw'])
      // The text box is 480 by 56: each handle touches its corner from outside.
      expect(shown.map(handle => [handle.style.left, handle.style.top, handle.style.width])).toEqual([
        ['-24px', '-24px', '24px'],
        ['480px', '-24px', '24px'],
        ['480px', '56px', '24px'],
        ['-24px', '56px', '24px'],
      ])
    })
    When('Ana double taps the middle of the text box', async () => {
      await tap({ x: 490, y: 276 }, { touch: true })
      await tap({ x: 490, y: 276 }, { touch: true })
    })
    Then('an editor opens over the text box', () => {
      expect(editor()).not.toBeNull()
      expect(editor()!.parentElement!.style.left).toBe('250px')
    })
  })

  Scenario('Text with auto height is as tall as the preview lays it out', ({ Given, Then, When, And }) => {
    Given('Ana has the deck "Title" open in the Design view', () => openDeck('Title'))
    Then('the title\'s box is 96 tall, a first guess from its Markdown', () => {
      expect(box('title').style.height).toBe('96px')
    })
    When('the preview reports the title laid out 130 tall', async () => {
      reportPreviewSizes({ title: { w: 820, h: 130 } })
      await web.settle()
    })
    Then('the title\'s box is 130 tall', () => {
      expect(box('title').style.height).toBe('130px')
    })
    And('a click 120 below the title\'s top selects it', async () => {
      await tap({ x: 490, y: 320 })
      expect(selectedIds()).toEqual(['title'])
    })
  })

  Scenario('The inspector places the selected element, and refuses a value it cannot use', ({ Given, Then, When }) => {
    anaOpens(Given)
    Then('the inspector shows the slide\'s settings', () => {
      expect(find('[data-testid="slide-inspector"]')).not.toBeNull()
      expect(inspectorTitle()).toBe('Slide')
    })
    When('Ana clicks the rectangle', () => select(RECTANGLE))
    Then('the inspector shows "Rectangle" at 100, 100, 200 by 100, turned 0', () => {
      expect(inspectorTitle()).toBe('Rectangle')
      expect(['x', 'y', 'w', 'h', 'rotate'].map(name => field(name).value)).toEqual(['100', '100', '200', '100', '0'])
    })
    When('Ana enters 150 for X and 30 for the turn in the inspector', async () => {
      await enter('x', '150')
      await enter('rotate', '30')
    })
    Then('the deck has the rectangle at 150, 100, turned 30', () => {
      expectPos('box', { x: 150, y: 100, w: 200, h: 100, rotate: 30 })
      expect(field('x').value).toBe('150')
    })
    When('Ana enters -20 for the width', () => enter('w', '-20'))
    Then('the width field says "Enter 8 or more." and the deck has the rectangle 200 wide', () => {
      expect(problemOf('w')).toBe('Enter 8 or more.')
      expect(field('w').getAttribute('aria-invalid')).toBe('true')
      expectPos('box', { w: 200 })
    })
    When('Ana enters 100000 for X', () => enter('x', '100000'))
    Then('the X field says "Keep part of it on the slide." and the deck has the rectangle at 150', () => {
      expect(problemOf('x')).toBe('Keep part of it on the slide.')
      expectPos('box', { x: 150 })
    })
    When('Ana enters "far" for Y', () => enter('y', 'far'))
    Then('the Y field says "Enter a number." and the deck has the rectangle at 150, 100', () => {
      expect(problemOf('y')).toBe('Enter a number.')
      expectPos('box', { x: 150, y: 100 })
    })
    When('Ana enters nothing for the height', () => enter('h', ''))
    Then('the height field says "Enter a number." since a rectangle needs a height', () => {
      expect(problemOf('h')).toBe('Enter a number.')
      expectPos('box', { h: 100 })
    })
    When('Ana presses Escape in the X and Y fields', async () => {
      await key('Escape', {}, field('x'))
      await key('Escape', {}, field('y'))
    })
    Then('the X and Y fields show 150 and 100 again, with no problem', () => {
      expect([field('x').value, field('y').value]).toEqual(['150', '100'])
      expect(find('[data-testid="field-x-problem"]')).toBeNull()
      expect(find('[data-testid="field-y-problem"]')).toBeNull()
      // Escape in a field leaves the selection alone.
      expect(selectedIds()).toEqual(['box'])
    })
    When('Ana drags the rectangle 50 right on the slide', () => drag({ x: 250, y: 150 }, { x: 300, y: 150 }, { alt: true }))
    Then('the X field shows 200', () => {
      expectPos('box', { x: 200 })
      expect(field('x').value).toBe('200')
    })
    When('Ana presses Control Z twice on the slide', async () => {
      stage().focus()
      await key('z', { ctrl: true }, stage())
      await key('z', { ctrl: true }, stage())
    })
    Then('the deck has the rectangle at 150, 100, turned 0', () => {
      expectPos('box', { x: 150, y: 100, rotate: 0 })
      expect(field('rotate').value).toBe('0')
    })
  })

  Scenario('A field whose typing was taken back follows the deck again', ({ Given, When, And, Then }) => {
    anaOpens(Given)
    When('Ana clicks the rectangle', () => select(RECTANGLE))
    And('Ana types 5 after the X, takes it back with Backspace, and leaves the field', async () => {
      const input = field('x')
      input.focus()
      for (const value of ['1005', '100']) {
        input.value = value
        input.dispatchEvent(new Event('input', { bubbles: true }))
      }
      // The text is as it was when the field took the focus, so a browser sends no change event.
      input.dispatchEvent(new FocusEvent('blur'))
      input.blur()
      await web.settle()
    })
    And('Ana nudges the rectangle 10 right with Shift and the right arrow', async () => {
      stage().focus()
      await key('ArrowRight', { shift: true }, stage())
    })
    Then('the X field shows 110', () => {
      expectPos('box', { x: 110 })
      expect(field('x').value).toBe('110')
    })
    When('Ana presses Enter in the X field', async () => {
      field('x').focus()
      await key('Enter', {}, field('x'))
    })
    Then('the deck still has the rectangle at 110', () => {
      expectPos('box', { x: 110 })
      expect(find('[data-testid="field-x-problem"]')).toBeNull()
    })
  })

  Scenario('A text box\'s height can be left to its content', ({ Given, When, And, Then }) => {
    let added: string
    anaOpens(Given)
    When('Ana adds a text box from the toolbar', async () => {
      await web.click('[data-testid="add-text"]')
      added = elements().at(-1)!.id
      expect(field('h').placeholder).toBe('Auto')
    })
    And('Ana enters 120 for the height in the inspector', () => enter('h', '120'))
    Then('the deck has the text box 120 tall', () => {
      expectPos(added, { h: 120 })
    })
    When('Ana enters nothing for the height', () => enter('h', ''))
    Then('the text box has an auto height again', () => {
      expectPos(added, { h: null })
      expect(deckMarkdown(session().doc)).toContain(`<v-drag pos="250,248,480,NaN,0" data-id="${added}">`)
    })
  })

  Scenario('A shape\'s fill, outline and outline width', ({ Given, When, And, Then }) => {
    anaOpens(Given)
    When('Ana clicks the rectangle', () => select(RECTANGLE))
    And('Ana enters "#ff0000" for the fill in the inspector', () => enter('fill', '#ff0000'))
    Then('the deck\'s Markdown draws the rectangle with fill="#ff0000"', () => {
      expect(deckMarkdown(session().doc)).toContain('<DeyslideShape shape="rect" fill="#ff0000" />')
    })
    When('Ana enters "not a color" for the fill', () => enter('fill', 'not a color'))
    Then('the fill field says "Enter a color, such as #38bdf8 or red." and the fill is still "#ff0000"', () => {
      expect(problemOf('fill')).toBe('Enter a color, such as #38bdf8 or red.')
      expect(props('box').fill).toBe('#ff0000')
    })
    When('Ana enters "notacolor", then "rgb(foo)" for the fill', async () => {
      await enter('fill', 'notacolor')
      expect(problemOf('fill')).toBe('Enter a color, such as #38bdf8 or red.')
      await enter('fill', 'rgb(foo)')
    })
    Then('the fill field still says "Enter a color, such as #38bdf8 or red." and the fill is still "#ff0000"', () => {
      expect(problemOf('fill')).toBe('Enter a color, such as #38bdf8 or red.')
      expect(props('box').fill).toBe('#ff0000')
    })
    When('Ana picks "#00ff00" for the outline and enters 4 for the outline width', async () => {
      const picker = find('[data-testid="pick-stroke"]') as HTMLInputElement
      picker.value = '#00ff00'
      picker.dispatchEvent(new Event('change', { bubbles: true }))
      await web.settle()
      await enter('stroke-width', '4')
    })
    Then('the rectangle has a "#00ff00" outline 4 wide', () => {
      expect(props('box')).toMatchObject({ stroke: '#00ff00', strokeWidth: 4 })
      expect(field('stroke').value).toBe('#00ff00')
    })
    When('Ana enters -1 for the outline width', () => enter('stroke-width', '-1'))
    Then('the outline width field says "Enter 0 or more." and the outline is still 4 wide', () => {
      expect(problemOf('stroke-width')).toBe('Enter 0 or more.')
      expect(props('box').strokeWidth).toBe(4)
    })
    When('Ana enters nothing for the fill', () => enter('fill', ''))
    Then('the rectangle has no fill of its own, so it shows the default', () => {
      expect(props('box')).toEqual({ shape: 'rect', stroke: '#00ff00', strokeWidth: 4 })
      expect(deckMarkdown(session().doc)).toContain('<DeyslideShape shape="rect" stroke="#00ff00" :stroke-width=\'4\' />')
    })
  })

  Scenario('An image\'s link and description', ({ Given, When, And, Then }) => {
    let image: string
    anaOpens(Given)
    When('Ana adds an image of "https://example.com/cat.png" from the toolbar', async () => {
      await web.click('[data-testid="add-image"]')
      await web.fill('[data-testid="image-url"]', 'https://example.com/cat.png')
      await web.submit('[data-testid="image-form"]')
      image = elements().at(-1)!.id
      expect(inspectorTitle()).toBe('Image')
    })
    And('Ana enters "javascript:alert(1)" for the image link in the inspector', () => enter('src', 'javascript:alert(1)'))
    Then('the image link field says "Enter a link that starts with https://, http:// or /." and the image still shows "https://example.com/cat.png"', () => {
      expect(problemOf('src')).toBe('Enter a link that starts with https://, http:// or /.')
      expect(element(image)).toMatchObject({ src: 'https://example.com/cat.png' })
    })
    When('Ana enters "/pictures/dog.png" for the image link and "A sleepy dog" for its description', async () => {
      await enter('src', '/pictures/dog.png')
      await enter('alt', 'A sleepy dog')
    })
    Then('the deck has an image of "/pictures/dog.png" described as "A sleepy dog"', () => {
      expect(element(image)).toMatchObject({ src: '/pictures/dog.png', alt: 'A sleepy dog' })
      expect(find('[data-testid="field-src-problem"]')).toBeNull()
    })
  })

  Scenario('Code with Magic Move steps', ({ Given, When, Then }) => {
    let code: string
    const steps = () => (element(code) as Extract<PositionedElement, { type: 'code' }>).steps
    anaOpens(Given)
    When('Ana adds code from the toolbar', async () => {
      await web.click('[data-testid="add-code"]')
      code = elements().at(-1)!.id
    })
    Then('the inspector shows one step in "ts"', () => {
      expect(inspectorTitle()).toBe('Code')
      expect(findAll('[data-testid="code-step"]')).toHaveLength(1)
      expect(field('step-0-lang').value).toBe('ts')
      expect(field('step-0-code').value).toBe('const greeting = \'Hello\'')
    })
    When('Ana enters "type script" for the language', () => enter('step-0-lang', 'type script'))
    Then('the language field says "A language name has no spaces or backticks." and the code is still in "ts"', () => {
      expect(problemOf('step-0-lang')).toBe('A language name has no spaces or backticks.')
      expect(steps()).toEqual([{ lang: 'ts', code: 'const greeting = \'Hello\'' }])
    })
    When('Ana adds a Magic Move step and enters "const greeting = \'Hi\'" as its code', async () => {
      await web.click('[data-testid="add-step"]')
      await enter('step-1-code', 'const greeting = \'Hi\'')
    })
    Then('the deck\'s Markdown has a Magic Move block with both steps', () => {
      expect(steps()).toEqual([{ lang: 'ts', code: 'const greeting = \'Hello\'' }, { lang: 'ts', code: 'const greeting = \'Hi\'' }])
      expect(deckMarkdown(session().doc)).toContain('````md magic-move\n```ts\nconst greeting = \'Hello\'\n```\n```ts\nconst greeting = \'Hi\'\n```\n````')
    })
    When('Ana enters a line starting with three backticks in the second step', () => enter('step-1-code', '```\nconst greeting = \'Hi\''))
    Then('the second code field says "A Magic Move step cannot have a line that starts with ```." and the deck keeps both steps', () => {
      expect(problemOf('step-1-code')).toBe('A Magic Move step cannot have a line that starts with ```.')
      expect(steps()).toHaveLength(2)
      expect(steps()[1].code).toBe('const greeting = \'Hi\'')
    })
    When('Ana presses Escape in the second code field and removes the first step', async () => {
      // The refused text stays with its step until it is taken back.
      await key('Escape', {}, field('step-1-code'))
      await web.click('[data-testid="remove-step-0"]')
    })
    Then('the code has one step, "const greeting = \'Hi\'", in a plain code block', () => {
      expect(steps()).toEqual([{ lang: 'ts', code: 'const greeting = \'Hi\'' }])
      expect(deckMarkdown(session().doc)).toContain(`data-id="${code}">\n\n\`\`\`ts\nconst greeting = 'Hi'\n\`\`\`\n\n</v-drag>`)
      expect(findAll('[data-testid="code-step"]')).toHaveLength(1)
      expect(field('step-0-code').value).toBe('const greeting = \'Hi\'')
    })
  })

  Scenario('A 3D scene\'s camera, model and switches', ({ Given, When, And, Then }) => {
    let scene: string
    anaOpens(Given)
    When('Ana adds a 3D scene from the toolbar', async () => {
      await web.click('[data-testid="add-scene3d"]')
      scene = elements().at(-1)!.id
    })
    And('Ana clicks an empty part of the slide, then double clicks the 3D scene', async () => {
      await tap({ x: 400, y: 500 })
      expect(inspectorTitle()).toBe('Slide')
      await tap({ x: 490, y: 276 })
      await tap({ x: 490, y: 276 })
    })
    Then('the inspector shows "3D scene", with the focus in its first field', async () => {
      expect(inspectorTitle()).toBe('3D scene')
      await vi.waitFor(() => expect(document.activeElement).toBe(field('x')))
      expect(find('[data-testid="inline-editor"]')).toBeNull()
    })
    When('Ana enters "1, 2" for the camera position', () => enter('camera-position', '1, 2'))
    Then('the camera position field says "Enter three numbers, such as 7, 5, 9."', () => {
      expect(problemOf('camera-position')).toBe('Enter three numbers, such as 7, 5, 9.')
      expect(props(scene)).toEqual({})
    })
    When('Ana enters "1, 2, 3" for the camera position, "0 0 0" for where it looks and "server" for the focus', async () => {
      await enter('camera-position', '1, 2, 3')
      await enter('target', '0 0 0')
      await enter('focus', 'server')
    })
    And('Ana enters 0 for the zoom level', () => enter('zoom-level', '0'))
    Then('the zoom level field says "Enter a number above 0."', () => {
      expect(problemOf('zoom-level')).toBe('Enter a number above 0.')
    })
    When('Ana enters 2 for the zoom level, 0.5 for the spin, 6 for the smoothing and "intro" for the scene id', async () => {
      await enter('zoom-level', '2')
      await enter('spin', '0.5')
      await enter('smoothing', '6')
      await enter('scene-id', 'intro')
    })
    And('Ana enters "/models/robot.glb" for the model', () => enter('model', '/models/robot.glb'))
    And('Ana turns on orbit controls and seeing through to the slide', async () => {
      await web.click('[data-testid="switch-orbit-controls"]')
      await web.click('[data-testid="switch-transparent"]')
    })
    Then('the 3D scene\'s props are all set, and its Markdown binds them', () => {
      expect(props(scene)).toEqual({
        cameraPosition: [1, 2, 3],
        target: [0, 0, 0],
        focus: 'server',
        zoomLevel: 2,
        spin: 0.5,
        smoothing: 6,
        sceneId: 'intro',
        model: '/models/robot.glb',
        orbitControls: true,
        transparent: true,
      })
      const markdown = deckMarkdown(session().doc)
      for (const attribute of [':camera-position=\'[1,2,3]\'', ':target=\'[0,0,0]\'', 'focus="server"', ':zoom-level=\'2\'', 'model="/models/robot.glb"', ':orbit-controls=\'true\'', ':transparent=\'true\''])
        expect(markdown).toContain(attribute)
    })
    When('Ana enters nothing for the camera position', () => enter('camera-position', ''))
    Then('the 3D scene has no camera position of its own', () => {
      expect(props(scene).cameraPosition).toBeUndefined()
      expect(deckMarkdown(session().doc)).not.toContain('camera-position')
    })
  })

  Scenario('An algorithm player\'s link and switches', ({ Given, When, Then }) => {
    let player: string
    const checked = (name: string) => (find(`[data-testid="switch-${name}"]`) as HTMLInputElement).checked
    anaOpens(Given)
    When('Ana adds an algorithm player from the toolbar', async () => {
      await web.click('[data-testid="add-algo-player"]')
      player = elements().at(-1)!.id
    })
    Then('it plays on its own, loops and shows controls', () => {
      expect(inspectorTitle()).toBe('Algorithm player')
      expect([checked('autoplay'), checked('loop'), checked('controls')]).toEqual([true, true, true])
    })
    When('Ana turns off playing on its own and looping', async () => {
      await web.click('[data-testid="switch-autoplay"]')
      await web.click('[data-testid="switch-loop"]')
    })
    Then('the deck\'s algorithm player does not play on its own or loop, and still shows controls', () => {
      expect(props(player)).toEqual({ src: '/animations/bubble-sort.js', autoplay: false, loop: false })
      expect([checked('autoplay'), checked('loop'), checked('controls')]).toEqual([false, false, true])
    })
    When('Ana enters 2 for the quality', () => enter('quality', '2'))
    Then('the quality field says "Enter a number from 0 to 1."', () => {
      expect(problemOf('quality')).toBe('Enter a number from 0 to 1.')
      expect(props(player).quality).toBeUndefined()
    })
    When('Ana enters nothing for the animation link', () => enter('src', ''))
    Then('the animation link field says "Enter a link that starts with https://, http:// or /."', () => {
      expect(problemOf('src')).toBe('Enter a link that starts with https://, http:// or /.')
      expect(props(player).src).toBe('/animations/bubble-sort.js')
    })
    When('Ana enters "/animations/quick-sort.js" for the animation link', () => enter('src', '/animations/quick-sort.js'))
    Then('the deck\'s algorithm player plays "/animations/quick-sort.js"', () => {
      expect(props(player).src).toBe('/animations/quick-sort.js')
      expect(deckMarkdown(session().doc)).toContain('<DeyslideAlgoPlayer src="/animations/quick-sort.js" :autoplay=\'false\' :loop=\'false\' />')
    })
  })

  Scenario('A live sandbox\'s starting values', ({ Given, When, Then }) => {
    let sandbox: string
    const initial = () => props(sandbox).initial as Record<string, string | number | boolean>
    anaOpens(Given)
    When('Ana adds a live sandbox from the toolbar', async () => {
      await web.click('[data-testid="add-sandbox"]')
      sandbox = elements().at(-1)!.id
    })
    Then('the inspector lists one value, "count", a number set to 0', () => {
      expect(inspectorTitle()).toBe('Live sandbox')
      expect(findAll('[data-testid="sandbox-value"]')).toHaveLength(1)
      expect(field('value-0-key').value).toBe('count')
      expect((find('[data-testid="field-value-0-kind"]') as HTMLSelectElement).value).toBe('number')
      expect(field('value-0').value).toBe('0')
    })
    When('Ana renames "count" to "total" and adds a value', async () => {
      await enter('value-0-key', 'total')
      await web.click('[data-testid="add-value"]')
    })
    Then('the sandbox starts with total 0 and value2 0', () => {
      expect(initial()).toEqual({ total: 0, value2: 0 })
    })
    When('Ana makes value2 a switch and turns it on', async () => {
      await choose('field-value-1-kind', 'switch')
      expect(initial()).toEqual({ total: 0, value2: false })
      await web.click('[data-testid="field-value-1"]')
    })
    Then('the sandbox starts with total 0 and value2 on', () => {
      expect(initial()).toEqual({ total: 0, value2: true })
      expect(deckMarkdown(session().doc)).toContain(':initial=\'{"total":0,"value2":true}\'')
    })
    When('Ana renames value2 to "total"', () => enter('value-1-key', 'total'))
    Then('the name field says "Another value has that name."', () => {
      expect(problemOf('value-1-key')).toBe('Another value has that name.')
      expect(initial()).toEqual({ total: 0, value2: true })
    })
    When('Ana renames value2 to "__proto__"', () => enter('value-1-key', '__proto__'))
    Then('the name field says "Choose another name." and the sandbox still starts with total 0 and value2 on', () => {
      expect(problemOf('value-1-key')).toBe('Choose another name.')
      expect(initial()).toEqual({ total: 0, value2: true })
      expect(findAll('[data-testid="sandbox-value"]')).toHaveLength(2)
      // The field keeps the name until Ana changes it or presses Escape.
      field('value-1-key').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    When('Ana enters "many" as the value of total', () => enter('value-0', 'many'))
    Then('the value field says "Enter a number." and total is still 0', () => {
      expect(problemOf('value-0')).toBe('Enter a number.')
      expect(initial().total).toBe(0)
    })
    When('Ana removes total', () => web.click('[data-testid="remove-value-0"]'))
    Then('the sandbox starts with value2 on only', () => {
      expect(initial()).toEqual({ value2: true })
      expect(findAll('[data-testid="sandbox-value"]')).toHaveLength(1)
    })
  })

  Scenario('What Ana types in a step or a value goes to its row while Budi removes another', ({ Given, And, When, Then }) => {
    let added: string
    let typing: HTMLInputElement | HTMLTextAreaElement
    const budiChanges = async (patch: Parameters<typeof updateElement>[3], seen: () => boolean) => {
      updateElement(budi!.doc, readDeckDoc(budi!.doc).slides[0].id, added, patch, 'budi')
      await vi.waitFor(() => expect(seen()).toBe(true))
      await web.settle()
    }
    /** Types into a field without leaving it. */
    async function typeInto(name: string, value: string) {
      typing = field(name)
      typing.focus()
      typing.value = value
      typing.dispatchEvent(new Event('input', { bubbles: true }))
      await web.settle()
    }
    async function leave() {
      typing.dispatchEvent(new FocusEvent('blur'))
      await web.settle()
    }
    const codeSteps = () => (element(added) as Extract<PositionedElement, { type: 'code' }>).steps.map(step => step.code)
    anaOpens(Given)
    And('Budi has the same deck open in another browser', async () => {
      budi = await openReady(await CloudStore.open(api), projectId, deckId)
    })
    When('Ana adds code with the steps "one", "two" and "three"', async () => {
      await web.click('[data-testid="add-code"]')
      added = elements().at(-1)!.id
      session().transact(() => updateElement(session().doc, slideId(), added, { steps: ['one', 'two', 'three'].map(code => ({ lang: 'ts', code })) }, LOCAL_ORIGIN))
      await web.settle()
      expect(findAll('[data-testid="code-step"]')).toHaveLength(3)
      await vi.waitFor(() => expect(readDeckDoc(budi!.doc).slides[0].elements.some(item => item.id === added)).toBe(true))
    })
    And('Ana types " edited" at the end of the second step\'s code', () => typeInto('step-1-code', 'two edited'))
    And('Budi removes the first step', () => budiChanges(
      { steps: [{ lang: 'ts', code: 'two' }, { lang: 'ts', code: 'three' }] },
      () => findAll('[data-testid="code-step"]').length === 2,
    ))
    And('Ana leaves the code field', async () => {
      // Ana's text stayed with its step, now the first.
      expect(field('step-0-code').value).toBe('two edited')
      await leave()
    })
    Then('the code\'s steps are "two edited" and "three"', async () => {
      expect(codeSteps()).toEqual(['two edited', 'three'])
      await vi.waitFor(() => expect((readDeckDoc(budi!.doc).slides[0].elements.find(item => item.id === added) as { steps: { code: string }[] }).steps.map(step => step.code)).toEqual(['two edited', 'three']))
    })
    When('Ana types " again" at the end of the first step\'s code', () => typeInto('step-0-code', 'two edited again'))
    And('Budi removes the first step and changes "three" to "three by Budi" in one change', () => budiChanges(
      { steps: [{ lang: 'ts', code: 'three by Budi' }] },
      () => findAll('[data-testid="code-step"]').length === 1,
    ))
    And('Ana leaves the first step\'s code field', leave)
    Then('the code\'s only step is "three by Budi", and Ana\'s typing went to no step', async () => {
      // Which step was which cannot be told from the change, so the field
      // Ana typed in went with its step rather than stay on Budi's.
      expect(field('step-0-code').value).toBe('three by Budi')
      expect(codeSteps()).toEqual(['three by Budi'])
      await vi.waitFor(() => expect((readDeckDoc(budi!.doc).slides[0].elements.find(item => item.id === added) as { steps: { code: string }[] }).steps.map(step => step.code)).toEqual(['three by Budi']))
    })
    When('Ana adds a live sandbox starting with a, b and c at 0', async () => {
      await web.click('[data-testid="add-sandbox"]')
      added = elements().at(-1)!.id
      session().transact(() => updateElement(session().doc, slideId(), added, { props: { ...props(added), initial: { a: 0, b: 0, c: 0 } } }, LOCAL_ORIGIN))
      await web.settle()
      expect(findAll('[data-testid="sandbox-value"]')).toHaveLength(3)
      await vi.waitFor(() => expect(readDeckDoc(budi!.doc).slides[0].elements.some(item => item.id === added)).toBe(true))
    })
    And('Ana types 5 as the value of b', () => typeInto('value-1', '5'))
    And('Budi removes a', () => {
      const current = readDeckDoc(budi!.doc).slides[0].elements.find(item => item.id === added) as { props: Record<string, unknown> }
      return budiChanges({ props: { ...current.props, initial: { b: 0, c: 0 } } }, () => findAll('[data-testid="sandbox-value"]').length === 2)
    })
    And('Ana leaves the value field', async () => {
      expect(field('value-0').value).toBe('5')
      await leave()
    })
    Then('the sandbox starts with b at 5 and c at 0', () => {
      expect(props(added).initial).toEqual({ b: 5, c: 0 })
    })
  })

  Scenario('The inspector moves an element forward, backward, to the front and to the back', ({ Given, When, Then, And }) => {
    const disabled = (name: string) => (find(`[data-testid="stack-${name}"]`) as HTMLButtonElement).disabled
    anaOpens(Given)
    When('Ana clicks the rectangle', () => select(RECTANGLE))
    Then('the rectangle cannot go further back, only forward', () => {
      expect(['backward', 'back', 'forward', 'front'].map(disabled)).toEqual([true, true, false, false])
    })
    When('Ana brings the rectangle forward', () => web.click('[data-testid="stack-forward"]'))
    Then('the slide paints the note, then the rectangle', () => {
      expect(order()).toEqual(['note', 'box'])
      expect(selectedIds()).toEqual(['box'])
    })
    And('the rectangle cannot go further forward', () => {
      expect(['backward', 'back', 'forward', 'front'].map(disabled)).toEqual([false, false, true, true])
    })
    When('Ana sends the rectangle to the back', () => web.click('[data-testid="stack-back"]'))
    Then('the slide paints the rectangle, then the note', () => {
      expect(order()).toEqual(['box', 'note'])
    })
    When('Ana selects the note and sends it backward', async () => {
      await select(NOTE)
      expect(inspectorTitle()).toBe('Text')
      await web.click('[data-testid="stack-backward"]')
    })
    Then('the note is painted first, under the rectangle', () => {
      expect(order()).toEqual(['note', 'box'])
    })
    When('Ana brings the note to the front', () => web.click('[data-testid="stack-front"]'))
    Then('the note is painted last, over the rectangle', () => {
      expect(order()).toEqual(['box', 'note'])
      expect(deckMarkdown(session().doc).indexOf('data-id="box"')).toBeLessThan(deckMarkdown(session().doc).indexOf('data-id="note"'))
    })
  })

  Scenario('Markdown that flows in the slide always shows under movable elements', ({ Given, When, Then }) => {
    Given('Ana has the deck "Flow" open in the Design view', () => openDeck('Flow'))
    When('Ana clicks the box', () => select({ x: 700, y: 350 }))
    Then('the box has nothing to go in front of or behind', () => {
      expect(inspectorTitle()).toBe('Rectangle')
      expect(['backward', 'back', 'forward', 'front'].map(name => (find(`[data-testid="stack-${name}"]`) as HTMLButtonElement).disabled)).toEqual([true, true, true, true])
    })
  })

  Scenario('An element can go behind Markdown laid over the slide', ({ Given, When, Then, And }) => {
    const all = () => readDeckDoc(session().doc).slides[0].elements.map(item => item.type === 'raw' ? item.markdown.split('\n')[0] : item.id)
    const disabled = (name: string) => (find(`[data-testid="stack-${name}"]`) as HTMLButtonElement).disabled
    const BACKDROP = '<div class="absolute inset-0 bg-slate-800"></div>'
    Given('Ana has the deck "Backdrop" open in the Design view', () => openDeck('Backdrop'))
    When('Ana clicks the box', () => select({ x: 700, y: 350 }))
    Then('the box can go behind the backdrop, but not further forward', () => {
      expect(all()).toEqual([BACKDROP, 'box', 'Bubble sort swaps neighbours.'])
      expect(['backward', 'back', 'forward', 'front'].map(disabled)).toEqual([false, false, true, true])
    })
    When('Ana sends the box to the back', () => web.click('[data-testid="stack-back"]'))
    Then('the slide paints the box first, under the backdrop, and the flowing Markdown stays last', () => {
      expect(all()).toEqual(['box', BACKDROP, 'Bubble sort swaps neighbours.'])
      expect(['backward', 'back', 'forward', 'front'].map(disabled)).toEqual([true, true, false, false])
    })
    And('the deck\'s Markdown starts the slide with the box', () => {
      expect(deckMarkdown(session().doc)).toMatch(/^---\ntheme: default\n---\n\n<v-drag pos="600,300,200,100,0" data-id="box">/)
    })
    When('Ana brings the box forward', () => web.click('[data-testid="stack-forward"]'))
    Then('the slide paints the backdrop, then the box', () => {
      expect(all()).toEqual([BACKDROP, 'box', 'Bubble sort swaps neighbours.'])
    })
  })

  Scenario('Deleting from the inspector', ({ Given, When, Then }) => {
    anaOpens(Given)
    When('Ana clicks the note and deletes it from the inspector', async () => {
      await select(NOTE)
      await web.click('[data-testid="delete-element"]')
    })
    Then('the slide has only the rectangle, and the inspector shows the slide\'s settings', () => {
      expect(order()).toEqual(['box'])
      expect(selectedIds()).toEqual([])
      expect(inspectorTitle()).toBe('Slide')
    })
    When('Ana adds a text box, then clicks the rectangle with Shift held', async () => {
      await web.click('[data-testid="add-text"]')
      await tap(RECTANGLE, { shift: true })
    })
    Then('the inspector says "2 elements selected"', () => {
      expect(selectedIds()).toHaveLength(2)
      expect(inspectorTitle()).toBe('2 elements selected')
    })
    When('Ana deletes them from the inspector', () => web.click('[data-testid="delete-elements"]'))
    Then('the slide has no elements, and nothing is selected', () => {
      expect(order()).toEqual([])
      expect(selectedIds()).toEqual([])
      expect(inspectorTitle()).toBe('Slide')
    })
  })

  Scenario('Slide settings', ({ Given, Then, When, And }) => {
    const options = () => [...(find('[data-testid="field-layout"]') as HTMLSelectElement).options].map(option => option.value)
    anaOpens(Given)
    Then('the layout menu offers "Automatic (cover)", then the preview\'s own layouts', async () => {
      await vi.waitFor(() => expect(options()).toEqual(['', ...Object.keys(LAYOUTS)]))
      // The first slide is a cover unless it names a layout: the empty choice says so, unlike "default".
      expect((find('[data-testid="field-layout"]') as HTMLSelectElement).options[0].textContent?.trim()).toBe('Automatic (cover)')
      expect((find('[data-testid="field-layout"]') as HTMLSelectElement).value).toBe('default')
    })
    When('Ana chooses the "center" layout and the "slide-up" transition', async () => {
      await choose('field-layout', 'center')
      await choose('field-transition', 'slide-up')
    })
    Then('the slide\'s frontmatter has the "center" layout and the "slide-up" transition, and keeps its theme', () => {
      expect(slideFrontmatter()).toEqual({ theme: 'default', layout: 'center', transition: 'slide-up' })
    })
    And('the preview renders the slide with the "center" layout', async () => {
      await vi.waitFor(() => expect(previewRequests.at(-1)!.slide.frontmatter).toMatchObject({ layout: 'center', transition: 'slide-up' }))
    })
    When('Ana enters "text-center" for the class and "#123456" for the background', async () => {
      await enter('class', 'text-center')
      await enter('background', '#123456')
    })
    Then('the slide\'s frontmatter has the class "text-center" and the background "#123456"', () => {
      expect(slideFrontmatter()).toMatchObject({ class: 'text-center', background: '#123456' })
    })
    When('Ana enters "not a thing at all" for the background', () => enter('background', 'not a thing at all'))
    Then('the background field says "Enter a color such as #0f172a, or an image link." and the background is still "#123456"', () => {
      expect(problemOf('background')).toBe('Enter a color such as #0f172a, or an image link.')
      expect(slideFrontmatter().background).toBe('#123456')
    })
    When('Ana enters "/pictures/sky.png" for the background', () => enter('background', '/pictures/sky.png'))
    Then('the slide\'s background is "/pictures/sky.png"', () => {
      expect(problemOf('background')).toBe('')
      expect(slideFrontmatter().background).toBe('/pictures/sky.png')
    })
    When('Ana enters 2.5 for the clicks', () => enter('clicks', '2.5'))
    Then('the clicks field says "Enter a whole number." and the slide names no clicks', () => {
      expect(problemOf('clicks')).toBe('Enter a whole number.')
      expect(slideFrontmatter()).not.toHaveProperty('clicks')
    })
    When('Ana enters 3 for the clicks, then nothing for the class', async () => {
      await enter('clicks', '3')
      await enter('class', '')
    })
    Then('the slide\'s frontmatter has 3 clicks and no class', () => {
      expect(slideFrontmatter()).toEqual({ theme: 'default', layout: 'center', transition: 'slide-up', background: '/pictures/sky.png', clicks: 3 })
    })
    When('Ana chooses the default layout', () => choose('field-layout', ''))
    Then('the slide\'s frontmatter names no layout', () => {
      expect(slideFrontmatter()).not.toHaveProperty('layout')
      expect(deckMarkdown(session().doc)).not.toContain('layout:')
    })
    When('Ana presses Control Z on the slide', async () => {
      stage().focus()
      await key('z', { ctrl: true }, stage())
    })
    Then('the slide\'s frontmatter has the "center" layout again', () => {
      expect(slideFrontmatter().layout).toBe('center')
      expect((find('[data-testid="field-layout"]') as HTMLSelectElement).value).toBe('center')
    })
  })

  Scenario('Markdown that flows in the slide is edited in place or made movable', ({ Given, Then, When, And }) => {
    let view: EditorView
    let made: string
    const blocks = () => readDeckDoc(session().doc).slides[0].elements.filter(item => item.type === 'raw') as { markdown: string }[]
    Given('Ana has the deck "Flow" open in the Design view', () => openDeck('Flow'))
    Then('the inspector lists the slide\'s Markdown blocks "# Sorting" and "Bubble sort swaps neighbours."', () => {
      expect(findAll('[data-testid="raw-summary"]').map(item => item.textContent)).toEqual(['# Sorting', 'Bubble sort swaps neighbours.'])
    })
    When('Ana edits the first block and types " fast" at its end', async () => {
      findAll('[data-testid="raw-block"]')[0].querySelector<HTMLButtonElement>('[data-testid="edit-raw"]')!.click()
      await web.settle()
      view = editorView('[data-testid="raw-editor"]')
      expect(view.state.doc.toString()).toBe('# Sorting')
      view.dispatch({ changes: { from: view.state.doc.length, insert: ' fast' } })
      await web.settle()
    })
    Then('the deck\'s first block says "# Sorting fast"', () => {
      expect(blocks()[0].markdown).toBe('# Sorting fast')
    })
    When('Ana presses Control Z in the block editor', () => key('z', { ctrl: true }, view.contentDOM))
    Then('the deck\'s first block says "# Sorting" again, through the deck\'s undo', () => {
      expect(blocks()[0].markdown).toBe('# Sorting')
      expect(view.state.doc.toString()).toBe('# Sorting')
      expect(session().undo.redoStack).toHaveLength(1)
    })
    When('Ana makes the second block movable', async () => {
      const second = findAll('[data-testid="raw-block"]')[1]
      second.querySelector<HTMLButtonElement>('[data-testid="make-movable"]')!.click()
      await web.settle()
    })
    Then('the slide has a text element "Bubble sort swaps neighbours." at 56, 40, 868 wide with an auto height, selected', () => {
      const added = elements().find(item => item.type === 'text')!
      made = added.id
      expect(added).toMatchObject({ markdown: 'Bubble sort swaps neighbours.', pos: { x: 56, y: 40, w: 868, h: null, rotate: 0 } })
      expect(selectedIds()).toEqual([made])
      expect(blocks().map(block => block.markdown)).toEqual(['# Sorting'])
    })
    And('the deck\'s Markdown places it in a v-drag where the block was, after the box', () => {
      expect(readDeckDoc(session().doc).slides[0].elements.map(item => item.id)).toEqual([expect.any(String), 'box', made])
      expect(deckMarkdown(session().doc)).toContain(`</v-drag>\n\n<v-drag pos="56,40,868,NaN,0" data-id="${made}">\n\nBubble sort swaps neighbours.\n\n</v-drag>`)
    })
    And('the inspector shows "Text" at 56, 40', () => {
      expect(inspectorTitle()).toBe('Text')
      expect([field('x').value, field('y').value]).toEqual(['56', '40'])
    })
  })

  Scenario('A Markdown block with slot markers cannot be made movable', ({ Given, When, Then, And }) => {
    let before: string
    Given('Ana has the deck "Columns" open in the Design view', async () => {
      await openDeck('Columns')
      before = deckMarkdown(session().doc)
    })
    When('Ana makes the slide\'s Markdown block movable', async () => {
      expect(findAll('[data-testid="raw-block"]')).toHaveLength(1)
      await web.click('[data-testid="make-movable"]')
    })
    Then('the inspector says "A block with a slot marker such as ::right::, a script or a style cannot be made movable."', () => {
      expect(text('[data-testid="inspector-problem"]')).toBe('A block with a slot marker such as ::right::, a script or a style cannot be made movable.')
    })
    And('the slide is unchanged', () => {
      expect(deckMarkdown(session().doc)).toBe(before)
      expect(elements()).toEqual([])
      expect(session().undo.undoStack).toHaveLength(0)
    })
  })

  Scenario('A Markdown block laid over the slide cannot be made movable', ({ Given, When, Then, And }) => {
    let before: string
    Given('Ana has the deck "Backdrop" open in the Design view', async () => {
      await openDeck('Backdrop')
      before = deckMarkdown(session().doc)
    })
    When('Ana makes the backdrop\'s Markdown block movable', async () => {
      const backdrop = findAll('[data-testid="raw-block"]')[0]
      expect(backdrop.querySelector('[data-testid="raw-summary"]')!.textContent).toContain('absolute inset-0')
      backdrop.querySelector<HTMLButtonElement>('[data-testid="make-movable"]')!.click()
      await web.settle()
    })
    Then('the inspector says "This block is laid over the slide by its class or style, so it cannot be made movable."', () => {
      expect(text('[data-testid="inspector-problem"]')).toBe('This block is laid over the slide by its class or style, so it cannot be made movable.')
    })
    And('the slide is unchanged', () => {
      expect(deckMarkdown(session().doc)).toBe(before)
      expect(session().undo.undoStack).toHaveLength(0)
    })
  })

  /** Budi copies the slide Ana is on and moves the original after the copy, which gives its texts new objects. */
  async function budiMovesTheSlide(original: string) {
    const copy = duplicateSlide(budi!.doc, original, 'budi')
    moveSlide(budi!.doc, original, 1, 'budi')
    await vi.waitFor(() => expect(readDeckDoc(session().doc).slides.map(item => item.id)).toEqual([copy, original]))
    await web.settle()
    return copy
  }

  Scenario('A Markdown block\'s editor keeps Ana\'s place when someone moves its slide', ({ Given, And, When, Then }) => {
    let original: string
    let copy: string
    let view: EditorView
    const firstBlock = (doc: Y.Doc, id: string) => (readDeckDoc(doc).slides.find(item => item.id === id)!.elements[0] as { markdown: string }).markdown
    Given('Ana has the deck "Flow" open in the Design view', () => openDeck('Flow'))
    And('Budi has the same deck open in another browser', async () => {
      budi = await openReady(await CloudStore.open(api), projectId, deckId)
    })
    When('Ana edits the first block and types " fast" at its end', async () => {
      original = slideId()
      findAll('[data-testid="raw-block"]')[0].querySelector<HTMLButtonElement>('[data-testid="edit-raw"]')!.click()
      await web.settle()
      view = editorView('[data-testid="raw-editor"]')
      view.dispatch({ changes: { from: view.state.doc.length, insert: ' fast' } })
      await web.settle()
      await vi.waitFor(() => expect(firstBlock(budi!.doc, original)).toBe('# Sorting fast'))
    })
    And('Ana puts the cursor after "#"', () => {
      view.dispatch({ selection: { anchor: 1 } })
      view.focus()
      expect(document.activeElement).toBe(view.contentDOM)
    })
    And('Budi copies the slide and moves Ana\'s slide after the copy', async () => {
      copy = await budiMovesTheSlide(original)
    })
    Then('the block editor still has the focus, with the cursor after "#"', () => {
      expect(slideId()).toBe(original)
      // The same editor, bound to the block's new text.
      expect(editorView('[data-testid="raw-editor"]')).toBe(view)
      expect(document.activeElement).toBe(view.contentDOM)
      expect(view.state.selection.main.head).toBe(1)
      expect(view.state.doc.toString()).toBe('# Sorting fast')
    })
    When('Ana types " Quick"', async () => {
      view.dispatch(view.state.replaceSelection(' Quick'))
      await web.settle()
    })
    Then('Budi\'s deck has "# Quick Sorting fast" on Ana\'s slide, and the copy keeps "# Sorting fast"', async () => {
      await vi.waitFor(() => expect(firstBlock(budi!.doc, original)).toBe('# Quick Sorting fast'))
      expect(firstBlock(budi!.doc, copy)).toBe('# Sorting fast')
      expect(firstBlock(session().doc, original)).toBe('# Quick Sorting fast')
    })
  })

  Scenario('The notes editor keeps Ana\'s place when someone moves the slide', ({ Given, And, When, Then }) => {
    let original: string
    let view: EditorView
    Given('Ana has the deck "Flow" open in the Design view', () => openDeck('Flow'))
    And('Budi has the same deck open in another browser', async () => {
      budi = await openReady(await CloudStore.open(api), projectId, deckId)
    })
    When('Ana puts the cursor in the notes after "Mention"', () => {
      original = slideId()
      view = editorView('[data-testid="notes-editor"]')
      view.dispatch({ selection: { anchor: 'Mention'.length } })
      view.focus()
      expect(document.activeElement).toBe(view.contentDOM)
    })
    And('Budi copies the slide and moves Ana\'s slide after the copy', () => budiMovesTheSlide(original).then(() => {}))
    Then('the notes editor still has the focus, with the cursor after "Mention"', () => {
      expect(editorView('[data-testid="notes-editor"]')).toBe(view)
      expect(document.activeElement).toBe(view.contentDOM)
      expect(view.state.selection.main.head).toBe('Mention'.length)
    })
    When('Ana types " only"', async () => {
      view.dispatch(view.state.replaceSelection(' only'))
      await web.settle()
    })
    Then('Budi\'s deck has the notes "Mention only the cost." on Ana\'s slide', async () => {
      await vi.waitFor(() => expect(readDeckDoc(budi!.doc).slides.find(item => item.id === original)!.notes).toBe('Mention only the cost.'))
      expect(readDeckDoc(session().doc).slides.find(item => item.id === original)!.notes).toBe('Mention only the cost.')
    })
  })

  Scenario('Speaker notes are edited live with everyone else', ({ Given, And, Then, When }) => {
    let view: EditorView
    const budiNotes = () => readDeckDoc(budi!.doc).slides[0].notes
    Given('Ana has the deck "Flow" open in the Design view', () => openDeck('Flow'))
    And('Budi has the same deck open in another browser', async () => {
      budi = await openReady(await CloudStore.open(api), projectId, deckId)
    })
    Then('the inspector shows the speaker notes "Mention the cost."', () => {
      view = editorView('[data-testid="notes-editor"]')
      expect(view.state.doc.toString()).toBe('Mention the cost.')
      expect(view.contentDOM.getAttribute('aria-label')).toBe('Speaker notes')
    })
    When('Ana types " Twice." at the end of the notes', async () => {
      view.dispatch({ changes: { from: view.state.doc.length, insert: ' Twice.' } })
      await web.settle()
    })
    Then('Budi\'s deck has the notes "Mention the cost. Twice."', async () => {
      await vi.waitFor(() => expect(budiNotes()).toBe('Mention the cost. Twice.'))
    })
    When('Budi changes the notes to "Mention the cost first. Twice."', () => {
      setNotes(budi!.doc, readDeckDoc(budi!.doc).slides[0].id, 'Mention the cost first. Twice.', 'budi')
    })
    Then('Ana\'s notes editor shows "Mention the cost first. Twice."', async () => {
      await vi.waitFor(() => expect(view.state.doc.toString()).toBe('Mention the cost first. Twice.'))
    })
    When('Ana presses Control Z in the notes editor', () => key('z', { ctrl: true }, view.contentDOM))
    Then('the deck\'s notes say "Mention the cost first." again', () => {
      expect(readDeckDoc(session().doc).slides[0].notes).toBe('Mention the cost first.')
      expect(view.state.doc.toString()).toBe('Mention the cost first.')
    })
  })

  Scenario('A viewer sees the inspector, read only', ({ Given, Then, And, When }) => {
    Given('Budi shared the deck "Flow" with Ana as a viewer, and Ana opened it in the Design view', () => openShared('Flow'))
    Then('the inspector\'s settings cannot be changed, and there is no button to make a block movable', () => {
      expect(inspectorTitle()).toBe('Slide')
      expect((find('[data-testid="field-layout"]') as HTMLSelectElement).disabled).toBe(true)
      expect(field('class').readOnly).toBe(true)
      expect(findAll('[data-testid="raw-block"]')).toHaveLength(2)
      expect(find('[data-testid="make-movable"]')).toBeNull()
      expect(find('[data-testid="edit-raw"]')).toBeNull()
    })
    And('the notes editor cannot be typed in', () => {
      const view = editorView('[data-testid="notes-editor"]')
      expect(view.state.readOnly).toBe(true)
      expect(view.contentDOM.getAttribute('contenteditable')).toBe('false')
    })
    When('Ana clicks the box', () => select({ x: 700, y: 350 }))
    Then('the inspector shows the box\'s place, read only, with no buttons to order or delete it', () => {
      expect(inspectorTitle()).toBe('Rectangle')
      expect(field('x').value).toBe('600')
      expect(field('x').readOnly).toBe(true)
      expect((find('[data-testid="pick-fill"]') as HTMLInputElement).disabled).toBe(true)
      expect(find('[data-testid="stack-forward"]')).toBeNull()
      expect(find('[data-testid="delete-element"]')).toBeNull()
    })
  })

  Scenario('The inspector is read only while the assistant works', ({ Given, And, When, Then }) => {
    let finish: () => void
    Given('Ana has the deck "Shapes" open in the Design view, with the assistant on', () => openDeck('Shapes', { assistantOn: true }))
    And('Ana selected the rectangle', () => select(RECTANGLE))
    And('Claude takes a while before changing the deck', () => {
      assistant.holdChanges = new Promise((resolve) => {
        finish = resolve
      })
    })
    When('Ana asks the assistant "Add a slide about recursion"', async () => {
      await web.fill('[data-testid="assistant-input"]', 'Add a slide about recursion')
      await web.click('[data-testid="assistant-send"]')
    })
    Then('the inspector\'s fields cannot be changed, and it has no buttons to order or delete', async () => {
      expect(find('[data-testid="inspector"]')!.dataset.locked).toBe('true')
      expect(field('x').readOnly).toBe(true)
      expect(find('[data-testid="stack-forward"]')).toBeNull()
      expect(find('[data-testid="delete-element"]')).toBeNull()
      await enter('x', '300')
      expectPos('box', { x: 100 })
    })
    When('Claude finishes', async () => {
      finish()
      await vi.waitFor(() => expect(text('[data-testid="assistant-send"]')).toBe('Send'))
      await web.settle()
    })
    Then('the inspector\'s fields can be changed again', async () => {
      // The page shows the slide Claude added, so the inspector shows its settings.
      expect(find('[data-testid="inspector"]')!.dataset.locked).toBeUndefined()
      expect(inspectorTitle()).toBe('Slide')
      expect(field('class').readOnly).toBe(false)
      await enter('class', 'text-center')
      expect(slideFrontmatter()).toMatchObject({ class: 'text-center' })
    })
  })

  Scenario('Images come from the project\'s media library', ({ Given, And, When, Then }) => {
    let cat: string
    let image: string
    const fileButtons = () => findAll('[data-testid="media-file"]')
    Given('Ana is signed in, the server keeps media, and Ana\'s project has the images "cat.png" and "dog.png"', () => {
      media = new FakeMediaApi()
      images = ['cat.png', 'dog.png']
      useMediaLinks(media)
    })
    anaOpens(And)
    When('Ana asks for an image', () => web.click('[data-testid="add-image"]'))
    Then('the toolbar offers the link field and the project\'s images, newest first: "dog.png" and "cat.png"', async () => {
      expect(find('[data-testid="image-url"]')).not.toBeNull()
      await vi.waitFor(() => expect(fileButtons().map(item => item.textContent?.trim())).toEqual(['dog.png', 'cat.png']))
      cat = media!.files.find(file => file.name === 'cat.png')!.id
      // The pictures load through signed links too.
      await vi.waitFor(() => expect(fileButtons()[1].querySelector('img')?.getAttribute('src')).toMatch(/^https:\/\/storage\.example\//))
    })
    When('Ana picks "cat.png"', () => web.click(`[data-testid="media-file"][data-media-id="${cat}"]`))
    Then('the slide has an image of "cat.png" by its media address, described as "cat", selected', () => {
      const added = elements().at(-1)!
      image = added.id
      expect(added).toMatchObject({ type: 'image', src: mediaAddress(cat), alt: 'cat' })
      expect(selectedIds()).toEqual([image])
      expect(find('[data-testid="media-picker"]')).toBeNull()
    })
    And('the preview gets a signed link for that address, which needs no cookie', async () => {
      await vi.waitFor(() => expect(previewRequests.at(-1)!.slide.content).toContain(`src="${mediaAddress(cat)}"`))
      const shown = previewRequests.at(-1)!
      expect(Object.keys(shown.media ?? {})).toEqual([mediaAddress(cat)])
      expect(shown.media![mediaAddress(cat)]).toMatch(/^https:\/\/storage\.example\/media-\d+\?signature=\d+$/)
      expect(media!.linkRequests).toContain(cat)
    })
    When('Ana opens the project images in the inspector and uploads "blue-bird.png"', async () => {
      await web.click('[data-testid="choose-media"]')
      const input = await web.waitFor('[data-testid="media-upload-input"]') as HTMLInputElement
      Object.defineProperty(input, 'files', { configurable: true, value: [new File(['bird'], 'blue-bird.png', { type: 'image/png' })] })
      input.dispatchEvent(new Event('change'))
      await web.settle()
    })
    Then('the upload went to Ana\'s project, and the image now shows "blue-bird.png" by its media address, described as "blue bird"', () => {
      expect(media!.uploads).toEqual([{ projectId, name: 'blue-bird.png', type: 'image/png', size: 4 }])
      const bird = media!.files.find(file => file.name === 'blue-bird.png')!
      // The description of the cat would not fit the new picture.
      expect(element(image)).toMatchObject({ src: mediaAddress(bird.id), alt: 'blue bird' })
      expect(field('src').value).toBe(mediaAddress(bird.id))
      expect(field('alt').value).toBe('blue bird')
    })
    When('an upload fails because storage is full', async () => {
      media!.failUpload = 'This file does not fit in your 1 GB of storage, which has 0 MB left. Delete some files first.'
      await web.click('[data-testid="choose-media"]')
      const input = await web.waitFor('[data-testid="media-upload-input"]') as HTMLInputElement
      Object.defineProperty(input, 'files', { configurable: true, value: [new File(['fish'], 'fish.png', { type: 'image/png' })] })
      input.dispatchEvent(new Event('change'))
      await web.settle()
    })
    Then('the picker says why', () => {
      expect(text('[data-testid="media-problem"]')).toBe('This file does not fit in your 1 GB of storage, which has 0 MB left. Delete some files first.')
      expect(media!.files.map(file => file.name)).not.toContain('fish.png')
    })
  })

  Scenario('A deck in this browser offers only a link for images', ({ Given, When, Then }) => {
    Given('Ana has a deck "Shapes" in this browser, open in the Design view, and the server keeps media', async () => {
      const guest = await GuestStore.open(new MemoryGuestStorage())
      const project = await guest.createProject('Talks')
      const deck = await guest.createDeck(project.id, 'Shapes', 'blank')
      await guest.saveDeck(project.id, deck.id, fromMarkdown(SAMPLES.Shapes))
      projectId = project.id
      deckId = deck.id
      media = new FakeMediaApi()
      media.add(projectId, 'cat.png')
      web = await mountWebApp({ guest, media })
      await showDeck()
      await vi.waitFor(() => expect(stage().dataset.locked).toBeUndefined())
    })
    When('Ana asks for an image', () => web.click('[data-testid="add-image"]'))
    Then('the toolbar offers only the link field', () => {
      expect(find('[data-testid="image-url"]')).not.toBeNull()
      expect(find('[data-testid="media-picker"]')).toBeNull()
    })
    When('Ana adds an image of "https://example.com/cat.png" from the link field', async () => {
      await web.fill('[data-testid="image-url"]', 'https://example.com/cat.png')
      await web.submit('[data-testid="image-form"]')
    })
    Then('the inspector offers no project images for it', () => {
      expect(inspectorTitle()).toBe('Image')
      expect(find('[data-testid="choose-media"]')).toBeNull()
    })
  })

  Scenario('A deck on this device offers only a link for images, even when signed in', ({ Given, When, Then }) => {
    Given('Ana is signed in, the server keeps media, and Ana has a deck "Shapes" on this device, open in the Design view', async () => {
      const service = await signedIn()
      // Decks saved on this device have ids that start with "local-", as in the apps.
      let count = 0
      const device = await GuestStore.open(new MemoryGuestStorage(), { newId: () => `local-${++count}` })
      const project = await device.createProject('Talks')
      const deck = await device.createDeck(project.id, 'Shapes', 'blank')
      await device.saveDeck(project.id, deck.id, fromMarkdown(SAMPLES.Shapes))
      projectId = project.id
      deckId = deck.id
      media = new FakeMediaApi()
      media.add(projectId, 'cat.png')
      web = await mountWebApp({ service, api: new FakeProjectApi(), local: device, media })
      expect(web.account.account.value?.name).toBe('Ana')
      await showDeck()
      await vi.waitFor(() => expect(stage().dataset.locked).toBeUndefined())
    })
    When('Ana asks for an image', () => web.click('[data-testid="add-image"]'))
    Then('the toolbar offers only the link field', () => {
      expect(find('[data-testid="image-url"]')).not.toBeNull()
      expect(find('[data-testid="media-picker"]')).toBeNull()
    })
    When('Ana adds an image of "https://example.com/cat.png" from the link field', async () => {
      await web.fill('[data-testid="image-url"]', 'https://example.com/cat.png')
      await web.submit('[data-testid="image-form"]')
    })
    Then('the inspector offers no project images for it', () => {
      expect(inspectorTitle()).toBe('Image')
      expect(find('[data-testid="choose-media"]')).toBeNull()
    })
  })

  Scenario('Slide pictures in the strip load as they come into view, twelve at most', ({ Given, Then, When }) => {
    Given('Ana has a deck of 20 slides open in the Design view on a wide screen', async () => {
      screenIs({ wide: true })
      watchStrip()
      await openDeck('Twenty')
    })
    Then('the strip shows no slide pictures yet', () => {
      expect(pictured()).toEqual([])
      expect(findAll('[data-testid="strip-placeholder"]')).toHaveLength(20)
      expect(pictureRequests()).toEqual([])
      expect(watchedStripItems()).toHaveLength(20)
    })
    When('slides 1 to 3 of the strip come into view', async () => {
      stripInView(number => number <= 3)
      await web.settle()
    })
    Then('pictures of slides 1 to 3 show, each drawn in print mode with every click done', () => {
      expect(pictured()).toEqual([1, 2, 3])
      const requests = pictureRequests()
      expect(requests.map(request => request.slide.content.trim()).sort()).toEqual(['# Slide 1', '# Slide 2', '# Slide 3'])
      for (const request of requests)
        expect(request).toMatchObject({ mode: 'print', clicks: LAST_CLICKS })
      expect(requests.find(request => request.slide.content.includes('# Slide 1'))!.slide.first).toBe(true)
    })
    When('slides 1 to 16 are in view', async () => {
      stripInView(number => number <= 16)
      await web.settle()
    })
    Then('12 pictures show, for slides 1 to 12', () => {
      expect(pictured()).toEqual(range(1, 12))
    })
    When('Ana goes to slide 16', async () => {
      // Its picture, still waiting to load, takes Ana there like its title.
      findAll('[data-testid="strip-slide"]')[15].querySelector<HTMLElement>('[data-testid="strip-placeholder"]')!.click()
      await web.settle()
    })
    Then('12 pictures show, for slides 5 to 16', () => {
      expect(text('[data-testid="slide-position"]')).toBe('Slide 16 of 20')
      expect(pictured()).toEqual(range(5, 16))
    })
    When('slide 16 scrolls out of view', async () => {
      stripInView(number => number <= 15)
      await web.settle()
    })
    Then('its picture is gone, and slide 4 has one again', () => {
      expect(pictured()).toEqual(range(4, 15))
    })
    When('someone changes slide 5\'s title to "Five, edited"', async () => {
      budi = await openReady(await CloudStore.open(api), projectId, deckId)
      changeSlide(budi, 5, markdown => markdown.replace('# Slide 5', '# Five, edited'))
    })
    Then('slide 5\'s picture shows "Five, edited" once the change settles', async () => {
      await vi.waitFor(() => expect(text('[data-testid="strip-slide"]:nth-child(5) [data-testid="strip-title"]')).toBe('Five, edited'))
      await vi.waitFor(() => expect(pictureRequests().some(request => request.slide.content.includes('# Five, edited'))).toBe(true), { timeout: 3000 })
      expect(pictured()).toEqual(range(4, 15))
    })
  })

  Scenario('A narrow screen shows titles only in the strip', ({ Given, When, Then }) => {
    Given('Ana has a deck of 20 slides open in the Design view on a narrow screen', async () => {
      screenIs({ wide: false })
      watchStrip()
      await openDeck('Twenty')
    })
    When('slides 1 to 3 of the strip come into view', async () => {
      stripInView(number => number <= 3)
      await web.settle()
    })
    Then('the strip shows no slide pictures, only numbers and titles', () => {
      expect(pictured()).toEqual([])
      expect(findAll('[data-testid="strip-placeholder"]')).toEqual([])
      expect(watchedStripItems()).toEqual([])
      expect(strip().slice(0, 2)).toEqual(['1 Slide 1', '2 Slide 2'])
    })
  })

  Scenario('On a phone the inspector is a sheet at the bottom', ({ Given, Then, When }) => {
    const sheet = () => find('[data-testid="inspector"]')!
    const panelShown = () => find('[data-testid="inspector-panel"]')!.style.display !== 'none'
    Given('Ana has the deck "Shapes" open in the Design view on a phone', async () => {
      screenIs({ coarse: true, phone: true })
      await openDeck('Shapes')
    })
    Then('the inspector is a closed sheet whose bar says "Slide", with room for the bar at the end of the page', () => {
      expect(sheet().dataset.sheet).toBe('closed')
      expect(sheet().className).toContain('fixed')
      expect(text('[data-testid="inspector-toggle"]')).toContain('Slide')
      expect(panelShown()).toBe(false)
      // The end of the page has room for the bar, so the bar hides nothing there.
      const room = find('[data-testid="inspector-room"]')!
      expect(room.parentElement).toBe(document.body)
      expect(room.className).toBe('h-14')
    })
    When('Ana taps the rectangle', () => tap(RECTANGLE, { touch: true }))
    Then('the sheet\'s bar says "Rectangle", and the sheet stays closed', () => {
      expect(text('[data-testid="inspector-toggle"]')).toContain('Rectangle')
      expect(sheet().dataset.sheet).toBe('closed')
    })
    When('Ana opens the sheet', () => web.click('[data-testid="inspector-toggle"]'))
    Then('the sheet shows the rectangle\'s place and size', () => {
      expect(sheet().dataset.sheet).toBe('open')
      expect(panelShown()).toBe(true)
      expect(['x', 'y', 'w', 'h'].map(name => field(name).value)).toEqual(['100', '100', '200', '100'])
      expect(find('[data-testid="inspector-room"]')!.className).toBe('h-[55dvh]')
    })
    When('Ana closes the sheet and double taps the rectangle', async () => {
      await web.click('[data-testid="inspector-toggle"]')
      expect(sheet().dataset.sheet).toBe('closed')
      // Past a double tap with the first tap.
      await new Promise(resolve => setTimeout(resolve, 450))
      await tap(RECTANGLE, { touch: true })
      await tap(RECTANGLE, { touch: true })
    })
    Then('the sheet opens on the rectangle\'s settings', async () => {
      expect(sheet().dataset.sheet).toBe('open')
      expect(inspectorTitle()).toBe('Rectangle')
      expect(panelShown()).toBe(true)
      // The sheet takes the focus: a field would bring up the phone's keyboard.
      await vi.waitFor(() => expect(document.activeElement).toBe(find('[data-testid="inspector-panel"]')))
    })
  })
})
