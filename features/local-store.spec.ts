import type { Account } from '../apps/web/src/account/types'
import type { DeckSession } from '../apps/web/src/deck/session'
import type { AppPlatform, RenderedSlide, RenderRequestEvent } from '../apps/web/src/platform/native'
import type { CapturedSlide, RenderRequest } from '../apps/web/src/preview/protocol'
import type { WebApp } from './support/web'
import { resolve } from 'node:path'
import { describeFeature, loadFeature } from '@amiceli/vitest-cucumber'
import { expect, vi } from 'vitest'
import { defineComponent, h, watch } from 'vue'
import { LOCAL_ORIGIN, statusLabel } from '../apps/web/src/deck/session'
import { saveBeforeClosing } from '../apps/web/src/platform/closing'
import { startPlatform } from '../apps/web/src/platform/platform'
import { startRenderBridge } from '../apps/web/src/platform/render-bridge'
import { LAST_CLICKS } from '../apps/web/src/preview/protocol'
import { followMoves, LocalStore } from '../apps/web/src/projects/local-store'
import { deckMarkdown, moveSlide, readDeckDoc, splitSlides } from '../packages/deck-model/src'
import { FakeAccountService } from './support/account'
import { deckIdOf, FakeDeviceLibrary, projectIdOf } from './support/device-library'
import { resetEditorDoubles } from './support/editor-doubles'
import { changeSlide, openReady, slidesOf } from './support/live-decks'
import { FakeProjectApi } from './support/project-api'
import { find, findAll, mountWebApp, text } from './support/web'

interface FakeListener {
  event: string
  handler: (event: { event: string, id: number, payload: unknown }) => void
}

/** What the app's window hands a close handler: the window stays open if it calls `preventDefault`. */
type CloseHandler = (event: { preventDefault: () => void }) => Promise<void>

// A stand in for the Deyslide app: its commands, its events, its window and its dialog.
const fake = vi.hoisted(() => {
  const listeners: FakeListener[] = []
  const listen = async (event: string, handler: FakeListener['handler']) => {
    const listener = { event, handler }
    listeners.push(listener)
    return () => {
      const index = listeners.indexOf(listener)
      if (index >= 0)
        listeners.splice(index, 1)
    }
  }
  const closeHandlers: CloseHandler[] = []
  const onCloseRequested = async (handler: CloseHandler) => {
    closeHandlers.push(handler)
    return () => {
      const index = closeHandlers.indexOf(handler)
      if (index >= 0)
        closeHandlers.splice(index, 1)
    }
  }
  return { invoke: vi.fn(), listeners, listen, open: vi.fn(), ask: vi.fn(), closeHandlers, onCloseRequested, label: 'main' }
})

vi.mock('@tauri-apps/api/core', () => ({ invoke: fake.invoke }))
vi.mock('@tauri-apps/api/event', () => ({ listen: fake.listen }))
vi.mock('@tauri-apps/api/webviewWindow', () => ({
  getCurrentWebviewWindow: () => ({ label: fake.label, listen: fake.listen, onCloseRequested: fake.onCloseRequested }),
}))
// A dependency of apps/web only, so it is mocked by the file the pages load.
vi.mock('../apps/web/node_modules/@tauri-apps/plugin-dialog/dist-js/index.js', () => ({ open: fake.open, save: vi.fn(), ask: fake.ask }))

const feature = await loadFeature('./local-store.feature')

const SERVER = 'https://deyslide.bambanggunawan.id'
const ANA: Account = { id: 'user-ana', name: 'Ana', email: 'ana@example.com' }
/** How long the store waits after a change before it writes, in these scenarios. */
const WRITE_DELAY_MS = 20
/** Longer than a write takes to happen, with the watcher's report after it. */
const A_MOMENT_MS = 150

const SORTING = '---\ntitle: Sorting\n---\n\n# Sorting\n\n---\n\n# Bubble sort\n\n---\n\n# Insertion sort\n'
const LOOSE_SORTING = '---\ntitle: Sorting\n---\n\n\n# Sorting\n\n\n\n---\n\n# Bubble sort\n\n\n---\n\n# Insertion sort\n\n\n'
const BROKEN_SORTING = '---\ntitle: [broken\n---\n\n# Sorting\n\n---\n\n# Bubble sort\n\n---\n\n# Insertion sort\n'
/** What the session says about BROKEN_SORTING: the error, then where the YAML reader found it. */
const BROKEN_SAID = /^Not saved: The file on disk has an error: The frontmatter is not valid YAML\. Slide 1: \S/

/** A slide's content (counted from 1), as Slidev reads it. */
const slideText = (markdown: string, number: number) => splitSlides(markdown)[number - 1]?.content.trim()

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

describeFeature(feature, ({ Scenario, ScenarioOutline, BeforeEachScenario, AfterEachScenario }) => {
  let library: FakeDeviceLibrary
  let store: LocalStore | undefined
  let session: DeckSession | undefined
  let web: WebApp | undefined
  let api: FakeProjectApi
  let service: FakeAccountService
  let platform: AppPlatform | undefined
  let stopBridge: (() => void) | undefined
  let stopFollowing: (() => void) | undefined
  /** `render_ready` and `render_respond` calls, and what the bridge frame drew, in order. */
  let timeline: string[]
  let responses: { id: string, slides: RenderedSlide[] }[]
  let readyCalls: boolean[]
  let drawn: RenderRequest[]
  /** Slides the bridge frame fails to draw, by their content, with the error. */
  let frameFailures: Map<string, string>
  /** Bridge frames mounted so far, and how the box each one drew in looked at the time. */
  let frames: number
  let frameBoxes: Record<string, string | boolean>[]
  let stopClosing: (() => void) | undefined
  let mainStarts = 0

  function emit(event: string, payload: unknown) {
    for (const listener of fake.listeners.filter(item => item.event === event))
      listener.handler({ event, id: 1, payload })
  }

  BeforeEachScenario(() => {
    fake.listeners.length = 0
    fake.closeHandlers.length = 0
    fake.label = 'main'
    fake.open.mockReset()
    fake.ask.mockReset()
    library = new FakeDeviceLibrary(emit)
    api = new FakeProjectApi()
    service = new FakeAccountService()
    platform = undefined
    timeline = []
    responses = []
    readyCalls = []
    drawn = []
    frameFailures = new Map()
    frames = 0
    frameBoxes = []
    fake.invoke.mockReset()
    fake.invoke.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      if (library.handles(command))
        return library.invoke(command, args)
      switch (command) {
        case 'app_info':
          if (!platform)
            throw new Error('app_info is not available')
          return { version: '0.2.0', platform, serverUrl: SERVER }
        case 'auth_account':
          return null
        case 'auth_access_token':
          throw 'You are signed out.'
        case 'render_ready':
          readyCalls.push(Boolean(args?.ready))
          timeline.push(`ready ${args?.ready}`)
          return undefined
        case 'render_respond': {
          const answer = args as unknown as { id: string, slides: RenderedSlide[] }
          responses.push(answer)
          timeline.push(`answer ${answer.id}`)
          return undefined
        }
      }
      throw new Error(`The fake app has no command ${command}`)
    })
  })

  AfterEachScenario(() => {
    stopFollowing?.()
    stopFollowing = undefined
    stopClosing?.()
    stopClosing = undefined
    stopBridge?.()
    stopBridge = undefined
    session?.close()
    session = undefined
    web?.unmount()
    web = undefined
    store?.close()
    store = undefined
    const root = document.querySelector('#app') as (HTMLElement & { __vue_app__?: { unmount: () => void } }) | null
    root?.__vue_app__?.unmount()
    root?.remove()
    resetEditorDoubles()
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
  })

  async function inApp(where: AppPlatform) {
    vi.stubEnv('VITE_APP', '1')
    platform = where
    await startPlatform()
  }

  async function openStore(writeDelayMs = WRITE_DELAY_MS) {
    store = await LocalStore.open({ writeDelayMs })
    return store
  }

  const talks = () => store!.listProjects().find(project => project.name === 'Talks')!
  const sortingId = () => deckIdOf('Talks', 'Sorting')
  const said = () => statusLabel(session!.status.value, session!.error.value)

  async function openSorting(content = SORTING) {
    library.put('Talks', 'Sorting', content)
    await openStore()
    session = await openReady(store!, projectIdOf('Talks'), sortingId())
  }

  /** Opens the app's pages at `path`, as main.ts would with the device store. */
  async function openPage(path: string, { view, writeDelayMs }: { view?: 'markdown', writeDelayMs?: number } = {}) {
    if (!platform)
      await inApp('linux')
    store ??= await openStore(writeDelayMs)
    web = await mountWebApp({ path, service, api, local: store, view })
    stopFollowing = followMoves(store, web.router)
  }

  /** Opens the deck page of "Sorting" in "Talks", in the Markdown view, once the editor shows the deck. */
  async function openSortingPage(options: { writeDelayMs?: number } = {}) {
    library.put('Talks', 'Sorting', SORTING)
    await openPage(`/p/${projectIdOf('Talks')}/d/${sortingId()}`, { view: 'markdown', ...options })
    await vi.waitFor(() => expect(editorText()).toContain('# Bubble sort'))
  }

  const editorText = () => (find('[data-testid="markdown-editor"]') as HTMLTextAreaElement | null)?.value

  /** Types in the Markdown view, through the editor double. */
  function typeInEditor(change: (text: string) => string) {
    const editor = find('[data-testid="markdown-editor"]') as HTMLTextAreaElement
    editor.value = change(editor.value)
    editor.dispatchEvent(new Event('input'))
  }

  /** Waits until the Markdown view's typing is in the deck. */
  async function typedIntoDeck(slide: number, heading: string) {
    await vi.waitFor(async () => expect(slideText(await store!.deckMarkdown(sortingId()), slide)).toBe(heading))
  }

  async function goToProject() {
    await web!.router.push({ name: 'project', params: { projectId: projectIdOf('Talks') } })
    await web!.settle()
  }

  /** Closes the app's window the way Tauri does: it closes unless a close handler keeps it open. */
  async function closeWindow() {
    let open = false
    for (const handler of [...fake.closeHandlers]) {
      await handler({
        preventDefault: () => {
          open = true
        },
      })
    }
    return !open
  }

  async function submitName(name: string) {
    await web!.fill('[data-testid="name-input"]', name)
    await web!.click('[data-testid="name-submit"]')
  }

  const sectionNames = (key: string) => findAll(`[data-section="${key}"] [data-project]`).map(link => link.dataset.project)
  const deckNames = () => findAll('[data-deck]').map(link => link.dataset.deck)
  const listed = (project: string) => store!.listProjects().find(item => item.name === project)?.decks.map(deck => [deck.name, deck.slideCount])

  /**
   * A double of the preview frame for the render bridge: it draws after a
   * moment, or fails. Its own name keeps it clear of the page specs' stub
   * for SlidePreviewFrame.
   */
  const BridgeFrameDouble = defineComponent({
    name: 'BridgeFrameDouble',
    props: { request: { type: Object, default: undefined } },
    emits: ['rendered', 'error'],
    setup(props, { emit: send, expose }) {
      const frame = ++frames
      let shown: RenderRequest | undefined
      expose({
        capture: async (): Promise<CapturedSlide> => ({
          png: new TextEncoder().encode(`png of ${shown?.slide.content.trim()}`).buffer,
          overflow: false,
        }),
      })
      watch(() => props.request as RenderRequest | undefined, (request) => {
        if (!request)
          return
        shown = request
        drawn.push(JSON.parse(JSON.stringify(request)) as RenderRequest)
        timeline.push(`draw ${request.id} in frame ${frame}`)
        const box = document.querySelector<HTMLElement>('[data-testid="render-bridge"]')!
        frameBoxes.push({
          inWindow: box.parentElement === document.body,
          position: box.style.position,
          left: box.style.left,
          top: box.style.top,
          width: box.style.width,
          height: box.style.height,
          opacity: box.style.opacity,
          pointerEvents: box.style.pointerEvents,
          zIndex: box.style.zIndex,
        })
        setTimeout(() => {
          const failure = frameFailures.get(request.slide.content.trim())
          if (failure)
            send('error', failure)
          else
            send('rendered', { id: request.id, clicks: 2 })
        }, 10)
      }, { immediate: true })
      return () => h('div', { 'data-testid': 'preview-frame' })
    },
  })

  async function listenForRenders() {
    stopBridge = await startRenderBridge({ frame: BridgeFrameDouble })
  }

  function askForSlides(id: string, markdown: string, numbers: number[]) {
    const event: RenderRequestEvent = { id, markdown, slides: numbers.map(number => ({ number, clicks: 'last' })), width: 1280, height: 720 }
    emit('render-request', event)
  }

  const decoded = (png?: string) => png === undefined ? undefined : Buffer.from(png, 'base64').toString()

  // Listing ------------------------------------------------------------------

  Scenario('The library folder\'s projects and decks are listed', ({ Given, When, Then, And }) => {
    Given('the library holds the project "Talks" with the deck "Sorting" of 3 slides', () => {
      library.put('Talks', 'Sorting', SORTING)
    })
    When('the app lists the library', async () => {
      await openStore()
    })
    Then('the store lists "Talks" with the deck "Sorting" of 3 slides', () => {
      expect(listed('Talks')).toEqual([['Sorting', 3]])
    })
    And('the project and deck ids start with "local-"', () => {
      expect(talks().id).toBe(projectIdOf('Talks'))
      expect(talks().id.startsWith('local-')).toBe(true)
      expect(talks().decks[0].id.startsWith('local-')).toBe(true)
    })
    When('Claude Code adds the deck "Graphs" to "Talks" on disk', () => {
      library.put('Talks', 'Graphs', '# Graphs\n')
    })
    Then('the store lists "Talks" with the decks "Graphs" and "Sorting" without being asked', async () => {
      await vi.waitFor(() => expect(listed('Talks')).toEqual([['Graphs', 1], ['Sorting', 3]]))
    })
  })

  // An open deck and its file -------------------------------------------------

  Scenario('Opening a deck reads its file and writes nothing', ({ Given, When, Then, And }) => {
    Given('the library holds the project "Talks" with the deck "Sorting" of 3 slides, written with extra blank lines', () => {
      library.put('Talks', 'Sorting', LOOSE_SORTING)
    })
    When('the deck "Sorting" is opened', async () => {
      await openStore()
      session = await openReady(store!, projectIdOf('Talks'), sortingId())
    })
    Then('the session is ready and says "Saved"', () => {
      expect(session!.ready.value).toBe(true)
      expect(said()).toBe('Saved')
    })
    And('it shows the 3 slides of the file', () => {
      expect(slidesOf(session!.doc).map(slide => slide.trim())).toEqual(['---\ntitle: Sorting\n---\n\n# Sorting', '# Bubble sort', '# Insertion sort'])
      // Deyslide writes the deck without the extra lines, which would be a change of the file's text alone.
      expect(deckMarkdown(session!.doc)).not.toBe(LOOSE_SORTING)
    })
    And('after a moment the app has written nothing', async () => {
      await wait(A_MOMENT_MS)
      expect(library.writes).toEqual([])
      expect(library.read('Talks', 'Sorting')).toBe(LOOSE_SORTING)
    })
  })

  Scenario('A change in the app is written to the file a moment later', ({ Given, When, Then, And }) => {
    Given('the deck "Sorting" of 3 slides is open', () => openSorting())
    When('the person changes the title of slide 2 to "Merge sort"', () => {
      changeSlide(session!, 2, markdown => markdown.replace('# Bubble sort', '# Merge sort'))
    })
    Then('the session says "Saving..."', () => {
      expect(said()).toBe('Saving...')
    })
    And('a moment later the file shows "# Merge sort" on slide 2', async () => {
      await vi.waitFor(() => expect(slideText(library.read('Talks', 'Sorting')!, 2)).toBe('# Merge sort'))
    })
    And('the app wrote it over the text it had read', () => {
      expect(library.writes).toHaveLength(1)
      expect(library.writes[0]).toMatchObject({ id: sortingId(), expected: SORTING, written: true })
    })
    And('the session says "Saved"', async () => {
      await vi.waitFor(() => expect(said()).toBe('Saved'))
    })
  })

  Scenario('A change undone before the write writes nothing', ({ Given, When, Then, And }) => {
    Given('the deck "Sorting" of 3 slides is open', () => openSorting())
    When('the person changes the title of slide 2 to "Merge sort" and undoes it at once', () => {
      changeSlide(session!, 2, markdown => markdown.replace('# Bubble sort', '# Merge sort'))
      session!.undoStep()
      expect(slideText(deckMarkdown(session!.doc), 2)).toBe('# Bubble sort')
    })
    Then('after a moment the app has written nothing', async () => {
      await wait(A_MOMENT_MS)
      expect(library.writes).toEqual([])
    })
    And('the session says "Saved"', () => {
      expect(said()).toBe('Saved')
    })
  })

  Scenario('A file change that lands between an edit and its write keeps both', ({ Given, When, Then, And }) => {
    Given('the deck "Sorting" of 3 slides is open', () => openSorting())
    And('the library holds back its reports of changes', async () => {
      // Let the report of the first file go, so only later changes wait.
      await wait(A_MOMENT_MS)
      library.holdReports = true
    })
    When('the person changes the title of slide 1 to "Sorting algorithms"', () => {
      changeSlide(session!, 1, markdown => markdown.replace('# Sorting', '# Sorting algorithms'))
    })
    And('Claude Code changes slide 3 on disk to "# Heap sort" before the app writes', () => {
      expect(library.writes).toEqual([])
      library.put('Talks', 'Sorting', SORTING.replace('# Insertion sort', '# Heap sort'))
    })
    Then('the app\'s first write is refused, because the file changed', async () => {
      await vi.waitFor(() => expect(library.writes.length).toBeGreaterThanOrEqual(2))
      expect(library.writes[0]).toMatchObject({ expected: SORTING, written: false })
      expect(library.writes[1]).toMatchObject({ expected: SORTING.replace('# Insertion sort', '# Heap sort'), written: true })
    })
    And('the file then shows "# Sorting algorithms" on slide 1 and "# Heap sort" on slide 3', () => {
      const file = library.read('Talks', 'Sorting')!
      expect(slideText(file, 1)).toBe('# Sorting algorithms')
      expect(slideText(file, 2)).toBe('# Bubble sort')
      expect(slideText(file, 3)).toBe('# Heap sort')
    })
    And('the open deck shows both changes', async () => {
      await vi.waitFor(() => expect(said()).toBe('Saved'))
      expect(deckMarkdown(session!.doc)).toBe(library.read('Talks', 'Sorting'))
    })
    When('the library reports its changes', () => {
      library.holdReports = false
      library.report()
    })
    Then('after a moment the app has written nothing more', async () => {
      await wait(A_MOMENT_MS)
      expect(library.writes).toHaveLength(2)
    })
  })

  Scenario('A slide moved in the app and on disk at once is written once', ({ Given, When, Then, And }) => {
    const MOVED = '---\ntitle: Sorting\n---\n\n# Sorting\n\n---\n\n# Insertion sort\n\n---\n\n# Bubble sort\n'
    const headings = (markdown: string) => splitSlides(markdown).map(slide => slide.content.trim())
    Given('the deck "Sorting" of 3 slides is open', () => openSorting())
    When('the person moves slide 3 up to slide 2', () => {
      const insertion = readDeckDoc(session!.doc).slides[2]!.id
      session!.transact(() => moveSlide(session!.doc, insertion, 1, LOCAL_ORIGIN))
    })
    And('Claude Code makes the same move on disk before the app writes', () => {
      let once = true
      library.beforeWrite = () => {
        if (once)
          library.put('Talks', 'Sorting', MOVED)
        once = false
      }
    })
    Then('the file then holds "# Sorting", "# Insertion sort" and "# Bubble sort", each once', async () => {
      await vi.waitFor(() => expect(said()).toBe('Saved'))
      await wait(A_MOMENT_MS)
      expect(headings(library.read('Talks', 'Sorting')!)).toEqual(['# Sorting', '# Insertion sort', '# Bubble sort'])
    })
    And('the open deck holds them each once too', () => {
      expect(headings(deckMarkdown(session!.doc))).toEqual(['# Sorting', '# Insertion sort', '# Bubble sort'])
      const ids = readDeckDoc(session!.doc).slides.map(slide => slide.id)
      expect(new Set(ids).size).toBe(3)
    })
  })

  Scenario('A change Claude Code makes on disk shows up in the open deck', ({ Given, When, Then, And }) => {
    Given('the deck "Sorting" of 3 slides is open', () => openSorting())
    When('Claude Code changes slide 2 on disk to "# Quick sort"', () => {
      library.put('Talks', 'Sorting', SORTING.replace('# Bubble sort', '# Quick sort'))
    })
    Then('the open deck shows "# Quick sort" on slide 2 without being opened again', async () => {
      await vi.waitFor(() => expect(slideText(deckMarkdown(session!.doc), 2)).toBe('# Quick sort'))
      expect(said()).toBe('Saved')
    })
    And('after a moment the app has written nothing', async () => {
      await wait(A_MOMENT_MS)
      expect(library.writes).toEqual([])
    })
  })

  Scenario('A file on disk that has an error is never overwritten', ({ Given, When, Then, And }) => {
    Given('the deck "Sorting" of 3 slides is open', () => openSorting())
    When('Claude Code writes the deck\'s file with frontmatter that is not valid YAML', () => {
      library.put('Talks', 'Sorting', BROKEN_SORTING)
    })
    Then('the session says "Not saved: The file on disk has an error: The frontmatter is not valid YAML." and where on slide 1', async () => {
      await vi.waitFor(() => expect(said()).toMatch(BROKEN_SAID))
      expect(session!.status.value).toBe('failed')
    })
    When('the person changes the title of slide 2 to "Merge sort"', () => {
      changeSlide(session!, 2, markdown => markdown.replace('# Bubble sort', '# Merge sort'))
    })
    Then('after a moment the app has written nothing', async () => {
      await wait(A_MOMENT_MS)
      expect(library.writes).toEqual([])
    })
    And('the file still holds the text with the error', () => {
      expect(library.read('Talks', 'Sorting')).toBe(BROKEN_SORTING)
    })
    When('Claude Code fixes the file on disk, with "# Heap sort" on slide 3', () => {
      library.put('Talks', 'Sorting', SORTING.replace('# Insertion sort', '# Heap sort'))
    })
    Then('the session says "Saved"', async () => {
      await vi.waitFor(() => expect(said()).toBe('Saved'))
    })
    And('the file shows "# Merge sort" on slide 2 and "# Heap sort" on slide 3', () => {
      const file = library.read('Talks', 'Sorting')!
      expect(slideText(file, 2)).toBe('# Merge sort')
      expect(slideText(file, 3)).toBe('# Heap sort')
      expect(library.writes).toHaveLength(1)
      expect(library.writes[0]).toMatchObject({ expected: SORTING.replace('# Insertion sort', '# Heap sort'), written: true })
    })
  })

  Scenario('A change made while the file on disk has an error is written once it is fixed, even after leaving the deck', ({ Given, And, When, Then }) => {
    Given('the deck page of "Sorting" in "Talks" is open in the app', () => openSortingPage())
    And('Claude Code writes the deck\'s file with frontmatter that is not valid YAML', async () => {
      library.put('Talks', 'Sorting', BROKEN_SORTING)
      await vi.waitFor(() => expect(text('[data-testid="save-status"]')).toMatch(BROKEN_SAID))
    })
    When('the person changes the title of slide 2 to "Merge sort" in the Markdown view', async () => {
      typeInEditor(markdown => markdown.replace('# Bubble sort', '# Merge sort'))
      await typedIntoDeck(2, '# Merge sort')
    })
    And('they go back to the project', async () => {
      await goToProject()
      expect(web!.router.currentRoute.value.name).toBe('project')
    })
    Then('the file still holds the text with the error', async () => {
      await wait(A_MOMENT_MS)
      expect(library.read('Talks', 'Sorting')).toBe(BROKEN_SORTING)
      expect(library.writes).toEqual([])
    })
    When('Claude Code fixes the file on disk, with "# Heap sort" on slide 3', () => {
      library.put('Talks', 'Sorting', SORTING.replace('# Insertion sort', '# Heap sort'))
    })
    Then('the file shows "# Merge sort" on slide 2 and "# Heap sort" on slide 3', async () => {
      await vi.waitFor(() => expect(slideText(library.read('Talks', 'Sorting')!, 2)).toBe('# Merge sort'))
      expect(slideText(library.read('Talks', 'Sorting')!, 3)).toBe('# Heap sort')
      expect(library.writes).toMatchObject([{ expected: SORTING.replace('# Insertion sort', '# Heap sort'), written: true }])
    })
    And('the deck "Sorting" opens again with both changes', async () => {
      session = await openReady(store!, projectIdOf('Talks'), sortingId())
      expect(deckMarkdown(session.doc)).toBe(library.read('Talks', 'Sorting'))
      expect(said()).toBe('Saved')
    })
  })

  Scenario('A write that fails is tried again on its own', ({ Given, And, When, Then }) => {
    const seen: string[] = []
    let stopWatching = () => {}
    Given('the deck "Sorting" of 3 slides is open', async () => {
      await openSorting()
      stopWatching = watch(said, label => seen.push(label), { flush: 'sync' })
    })
    And('the next 2 writes to the file fail with "The disk is full."', () => {
      library.failNextWrites(2, 'The disk is full.')
    })
    When('the person changes the title of slide 2 to "Merge sort"', () => {
      changeSlide(session!, 2, markdown => markdown.replace('# Bubble sort', '# Merge sort'))
    })
    Then('the session said "Not saved: The disk is full."', async () => {
      await vi.waitFor(() => expect(seen).toContain('Not saved: The disk is full.'))
    })
    And('a moment later, with nothing else changed, the file shows "# Merge sort" on slide 2', async () => {
      await vi.waitFor(() => expect(slideText(library.read('Talks', 'Sorting')!, 2)).toBe('# Merge sort'))
      expect(library.writes).toMatchObject([{ expected: SORTING, written: true }])
    })
    And('the session says "Saved"', async () => {
      await vi.waitFor(() => expect(said()).toBe('Saved'))
      stopWatching()
    })
  })

  Scenario('A change is written once the file stops changing, however often it changed before', ({ Given, And, When, Then }) => {
    Given('the deck "Sorting" of 3 slides is open', () => openSorting())
    And('Claude Code changes slide 3 on disk just before each of the app\'s next 5 writes', () => {
      let changes = 0
      library.beforeWrite = () => {
        if (changes >= 5)
          return
        changes++
        const file = library.read('Talks', 'Sorting')!
        library.put('Talks', 'Sorting', file.replace(/# (Insertion sort|Heap sort \d+)\n$/, `# Heap sort ${changes}\n`))
      }
    })
    When('the person changes the title of slide 1 to "Sorting algorithms"', () => {
      changeSlide(session!, 1, markdown => markdown.replace('# Sorting', '# Sorting algorithms'))
    })
    Then('a moment later, with nothing else changed, the file shows "# Sorting algorithms" on slide 1 and "# Heap sort 5" on slide 3', async () => {
      await vi.waitFor(() => expect(slideText(library.read('Talks', 'Sorting')!, 1)).toBe('# Sorting algorithms'))
      expect(slideText(library.read('Talks', 'Sorting')!, 3)).toBe('# Heap sort 5')
      // Five writes found the file changed; the one after them went through.
      expect(library.writes.map(write => write.written)).toEqual([false, false, false, false, false, true])
    })
    And('the session says "Saved"', async () => {
      await vi.waitFor(() => expect(said()).toBe('Saved'))
      expect(deckMarkdown(session!.doc)).toBe(library.read('Talks', 'Sorting'))
    })
  })

  Scenario('A deck file with an error opens once the file is fixed', ({ Given, When, Then, And }) => {
    Given('the library holds the project "Talks" with the deck "Sorting" whose frontmatter is not valid YAML', () => {
      library.put('Talks', 'Sorting', BROKEN_SORTING)
    })
    When('the deck "Sorting" is opened', async () => {
      await openStore()
      session = await store!.openDeck(projectIdOf('Talks'), sortingId())
    })
    Then('the session is not ready and says "Not saved: The file on disk has an error: The frontmatter is not valid YAML." and where on slide 1', () => {
      expect(session!.ready.value).toBe(false)
      expect(session!.readOnly.value).toBe(true)
      expect(said()).toMatch(BROKEN_SAID)
    })
    When('Claude Code fixes the file on disk, with "# Heap sort" on slide 3', () => {
      library.put('Talks', 'Sorting', SORTING.replace('# Insertion sort', '# Heap sort'))
    })
    Then('the session is ready and says "Saved"', async () => {
      await vi.waitFor(() => expect(session!.ready.value).toBe(true))
      expect(said()).toBe('Saved')
      expect(slideText(deckMarkdown(session!.doc), 3)).toBe('# Heap sort')
    })
    And('after a moment the app has written nothing', async () => {
      await wait(A_MOMENT_MS)
      expect(library.writes).toEqual([])
    })
  })

  // Pages ---------------------------------------------------------------------

  Scenario('A deck renamed on disk says so on its page', ({ Given, When, Then, And }) => {
    Given('the deck page of "Sorting" in "Talks" is open in the app', async () => {
      library.put('Talks', 'Sorting', SORTING)
      await openPage(`/p/${projectIdOf('Talks')}/d/${sortingId()}`, { view: 'markdown' })
      await vi.waitFor(() => expect((find('[data-testid="markdown-editor"]') as HTMLTextAreaElement | null)?.value).toContain('# Bubble sort'))
    })
    When('the file "Sorting.md" is renamed to "Sorting v2.md" on disk', () => {
      library.renameOnDisk('Talks', 'Sorting', 'Sorting v2')
    })
    Then('the page says "Not saved: This deck was moved or renamed on disk."', async () => {
      await vi.waitFor(() => expect(text('[data-testid="save-status"]')).toBe('Not saved: This deck was moved or renamed on disk.'))
    })
    And('the deck can no longer be edited on that page', () => {
      const editor = find('[data-testid="markdown-editor"]') as HTMLTextAreaElement
      expect(editor.readOnly).toBe(true)
      // What it showed stays on screen.
      expect(editor.value).toContain('# Bubble sort')
    })
    And('the store lists "Talks" with the decks "Sorting v2" and "Sorting" while the page stays open', () => {
      expect(listed('Talks')).toEqual([['Sorting v2', 3], ['Sorting', 3]])
    })
    When('they go back to the project', async () => {
      await web!.router.push({ name: 'project', params: { projectId: projectIdOf('Talks') } })
      await web!.settle()
    })
    Then('the store lists "Talks" with the deck "Sorting v2" of 3 slides', async () => {
      await vi.waitFor(() => expect(listed('Talks')).toEqual([['Sorting v2', 3]]))
      await vi.waitFor(() => expect(deckNames()).toEqual(['Sorting v2']))
      expect(library.writes).toEqual([])
    })
  })

  Scenario('A change made just before the deck was renamed on disk stays in the app until the deck is deleted', ({ Given, And, When, Then }) => {
    Given('the deck page of "Sorting" in "Talks" is open in the app', () => openSortingPage({ writeDelayMs: 60_000 }))
    And('the person changes the title of slide 2 to "Merge sort"', async () => {
      typeInEditor(markdown => markdown.replace('# Bubble sort', '# Merge sort'))
      await typedIntoDeck(2, '# Merge sort')
    })
    When('the file "Sorting.md" is renamed to "Sorting v2.md" on disk before the change is written', () => {
      expect(library.writes).toEqual([])
      library.renameOnDisk('Talks', 'Sorting', 'Sorting v2')
    })
    Then('the page says "Not saved: This deck was moved or renamed on disk."', async () => {
      await vi.waitFor(() => expect(text('[data-testid="save-status"]')).toBe('Not saved: This deck was moved or renamed on disk.'))
    })
    When('they go back to the project', goToProject)
    Then('the page lists the decks "Sorting v2" and "Sorting"', async () => {
      await vi.waitFor(() => expect(deckNames()).toEqual(['Sorting v2', 'Sorting']))
    })
    When('they open the deck "Sorting" again', async () => {
      await web!.router.push({ name: 'deck', params: { projectId: projectIdOf('Talks'), deckId: sortingId() } })
      await web!.settle()
    })
    Then('it shows "# Merge sort" on slide 2, ready to download', async () => {
      await vi.waitFor(() => expect(editorText()).toContain('# Merge sort'))
      expect(text('[data-testid="save-status"]')).toBe('Not saved: This deck was moved or renamed on disk.')
      expect((find('[data-testid="download-markdown"]') as HTMLButtonElement).disabled).toBe(false)
    })
    When('they go back to the project and delete the deck "Sorting"', async () => {
      await goToProject()
      const item = (await web!.waitFor('[data-deck="Sorting"]')).closest('li')!
      const remove = [...item.querySelectorAll('button')].find(button => button.textContent?.trim() === 'Delete')!
      remove.click()
      await web!.settle()
      await web!.click('[data-testid="confirm-action"]')
    })
    Then('the page lists only the deck "Sorting v2"', async () => {
      await vi.waitFor(() => expect(deckNames()).toEqual(['Sorting v2']))
    })
    And('nothing went to the trash and no file was written', () => {
      expect(library.trash).toEqual([])
      expect(library.writes).toEqual([])
      expect(listed('Talks')).toEqual([['Sorting v2', 3]])
      expect(slideText(library.read('Talks', 'Sorting v2')!, 2)).toBe('# Bubble sort')
    })
  })

  Scenario('Closing the window writes the last change first', ({ Given, And, When, Then }) => {
    let closed: boolean | undefined
    Given('the deck page of "Sorting" in "Talks" is open in the app\'s main window on a computer', async () => {
      // Writing waits long here, so closing is what writes the change.
      await openSortingPage({ writeDelayMs: 60_000 })
      stopClosing = await saveBeforeClosing(store!)
    })
    And('the person changes the title of slide 2 to "Merge sort" in the Markdown view', () => {
      // The Markdown view still holds the typing: it merges a moment later.
      typeInEditor(markdown => markdown.replace('# Bubble sort', '# Merge sort'))
    })
    When('they close the window at once', async () => {
      closed = await closeWindow()
    })
    Then('the file shows "# Merge sort" on slide 2', () => {
      expect(slideText(library.read('Talks', 'Sorting')!, 2)).toBe('# Merge sort')
      expect(library.writes).toMatchObject([{ expected: SORTING, written: true }])
    })
    And('the window closed without a question', () => {
      expect(closed).toBe(true)
      expect(fake.ask).not.toHaveBeenCalled()
    })
  })

  Scenario('Closing the window with a change the file cannot take asks first', ({ Given, And, When, Then }) => {
    let answer: ((close: boolean) => void) | undefined
    let closing: Promise<boolean> | undefined
    let closed: boolean | undefined
    Given('the deck page of "Sorting" in "Talks" is open in the app\'s main window on a computer', async () => {
      await openSortingPage()
      stopClosing = await saveBeforeClosing(store!)
      fake.ask.mockImplementation(() => new Promise<boolean>((resolve) => {
        answer = resolve
      }))
    })
    And('Claude Code writes the deck\'s file with frontmatter that is not valid YAML', async () => {
      library.put('Talks', 'Sorting', BROKEN_SORTING)
      await vi.waitFor(() => expect(text('[data-testid="save-status"]')).toMatch(BROKEN_SAID))
    })
    And('the person changes the title of slide 2 to "Merge sort" in the Markdown view', async () => {
      typeInEditor(markdown => markdown.replace('# Bubble sort', '# Merge sort'))
      await typedIntoDeck(2, '# Merge sort')
    })
    When('they close the window', () => {
      closing = closeWindow()
    })
    Then('the app asks "Your last changes to Sorting could not be saved yet. The deck\'s page says why."', async () => {
      await vi.waitFor(() => expect(fake.ask).toHaveBeenCalledTimes(1))
      expect(fake.ask).toHaveBeenCalledWith(
        'Your last changes to Sorting could not be saved yet. The deck\'s page says why.',
        expect.objectContaining({ title: 'Close without your changes?', okLabel: 'Close without them', cancelLabel: 'Keep open' }),
      )
    })
    When('they choose "Keep open"', async () => {
      answer!(false)
      closed = await closing
    })
    Then('the window stays open, with the change still on the page', () => {
      expect(closed).toBe(false)
      expect(editorText()).toContain('# Merge sort')
      expect(library.read('Talks', 'Sorting')).toBe(BROKEN_SORTING)
    })
    When('they close the window again and choose "Close without them"', async () => {
      closing = closeWindow()
      await vi.waitFor(() => expect(fake.ask).toHaveBeenCalledTimes(2))
      answer!(true)
      closed = await closing
    })
    Then('the window closes', () => {
      expect(closed).toBe(true)
      expect(library.writes).toEqual([])
    })
  })

  Scenario('Closing the window asks first when the Markdown view holds typing back', ({ Given, And, When, Then }) => {
    let closing: Promise<boolean> | undefined
    Given('the deck page of "Sorting" in "Talks" is open in the app\'s main window on a computer', async () => {
      await openSortingPage()
      stopClosing = await saveBeforeClosing(store!)
      fake.ask.mockResolvedValue(false)
    })
    And('Claude Code writes the deck\'s file with frontmatter that is not valid YAML', async () => {
      library.put('Talks', 'Sorting', BROKEN_SORTING)
      await vi.waitFor(() => expect(text('[data-testid="save-status"]')).toMatch(BROKEN_SAID))
    })
    And('the person types "lost unless kept" just under the second slide\'s separator, which the Markdown view cannot take', async () => {
      typeInEditor(markdown => markdown.replace('---\n\n# Bubble sort', '---\nlost unless kept\n\n# Bubble sort'))
      // The Markdown view says why it holds the line back, and the deck goes without it.
      await vi.waitFor(() => expect(text('[data-testid="markdown-problem"]')).toContain('frontmatter of slide 2'))
      expect(slideText(await store!.deckMarkdown(sortingId()), 2)).toBe('# Bubble sort')
    })
    When('they close the window', () => {
      closing = closeWindow()
    })
    Then('the app asks "Your last changes to Sorting could not be saved yet. The deck\'s page says why."', async () => {
      expect(await closing).toBe(false)
      expect(fake.ask).toHaveBeenCalledWith('Your last changes to Sorting could not be saved yet. The deck\'s page says why.', expect.anything())
    })
  })

  Scenario('Renaming an open deck moves its page to the new id', ({ Given, When, Then, And }) => {
    Given('the deck page of "Sorting" in "Talks" is open in the app', async () => {
      library.put('Talks', 'Sorting', SORTING)
      // Writing waits long here, so the rename is what writes the change.
      await openPage(`/p/${projectIdOf('Talks')}/d/${sortingId()}`, { view: 'markdown', writeDelayMs: 60_000 })
      await vi.waitFor(() => expect((find('[data-testid="markdown-editor"]') as HTMLTextAreaElement | null)?.value).toContain('# Bubble sort'))
    })
    And('the person changes the title of slide 2 to "Merge sort"', async () => {
      const editor = find('[data-testid="markdown-editor"]') as HTMLTextAreaElement
      editor.value = editor.value.replace('# Bubble sort', '# Merge sort')
      editor.dispatchEvent(new Event('input'))
      // The Markdown view merges typing a moment later.
      await vi.waitFor(async () => expect(slideText(await store!.deckMarkdown(sortingId()), 2)).toBe('# Merge sort'))
      expect(text('[data-testid="save-status"]')).toBe('Saving...')
    })
    When('the deck is renamed to "Sorting v2" before the change is written', async () => {
      expect(library.writes).toEqual([])
      await store!.renameDeck(projectIdOf('Talks'), sortingId(), 'Sorting v2')
      await web!.settle()
    })
    Then('the page address names the deck\'s new id', async () => {
      await vi.waitFor(() => expect(web!.router.currentRoute.value.params.deckId).toBe(deckIdOf('Talks', 'Sorting v2')))
    })
    And('the page still shows the deck, saved', async () => {
      await vi.waitFor(() => expect(text('[data-testid="deck-name"]')).toBe('Sorting v2'))
      await vi.waitFor(() => expect((find('[data-testid="markdown-editor"]') as HTMLTextAreaElement | null)?.value).toContain('# Merge sort'))
      expect(text('[data-testid="save-status"]')).toBe('Saved')
    })
    And('the file "Sorting v2.md" shows "# Merge sort" on slide 2', () => {
      expect(slideText(library.read('Talks', 'Sorting v2')!, 2)).toBe('# Merge sort')
      expect(library.writes).toMatchObject([{ id: sortingId(), written: true }])
    })
    And('there is no file "Sorting.md"', () => {
      expect(library.read('Talks', 'Sorting')).toBeUndefined()
    })
  })

  Scenario('Renaming a project moves its page to the new id', ({ Given, When, Then, And }) => {
    Given('the project page of "Talks" is open in the app', async () => {
      library.put('Talks', 'Sorting', SORTING)
      await openPage(`/p/${projectIdOf('Talks')}`)
      await web!.waitFor('[data-testid="project-name"]')
    })
    When('they rename the project to "Lectures"', async () => {
      const rename = findAll('button').find(button => button.textContent?.trim() === 'Rename')!
      rename.click()
      await web!.settle()
      await submitName('Lectures')
    })
    Then('the page address names the project\'s new id', async () => {
      await vi.waitFor(() => expect(web!.router.currentRoute.value.params.projectId).toBe(projectIdOf('Lectures')))
    })
    And('the page shows the project "Lectures" with the deck "Sorting"', async () => {
      await vi.waitFor(() => expect(text('[data-testid="project-name"]')).toBe('Lectures'))
      expect(deckNames()).toEqual(['Sorting'])
      expect(library.read('Lectures', 'Sorting')).toBe(SORTING)
    })
  })

  Scenario('Deleting a deck moves its file to the trash', ({ Given, When, Then, And }) => {
    Given('the project page of "Talks" with the decks "Graphs" and "Sorting" is open in the app on a computer', async () => {
      library.put('Talks', 'Sorting', SORTING)
      library.put('Talks', 'Graphs', '# Graphs\n')
      await openPage(`/p/${projectIdOf('Talks')}`)
      await web!.waitFor('[data-deck="Graphs"]')
    })
    When('they delete the deck "Graphs"', async () => {
      const item = find('[data-deck="Graphs"]')!.closest('li')!
      const remove = [...item.querySelectorAll('button')].find(button => button.textContent?.trim() === 'Delete')!
      remove.click()
      await web!.settle()
    })
    Then('the question said "Graphs will go to the trash, or be deleted for good where the system has none."', async () => {
      await vi.waitFor(() => expect(text('[data-testid="confirm-dialog"]')).toContain('Graphs will go to the trash, or be deleted for good where the system has none.'))
      await web!.click('[data-testid="confirm-action"]')
    })
    And('"Graphs.md" went to the trash', async () => {
      await vi.waitFor(() => expect(library.trash).toEqual([`${library.root}/Talks/Graphs.md`]))
    })
    And('the page lists only the deck "Sorting"', async () => {
      await vi.waitFor(() => expect(deckNames()).toEqual(['Sorting']))
    })
  })

  Scenario('Deleting a project moves its folder to the trash', ({ Given, When, Then, And }) => {
    Given('the project page of "Talks" is open in the app', async () => {
      library.put('Talks', 'Sorting', SORTING)
      await openPage(`/p/${projectIdOf('Talks')}`)
      await web!.waitFor('[data-testid="project-name"]')
    })
    When('they delete the project', async () => {
      await web!.click('[data-testid="delete-project"]')
      expect(text('[data-testid="confirm-dialog"]')).toContain('Talks and its 1 deck will go to the trash, or be deleted for good where the system has none.')
      await web!.click('[data-testid="confirm-action"]')
    })
    Then('the folder "Talks" went to the trash', async () => {
      await vi.waitFor(() => expect(library.trash).toEqual([`${library.root}/Talks`]))
    })
    And('they are on the home page, which has no projects on this device', async () => {
      await vi.waitFor(() => expect(web!.router.currentRoute.value.name).toBe('home'))
      await vi.waitFor(() => expect(text('[data-section="device"] [data-testid="empty-projects"]')).toContain('No projects on this device yet'))
    })
  })

  Scenario('A new deck is a plain Markdown file', ({ Given, When, Then, And }) => {
    Given('the project page of "Talks" is open in the app', async () => {
      library.put('Talks', 'Sorting', SORTING)
      await openPage(`/p/${projectIdOf('Talks')}`)
      await web!.waitFor('[data-testid="project-name"]')
    })
    When('they add the deck "Intro" from the blank template', async () => {
      await web!.click('[data-testid="new-deck"]')
      await submitName('Intro')
    })
    Then('the file "Intro.md" holds a title slide "# Intro" without slide ids', () => {
      const file = library.read('Talks', 'Intro')!
      expect(splitSlides(file)).toHaveLength(1)
      expect(file).toContain('# Intro')
      // Elements keep their `data-id`; slides have no `id` in their frontmatter.
      expect(file).not.toMatch(/^id:/m)
    })
    And('they are on the deck page of "Intro"', async () => {
      await vi.waitFor(() => expect(web!.router.currentRoute.value.params.deckId).toBe(deckIdOf('Talks', 'Intro')))
      await vi.waitFor(() => expect(text('[data-testid="deck-name"]')).toBe('Intro'))
    })
  })

  // The home page in the app --------------------------------------------------

  Scenario('Signed out, the app\'s home page lists the device', ({ Given, When, Then, And }) => {
    Given('the app on a computer, signed out, with the project "Talks" on this device', async () => {
      await inApp('linux')
      library.put('Talks', 'Sorting', SORTING)
    })
    When('they open the home page', () => openPage('/'))
    Then('the page has the section "On this device" listing "Talks"', async () => {
      await vi.waitFor(() => expect(sectionNames('device')).toEqual(['Talks']))
      expect(text('[data-section="device"] h2')).toBe('On this device')
    })
    And('there is no section "Your account"', () => {
      expect(find('[data-section="account"]')).toBeNull()
    })
    And('the guest banner says "Your work is saved on this device only."', () => {
      expect(text('[data-testid="guest-banner"]')).toContain('Your work is saved on this device only.')
    })
  })

  Scenario('Signed in, the app\'s home page lists the device and the account apart', ({ Given, When, Then, And }) => {
    Given('the app on a computer, signed in as "Ana", with the project "Talks" on this device and "Lectures" in the account', async () => {
      await inApp('linux')
      library.put('Talks', 'Sorting', SORTING)
      await api.createProject('Lectures')
      service.signedIn = ANA
    })
    When('they open the home page', () => openPage('/'))
    Then('the section "On this device" lists "Talks"', async () => {
      await vi.waitFor(() => expect(sectionNames('device')).toEqual(['Talks']))
    })
    And('the section "Your account" lists "Lectures"', () => {
      expect(text('[data-section="account"] h2')).toBe('Your account')
      expect(sectionNames('account')).toEqual(['Lectures'])
    })
    When('they create the project "Notes" from the section "Your account"', async () => {
      await web!.click('[data-section="account"] [data-testid="new-project"]')
      await submitName('Notes')
      await vi.waitFor(() => expect(text('[data-testid="project-name"]')).toBe('Notes'))
    })
    Then('"Notes" is in the account and not on this device', () => {
      expect(api.projects.map(project => project.name)).toContain('Notes')
      expect(library.folders.has('Notes')).toBe(false)
    })
    When('they go home and create the project "Drafts" from the section "On this device"', async () => {
      await web!.router.push('/')
      await web!.settle()
      await web!.click('[data-section="device"] [data-testid="new-project"]')
      await submitName('Drafts')
      await vi.waitFor(() => expect(text('[data-testid="project-name"]')).toBe('Drafts'))
    })
    Then('"Drafts" is a folder on this device and not in the account', () => {
      expect(library.folders.has('Drafts')).toBe(true)
      expect(api.projects.map(project => project.name)).not.toContain('Drafts')
      expect(web!.router.currentRoute.value.params.projectId).toBe(projectIdOf('Drafts'))
    })
  })

  Scenario('When the account cannot be loaded, new projects are saved on this device', ({ Given, When, Then, And }) => {
    Given('the app on a computer, signed in as "Ana", whose account cannot be reached, with the project "Talks" on this device', async () => {
      await inApp('linux')
      library.put('Talks', 'Sorting', SORTING)
      api.failWith = 'The Deyslide server cannot be reached.'
      service.signedIn = ANA
    })
    When('they open the home page', () => openPage('/'))
    Then('the page says "Your account\'s projects could not be loaded. Close and open Deyslide to try again. Until then, new projects are saved on this device."', async () => {
      await vi.waitFor(() => expect(text('[data-testid="workspace-notice"] span')).toBe('Your account\'s projects could not be loaded. Close and open Deyslide to try again. Until then, new projects are saved on this device.'))
    })
    And('the section "On this device" lists "Talks"', () => {
      expect(sectionNames('device')).toEqual(['Talks'])
    })
    And('there is no section "Your account"', () => {
      expect(find('[data-section="account"]')).toBeNull()
    })
  })

  Scenario('Signing in never moves the device\'s decks', ({ Given, When, Then, And }) => {
    Given('the app on a computer, signed out, with the project "Talks" on this device', async () => {
      await inApp('linux')
      library.put('Talks', 'Sorting', SORTING)
      await openPage('/')
    })
    When('they sign in as "Ana"', async () => {
      service.signedIn = ANA
      await web!.account.setAccount(ANA)
      await web!.settle()
    })
    Then('the section "On this device" still lists "Talks"', async () => {
      await vi.waitFor(() => expect(find('[data-section="account"]')).not.toBeNull())
      expect(sectionNames('device')).toEqual(['Talks'])
      expect(library.read('Talks', 'Sorting')).toBe(SORTING)
    })
    And('the account has no projects', () => {
      expect(api.projects).toEqual([])
      expect(text('[data-section="account"] [data-testid="empty-projects"]')).toContain('No projects in your account yet')
    })
  })

  // Claude Code ---------------------------------------------------------------

  Scenario('The Claude Code panel gives the command to copy', ({ Given, When, Then, And }) => {
    let copied: string[]
    Given('the app on a computer, signed out, with the project "Talks" on this device', async () => {
      await inApp('linux')
      library.put('Talks', 'Sorting', SORTING)
      copied = []
      vi.spyOn(navigator.clipboard, 'writeText').mockImplementation(async (value: string) => {
        copied.push(value)
      })
    })
    When('they open the home page', () => openPage('/'))
    Then('the panel "Connect Claude Code" shows the command the app gives', async () => {
      await vi.waitFor(() => expect(text('[data-testid="mcp-command"]')).toBe('claude mcp add --scope user deyslide-local -- "/opt/Deyslide/deyslide" mcp'))
      expect(text('[data-testid="claude-code-panel"] h2')).toBe('Connect Claude Code')
      expect(text('[data-testid="library-root"]')).toBe('/home/ana/Documents/Deyslide')
    })
    And(`it shows the hosted command for "${SERVER}"`, () => {
      expect(text('[data-testid="hosted-command"]')).toBe(`claude mcp add --scope user --transport http deyslide ${SERVER}/mcp`)
    })
    When('they press the button to copy the command', async () => {
      await web!.click('[data-testid="copy-mcp-command"]')
    })
    Then('the clipboard holds the command', () => {
      expect(copied).toEqual(['claude mcp add --scope user deyslide-local -- "/opt/Deyslide/deyslide" mcp'])
    })
    And('the button says "Copied"', () => {
      expect(text('[data-testid="copy-mcp-command"]')).toBe('Copied')
    })
  })

  Scenario('The Claude Code panel says why there is no command', ({ Given, And, When, Then }) => {
    Given('the app on a computer, signed out, with the project "Talks" on this device', async () => {
      await inApp('macos')
      library.put('Talks', 'Sorting', SORTING)
    })
    And('the app gives no command because "Move Deyslide to Applications, then open it again."', () => {
      library.setup = { problem: 'Move Deyslide to Applications, then open it again.' }
    })
    When('they open the home page', () => openPage('/'))
    Then('the panel says "Move Deyslide to Applications, then open it again."', async () => {
      await vi.waitFor(() => expect(text('[data-testid="mcp-problem"]')).toBe('Move Deyslide to Applications, then open it again.'))
    })
    And('it shows no command to copy', () => {
      expect(find('[data-testid="mcp-command"]')).toBeNull()
      expect(find('[data-testid="copy-mcp-command"]')).toBeNull()
    })
  })

  Scenario('Changing the library folder', ({ Given, And, When, Then }) => {
    Given('the app on a computer, signed out, with the project "Talks" on this device', async () => {
      await inApp('linux')
      library.put('Talks', 'Sorting', SORTING)
    })
    And('the folder "/home/ana/Slides" holds the project "Lectures"', () => {
      library.holdsElsewhere('/home/ana/Slides', 'Lectures')
    })
    When('they open the home page', async () => {
      await openPage('/')
      await vi.waitFor(() => expect(text('[data-testid="library-root"]')).toBe('/home/ana/Documents/Deyslide'))
    })
    And('they change the library folder to "/home/ana/Slides"', async () => {
      fake.open.mockResolvedValue('/home/ana/Slides')
      await web!.click('[data-testid="change-library"]')
      expect(fake.open).toHaveBeenCalledWith(expect.objectContaining({ directory: true }))
    })
    Then('the panel says decks are saved in "/home/ana/Slides"', async () => {
      await vi.waitFor(() => expect(text('[data-testid="library-root"]')).toBe('/home/ana/Slides'))
      expect(library.commands).toContain('library_set_root')
    })
    And('the section "On this device" lists "Lectures" and not "Talks"', async () => {
      await vi.waitFor(() => expect(sectionNames('device')).toEqual(['Lectures']))
    })
  })

  Scenario('Android keeps no Claude Code panel', ({ Given, When, Then, And }) => {
    Given('the app on Android, signed out, with the project "Talks" on this device', async () => {
      await inApp('android')
      library.put('Talks', 'Sorting', SORTING)
    })
    When('they open the home page', () => openPage('/'))
    Then('the section "On this device" lists "Talks"', async () => {
      await vi.waitFor(() => expect(sectionNames('device')).toEqual(['Talks']))
    })
    And('there is no "Connect Claude Code" panel', () => {
      expect(find('[data-testid="claude-code-panel"]')).toBeNull()
      expect(library.commands).not.toContain('mcp_setup')
    })
  })

  // The render bridge -----------------------------------------------------------

  Scenario('Claude Code\'s slides are drawn in a frame nobody sees', ({ Given, When, Then, And }) => {
    Given('the render bridge listens in the app\'s main window', async () => {
      await listenForRenders()
      expect(readyCalls).toEqual([true])
    })
    When('the app asks for slides 1 and 3 of a 3 slide deck, at the last click', async () => {
      askForSlides('r1', SORTING, [1, 3])
      await vi.waitFor(() => expect(responses).toHaveLength(1))
    })
    Then('the bridge frame was in the window, out of sight, at 1280 by 720', () => {
      const box = { inWindow: true, position: 'fixed', left: '0px', top: '0px', width: '1280px', height: '720px', opacity: '0', pointerEvents: 'none', zIndex: '-1' }
      expect(frameBoxes).toEqual([box, box])
    })
    And('the frame drew slides 1 and 3 in print mode at their last click', () => {
      expect(drawn.map(request => [request.slide.content.trim(), request.slide.first, request.mode, request.clicks])).toEqual([
        ['# Sorting', true, 'print', LAST_CLICKS],
        ['# Insertion sort', false, 'print', LAST_CLICKS],
      ])
      expect(drawn.every(request => request.headmatter.title === 'Sorting')).toBe(true)
    })
    And('the app got 2 slide images in base64 with their click counts', () => {
      expect(responses[0].id).toBe('r1')
      expect(responses[0].slides.map(slide => ({ ...slide, png: decoded(slide.png) }))).toEqual([
        { png: 'png of # Sorting', clicks: 2, overflow: false },
        { png: 'png of # Insertion sort', clicks: 2, overflow: false },
      ])
    })
    And('no bridge frame is left in the window', () => {
      expect(find('[data-testid="render-bridge"]')).toBeNull()
    })
  })

  Scenario('Render requests are answered one at a time, each in a frame of its own', ({ Given, When, Then, And }) => {
    Given('the render bridge listens in the app\'s main window', () => listenForRenders())
    When('the app asks for slide 1 and, right after, for slide 2 of another deck', async () => {
      askForSlides('r1', SORTING, [1])
      askForSlides('r2', '# Graphs\n\n---\n\n# Trees\n', [2])
      await vi.waitFor(() => expect(responses).toHaveLength(2))
    })
    Then('slide 2 is drawn in a new frame, only after the first request was answered', () => {
      // Slides can run code in their frame, so no deck shares one with another.
      expect(timeline.filter(entry => !entry.startsWith('ready'))).toEqual(['draw r1:0 in frame 1', 'answer r1', 'draw r2:0 in frame 2', 'answer r2'])
      expect(find('[data-testid="render-bridge"]')).toBeNull()
    })
    And('both requests got their answer', () => {
      expect(responses.map(response => [response.id, response.slides.map(slide => decoded(slide.png))])).toEqual([
        ['r1', ['png of # Sorting']],
        ['r2', ['png of # Trees']],
      ])
    })
  })

  Scenario('Slides that cannot be drawn say why', ({ Given, And, When, Then }) => {
    Given('the render bridge listens in the app\'s main window', () => listenForRenders())
    And('the frame fails to draw slide 2 with "Unexpected token"', () => {
      frameFailures.set('# Bubble sort', 'Unexpected token')
    })
    When('the app asks for slides 1, 2 and 9 of a 3 slide deck, at the last click', async () => {
      askForSlides('r1', SORTING, [1, 2, 9])
      await vi.waitFor(() => expect(responses).toHaveLength(1))
    })
    Then('slide 1 has an image', () => {
      expect(decoded(responses[0].slides[0].png)).toBe('png of # Sorting')
    })
    And('slide 2 has no image and the error "Unexpected token"', () => {
      expect(responses[0].slides[1]).toEqual({ clicks: 0, overflow: false, error: 'Unexpected token' })
    })
    And('slide 9 has no image and the error "The deck has 3 slides, so there is no slide 9."', () => {
      expect(responses[0].slides[2]).toEqual({ clicks: 0, overflow: false, error: 'The deck has 3 slides, so there is no slide 9.' })
    })
  })

  const WINDOWS: Record<string, () => Promise<void>> = {
    'the app on a computer, in its main window': () => inApp('linux'),
    'the app on a computer, in an audience window': async () => {
      fake.label = 'present-d1'
      await inApp('linux')
    },
    'the app on Android': () => inApp('android'),
  }

  ScenarioOutline('Only the main window of the app on a computer draws for Claude Code and saves before closing', ({ Given, When, Then, And }, variables) => {
    Given('<where>', () => WINDOWS[variables.where]!())
    When('the app\'s pages start', async () => {
      const root = document.createElement('div')
      root.id = 'app'
      document.body.append(root)
      // A new query string makes the entry run again, with the modules it imports shared.
      await import(/* @vite-ignore */ `${resolve(import.meta.dirname, '../apps/web/src/main.ts')}?local-store=${++mainStarts}`)
    })
    Then('the page <listens> for render requests', () => {
      const listening = fake.listeners.some(listener => listener.event === 'render-request')
      expect(listening).toBe(variables.listens === 'listens')
      expect(readyCalls).toEqual(variables.listens === 'listens' ? [true] : [])
    })
    And('the page <saves> before its window closes', () => {
      expect(fake.closeHandlers).toHaveLength(variables.saves === 'writes the changes' ? 1 : 0)
    })
  })
})
