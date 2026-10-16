import type { VueWrapper } from '@vue/test-utils'
import type { AccountState } from '../apps/web/src/composables/useAccount'
import type { RenderRequest } from '../apps/web/src/preview/protocol'
import type { WebApp } from './support/web'
import { describeFeature, loadFeature } from '@amiceli/vitest-cucumber'
import { flushPromises, mount } from '@vue/test-utils'
import { PDFDocument } from 'pdf-lib'
import { expect, vi } from 'vitest'
import { shallowRef } from 'vue'
import { ACCOUNT_KEY } from '../apps/web/src/composables/useAccount'
import { MemoryGuestStorage } from '../apps/web/src/guest/memory-storage'
import { GuestStore } from '../apps/web/src/guest/store'
import ExportMenu from '../apps/web/src/present/ExportMenu.vue'
import { EXPORT_KEY, ExportError, HttpExportApi, UNREACHABLE } from '../apps/web/src/present/exports'
import { LAST_CLICKS } from '../apps/web/src/present/navigation'
import { slideTitle } from '../apps/web/src/present/outline'
import { FakeAccountService } from './support/account'
import { previewAnswers, previewCaptures, previewRequests, resetEditorDoubles, SlidePreviewFrameDouble } from './support/editor-doubles'
import { FakeExportApi } from './support/export-api'
import { FakePresentHub } from './support/present-channel'
import { FakeProjectApi } from './support/project-api'
import { find, findAll, mountWebApp, text } from './support/web'

const feature = await loadFeature('./export-ui.feature')

/** The demo deck's slides, and how many clicks each has. */
const DEMO = [
  { title: 'Deyslide', clicks: 0 },
  { title: 'Teaching: code that morphs', clicks: 2 },
  { title: 'Spatial zoom', clicks: 3 },
  { title: 'Algorithm animation', clicks: 0 },
  { title: 'Live workshop Q&A', clicks: 0 },
]
const CLICKS = Object.fromEntries(DEMO.map(slide => [slide.title, slide.clicks]))

const SERVER_OPTIONS = ['PDF', 'PDF with every click step', 'Video (WebM)']
const DEVICE_OPTIONS = ['PDF (this device)', 'PDF with every click step (this device)']

describeFeature(feature, ({ Scenario, AfterEachScenario }) => {
  let web: WebApp | undefined
  let menu: VueWrapper | undefined
  let exports: FakeExportApi
  let projectId: string
  let deckId: string
  /** Files the page saved, as the browser would download them. */
  let saved: { name: string, type: string, bytes: Promise<Uint8Array> }[]
  /** Every status the page showed, in order. */
  let said: string[]
  let watching: MutationObserver | undefined

  AfterEachScenario(() => {
    watching?.disconnect()
    watching = undefined
    menu?.unmount()
    menu = undefined
    web?.unmount()
    web = undefined
    resetEditorDoubles()
    vi.restoreAllMocks()
  })

  /** Saving goes through the browser's download: keep what would be downloaded. */
  function catchDownloads() {
    saved = []
    let blob: Blob | undefined
    vi.spyOn(URL, 'createObjectURL').mockImplementation((object) => {
      blob = object as Blob
      return 'blob:export'
    })
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      const file = blob!
      saved.push({ name: this.download, type: file.type, bytes: file.arrayBuffer().then(buffer => new Uint8Array(buffer)) })
    })
  }

  /** Keeps every status line the page shows, since they change quickly. */
  function listen() {
    said = []
    watching = new MutationObserver(() => {
      const now = text('[data-testid="export-status"]')
      if (now && said.at(-1) !== now)
        said.push(now)
    })
    watching.observe(document.body, { subtree: true, childList: true, characterData: true })
  }

  function answerRenders() {
    previewAnswers.clicks = (request: RenderRequest) => CLICKS[slideTitle(request.slide.content)] ?? 0
  }

  async function guestDeck(path: (project: string, deck: string) => string = (project, deck) => `/p/${project}/d/${deck}`) {
    const guest = await GuestStore.open(new MemoryGuestStorage())
    projectId = (await guest.createProject('Talks')).id
    deckId = (await guest.createDeck(projectId, 'Sorting', 'demo')).id
    exports = new FakeExportApi()
    answerRenders()
    catchDownloads()
    web = await mountWebApp({ guest, exports, path: path(projectId, deckId), provide: new FakePresentHub().provide })
    await vi.waitFor(() => expect(find('[data-testid="export-menu"]')).not.toBeNull())
    await vi.waitFor(() => expect(find('[data-testid="export-menu"]')!.hasAttribute('disabled')).toBe(false))
    listen()
  }

  async function signedInDeck(on: boolean) {
    const service = new FakeAccountService()
    service.addAccount('ana@example.com', 'correct horse', 'Ana')
    await service.signIn({ email: 'ana@example.com', password: 'correct horse' })
    const api = new FakeProjectApi()
    projectId = (await api.createProject('Talks')).id
    exports = new FakeExportApi({ on })
    catchDownloads()
    web = await mountWebApp({ service, api, exports })
    deckId = (await web.workspace.store.value.createDeck(projectId, 'Graphs', 'blank')).id
    await web.router.push({ name: 'deck', params: { projectId, deckId } })
    await vi.waitFor(() => expect(find('[data-testid="export-menu"]')!.hasAttribute('disabled')).toBe(false))
    await web.settle()
    listen()
  }

  async function openMenu() {
    const trigger = find('[data-testid="export-menu"]')!
    trigger.focus()
    trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    await flushPromises()
    await vi.waitFor(() => expect(find('[data-testid="export-options"]')).not.toBeNull())
  }

  const options = () => findAll('[data-testid="export-options"] [role="menuitem"]').map(item => item.textContent?.trim())

  async function choose(testId: string) {
    await openMenu()
    find(`[data-testid="${testId}"]`)!.click()
    await flushPromises()
  }

  async function finished() {
    await vi.waitFor(() => expect(find('[data-testid="export-menu"]')!.textContent?.trim()).toBe('Export'))
    await flushPromises()
  }

  async function pdfPages(file: { bytes: Promise<Uint8Array> }) {
    const pdf = await PDFDocument.load(await file.bytes)
    return pdf.getPages().map(page => [page.getWidth(), page.getHeight()])
  }

  /** What the hidden frame drew for the PDF, as [title, clicks, mode]. */
  const drawn = () => previewRequests.filter(request => request.mode === 'print').map(request => [slideTitle(request.slide.content), request.clicks])

  Scenario('Guests make the PDF on their own device', ({ Given, When, Then }) => {
    Given('the demo deck "Sorting" is open in this browser, signed out', () => guestDeck())
    When('I open the Export menu', openMenu)
    Then('it offers "PDF (this device)" and "PDF with every click step (this device)" only', () => {
      expect(options()).toEqual(DEVICE_OPTIONS)
    })
  })

  Scenario('Signed in, the server makes PDFs and videos', ({ Given, When, Then }) => {
    Given('Ana is signed in with the deck "Graphs" open, on a server that makes exports', () => signedInDeck(true))
    When('Ana opens the Export menu', openMenu)
    Then('it offers "PDF", "PDF with every click step" and "Video (WebM)"', () => {
      expect(options()).toEqual(SERVER_OPTIONS)
    })
  })

  Scenario('A server without exports leaves the PDF to the device', ({ Given, When, Then }) => {
    Given('Ana is signed in with the deck "Graphs" open, on a server that does not make exports', () => signedInDeck(false))
    When('Ana opens the Export menu', openMenu)
    Then('it offers "PDF (this device)" and "PDF with every click step (this device)" only', () => {
      expect(options()).toEqual(DEVICE_OPTIONS)
    })
  })

  Scenario('A PDF made on the server shows its progress and is saved', ({ Given, When, Then, And }) => {
    Given('Ana is signed in with the deck "Graphs" open, on a server that makes exports', () => signedInDeck(true))
    When('Ana exports a PDF, and the server says it is waiting, then half done, then done', async () => {
      // Slow enough for each status to show before the next.
      exports.pollMs = 30
      exports.progress = [{ status: 'queued', progress: 0 }, { status: 'running', progress: 0.5 }, { status: 'done', progress: 1 }]
      await choose('export-pdf')
      await finished()
    })
    Then('the page said "The PDF is waiting for its turn..." and then "Making the PDF... 50%"', () => {
      expect(said).toEqual(['Starting the PDF...', 'The PDF is waiting for its turn...', 'Making the PDF... 50%', 'Downloading the PDF...', 'Saved Graphs.pdf.'])
    })
    And('the server was asked for a PDF of the deck by its id, with the last click of each slide', () => {
      expect(exports.exports.map(({ source, format, clicks }) => ({ source, format, clicks }))).toEqual([{ source: { deckId }, format: 'pdf', clicks: 'last' }])
      expect(exports.exports[0].asked).toBe(3)
    })
    And('the server\'s file "Graphs.pdf" is saved, and the page says "Saved Graphs.pdf."', async () => {
      expect(saved.map(file => [file.name, file.type])).toEqual([['Graphs.pdf', 'application/pdf']])
      expect(new TextDecoder().decode(await saved[0].bytes)).toBe('%PDF-1.7 fake')
      expect(text('[data-testid="export-status"]')).toBe('Saved Graphs.pdf.')
      expect(find('[data-testid="export-status"]')!.getAttribute('role')).toBe('status')
    })
  })

  Scenario('A video shows every click step', ({ Given, When, Then, And }) => {
    Given('Ana is signed in with the deck "Graphs" open, on a server that makes exports', () => signedInDeck(true))
    When('Ana exports a video, which the server names "Graphs.webm"', async () => {
      exports.file = { bytes: new Uint8Array([0x1A, 0x45, 0xDF, 0xA3]), name: 'Graphs.webm', type: 'video/webm' }
      await choose('export-video')
      await finished()
    })
    Then('the server was asked for a WebM video of the deck by its id, with every click step', () => {
      expect(exports.exports.map(({ source, format, clicks }) => ({ source, format, clicks }))).toEqual([{ source: { deckId }, format: 'webm', clicks: 'each' }])
    })
    And('the server\'s file "Graphs.webm" is saved as a video', () => {
      expect(saved.map(file => [file.name, file.type])).toEqual([['Graphs.webm', 'video/webm']])
      expect(text('[data-testid="export-status"]')).toBe('Saved Graphs.webm.')
    })
  })

  Scenario('A failed export says why, and saves nothing', ({ Given, When, Then, And }) => {
    Given('Ana is signed in with the deck "Graphs" open, on a server that makes exports', () => signedInDeck(true))
    When('Ana exports a PDF with every click step, and the server says it failed: "Slide 2 shows an error: x is not defined"', async () => {
      exports.progress = [{ status: 'running', progress: 0.2 }, { status: 'failed', progress: 0.2, error: 'Slide 2 shows an error: x is not defined' }]
      await choose('export-pdf-steps')
      await finished()
    })
    Then('the page alerts "The PDF could not be made. Slide 2 shows an error: x is not defined"', () => {
      expect(text('[data-testid="export-status"]')).toBe('The PDF could not be made. Slide 2 shows an error: x is not defined')
      expect(find('[data-testid="export-status"]')!.getAttribute('role')).toBe('alert')
      expect(exports.exports[0].clicks).toBe('each')
    })
    And('nothing is saved', () => {
      expect(saved).toEqual([])
    })
  })

  Scenario('An export the server refuses says why', ({ Given, When, Then, And }) => {
    Given('Ana is signed in with the deck "Graphs" open, on a server that makes exports', () => signedInDeck(true))
    When('Ana exports a PDF, and the server refuses: "You already have 3 exports. Wait until one is done."', async () => {
      exports.refuseWith = 'You already have 3 exports. Wait until one is done.'
      await choose('export-pdf')
      await finished()
    })
    Then('the page alerts "You already have 3 exports. Wait until one is done."', () => {
      expect(text('[data-testid="export-status"]')).toBe('You already have 3 exports. Wait until one is done.')
      expect(find('[data-testid="export-status"]')!.getAttribute('role')).toBe('alert')
    })
    And('nothing is saved', () => {
      expect(saved).toEqual([])
    })
  })

  Scenario('A download that does not arrive says so', ({ Given, When, Then, And }) => {
    Given('Ana is signed in with the deck "Graphs" open, on a server that makes exports', () => signedInDeck(true))
    When('Ana exports a PDF, and the download fails: "The server could not be reached. Check the connection and try again."', async () => {
      exports.downloadFailsWith = UNREACHABLE
      await choose('export-pdf')
      await finished()
    })
    Then('the page alerts "The server could not be reached. Check the connection and try again."', () => {
      expect(text('[data-testid="export-status"]')).toBe(UNREACHABLE)
      expect(find('[data-testid="export-status"]')!.getAttribute('role')).toBe('alert')
    })
    And('nothing is saved', () => {
      expect(saved).toEqual([])
    })
  })

  Scenario('When the server cannot be reached, the menu offers the PDF made on this device too', ({ Given, When, Then }) => {
    Given('Ana is signed in with the deck "Graphs" open, on a server that makes exports', () => signedInDeck(true))
    When('Ana exports a PDF, and the server cannot be reached', async () => {
      exports.refuseWith = UNREACHABLE
      await choose('export-pdf')
      await finished()
    })
    Then('the page alerts "The server could not be reached. Check the connection and try again."', () => {
      expect(text('[data-testid="export-status"]')).toBe(UNREACHABLE)
      expect(find('[data-testid="export-status"]')!.getAttribute('role')).toBe('alert')
    })
    When('Ana opens the Export menu again', openMenu)
    Then('it offers the server\'s "PDF", "PDF with every click step" and "Video (WebM)", and "PDF (this device)" and "PDF with every click step (this device)"', () => {
      expect(options()).toEqual([...SERVER_OPTIONS, ...DEVICE_OPTIONS])
    })
  })

  Scenario('The menu asks the server again when an earlier check found no exports', ({ Given, When, Then }) => {
    Given('Ana is signed in with the deck "Graphs" open, while the server\'s answer about exports did not come', async () => {
      await signedInDeck(false)
      vi.spyOn(exports, 'enabled')
    })
    When('the server answers, and Ana opens the Export menu', async () => {
      exports.on = true
      await openMenu()
    })
    Then('it offers "PDF", "PDF with every click step" and "Video (WebM)"', async () => {
      await vi.waitFor(() => expect(options()).toEqual(SERVER_OPTIONS))
      expect(exports.enabled).toHaveBeenCalledTimes(1)
    })
  })

  Scenario('A deck on this device sends its Markdown with typing the deck has not taken yet', ({ Given, When, Then }) => {
    Given('Ana is signed in, on a server that makes exports, with a deck on this device open in the Markdown view', async () => {
      const service = new FakeAccountService()
      service.addAccount('ana@example.com', 'correct horse', 'Ana')
      await service.signIn({ email: 'ana@example.com', password: 'correct horse' })
      // Decks on this device have ids that start with local-, as the app's library makes them.
      const ids = ['local-p-00000000000000aa', 'local-d-0123456789abcdef']
      const local = await GuestStore.open(new MemoryGuestStorage(), { newId: () => ids.shift()! })
      projectId = (await local.createProject('On this device')).id
      deckId = (await local.createDeck(projectId, 'Hello', 'blank')).id
      exports = new FakeExportApi()
      catchDownloads()
      web = await mountWebApp({ service, exports, local, view: 'markdown', path: `/p/${projectId}/d/${deckId}` })
      await vi.waitFor(() => expect(find('[data-testid="markdown-editor"]')).not.toBeNull())
      await vi.waitFor(() => expect(find('[data-testid="export-menu"]')!.hasAttribute('disabled')).toBe(false))
      listen()
    })
    When('Ana types a new last slide "Typed just now" and exports a PDF at once', async () => {
      const editor = find('[data-testid="markdown-editor"]') as HTMLTextAreaElement
      editor.value = `${editor.value.trimEnd()}\n\n---\n\n# Typed just now\n`
      editor.dispatchEvent(new Event('input'))
      // Typing reaches the deck 300 ms after the last key; the export goes before that.
      await choose('export-pdf')
      await finished()
    })
    Then('the server was asked for a PDF of the deck\'s Markdown with the slide "Typed just now", without an id', () => {
      expect(exports.exports).toHaveLength(1)
      const { source, format } = exports.exports[0]
      expect(format).toBe('pdf')
      expect(Object.keys(source)).toEqual(['markdown'])
      expect((source as { markdown: string }).markdown).toMatch(/\n# Typed just now\n$/)
    })
  })

  Scenario('A deck on this device sends its Markdown to the server', ({ Given, When, Then }) => {
    const markdown = '# Hello from this device\n'
    Given('Ana is signed in, with the Export menu of a deck on this device whose id is "local-d-0123456789abcdef"', async () => {
      exports = new FakeExportApi()
      catchDownloads()
      const account = { account: shallowRef({ id: 'ana', name: 'Ana', email: 'ana@example.com' }) } as unknown as AccountState
      menu = mount(ExportMenu, {
        attachTo: document.body,
        props: { deckId: 'local-d-0123456789abcdef', deckName: 'Hello', slides: [{ content: '# Hello from this device', frontmatter: {} }], markdown: () => markdown },
        global: { provide: { [ACCOUNT_KEY as symbol]: account, [EXPORT_KEY as symbol]: exports }, stubs: { SlidePreviewFrame: SlidePreviewFrameDouble } },
      })
      await flushPromises()
    })
    When('Ana exports a PDF from that menu', async () => {
      await choose('export-pdf')
      await finished()
    })
    Then('the server was asked for a PDF of the deck\'s Markdown, without an id', () => {
      expect(exports.exports.map(({ source, format }) => ({ source, format }))).toEqual([{ source: { markdown }, format: 'pdf' }])
      expect(saved.map(file => file.name)).toEqual(['Graphs.pdf'])
    })
  })

  Scenario('A PDF made on the device draws every slide in print mode', ({ Given, When, Then, And }) => {
    Given('the demo deck "Sorting" is open in this browser, signed out', () => guestDeck())
    When('I export "PDF (this device)"', async () => {
      await choose('export-device-pdf')
      await finished()
    })
    Then('the preview drew each of the 5 slides in print mode at its last click, and each was captured at 1.5 times', () => {
      expect(drawn()).toEqual(DEMO.map(slide => [slide.title, LAST_CLICKS]))
      expect(previewCaptures).toEqual([1.5, 1.5, 1.5, 1.5, 1.5])
      expect(said).toContain('Drawing slide 3 of 5... 40%')
    })
    And('the file "Sorting.pdf" is saved: a PDF of 5 pages, each 960 by 540 points', async () => {
      expect(saved.map(file => [file.name, file.type])).toEqual([['Sorting.pdf', 'application/pdf']])
      expect(await pdfPages(saved[0])).toEqual(DEMO.map(() => [960, 540]))
      // The hidden frame is gone once the PDF is made.
      expect(find('[data-testid="export-frame"]')).toBeNull()
    })
    And('the page says "Saved Sorting.pdf."', () => {
      expect(text('[data-testid="export-status"]')).toBe('Saved Sorting.pdf.')
    })
  })

  Scenario('A PDF made on the device can show every click step', ({ Given, When, Then, And }) => {
    Given('the demo deck "Sorting" is open in this browser, signed out', () => guestDeck())
    When('I export "PDF with every click step (this device)"', async () => {
      await choose('export-device-pdf-steps')
      await finished()
    })
    Then('the preview drew 10 steps: slide 1, slide 2 at clicks 0 to 2, slide 3 at clicks 0 to 3, then slides 4 and 5', () => {
      const [one, two, three, four, five] = DEMO.map(slide => slide.title)
      expect(drawn()).toEqual([[one, 0], [two, 0], [two, 1], [two, 2], [three, 0], [three, 1], [three, 2], [three, 3], [four, 0], [five, 0]])
    })
    And('the file "Sorting.pdf" is saved: a PDF of 10 pages', async () => {
      expect(saved.map(file => file.name)).toEqual(['Sorting.pdf'])
      expect(await pdfPages(saved[0])).toHaveLength(10)
    })
  })

  Scenario('A slide that cannot be drawn stops the PDF made on the device', ({ Given, When, Then, And }) => {
    Given('the demo deck "Sorting" is open in this browser, signed out, and slide 2 shows the error "x is not defined"', async () => {
      await guestDeck()
      previewAnswers.error = request => request.mode === 'print' && slideTitle(request.slide.content) === DEMO[1].title ? 'x is not defined' : undefined
    })
    When('I export "PDF (this device)"', async () => {
      await choose('export-device-pdf')
      await finished()
    })
    Then('the page alerts "Slide 2 could not be drawn: x is not defined"', () => {
      expect(text('[data-testid="export-status"]')).toBe('Slide 2 could not be drawn: x is not defined')
      expect(find('[data-testid="export-status"]')!.getAttribute('role')).toBe('alert')
    })
    And('nothing is saved', () => {
      expect(saved).toEqual([])
    })
  })

  Scenario('The presenter view has the Export menu too', ({ Given, When, Then }) => {
    Given('the demo deck "Sorting" is open in the presenter view, signed out', () => guestDeck((project, deck) => `/p/${project}/d/${deck}/presenter`))
    When('I export "PDF (this device)" from the presenter view', async () => {
      expect(find('[data-testid="presenter-page"] [data-testid="export-menu"]')).not.toBeNull()
      await choose('export-device-pdf')
      await finished()
    })
    Then('the file "Sorting.pdf" is saved: a PDF of 5 pages', async () => {
      expect(saved.map(file => file.name)).toEqual(['Sorting.pdf'])
      expect(await pdfPages(saved[0])).toHaveLength(5)
    })
  })

  // The client of /api/exports, over a fake server.

  let requests: { method: string, path: string, body?: unknown }[]
  let client: HttpExportApi
  let fileName = ''

  function server(answer: (method: string, path: string) => Response | Promise<Response>) {
    requests = []
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const method = init?.method ?? 'GET'
      const path = String(input)
      requests.push({ method, path, ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) })
      return answer(method, path)
    }) as typeof fetch
    client = new HttpExportApi(fetchImpl)
  }

  Scenario('The export client follows a job on the server and downloads its file', ({ Given, When, Then, And }) => {
    Given('an export client talking to a server', () => {
      server((method, path) => {
        if (method === 'POST')
          return Response.json({ id: 'job-1' }, { status: 202 })
        if (path.endsWith('/file')) {
          return new Response(new Uint8Array([37, 80, 68, 70]), {
            headers: { 'content-type': 'application/pdf', 'content-disposition': `attachment; filename="Caf_ notes.pdf"; filename*=UTF-8''${encodeURIComponent('Café notes.pdf')}` },
          })
        }
        return Response.json({ status: 'done', progress: 1 })
      })
    })
    When('it exports the deck "d1" as a PDF with every click step, follows it until done and downloads it', async () => {
      const id = await client.start({ deckId: 'd1' }, 'pdf', 'each')
      expect(await client.status(id)).toEqual({ status: 'done', progress: 1 })
      const file = await client.download(id)
      expect([...file.bytes]).toEqual([37, 80, 68, 70])
      expect(file.type).toBe('application/pdf')
      fileName = file.name
    })
    Then('it sent "POST /api/exports" with the deck id, the format and the clicks, then "GET /api/exports/job-1" and "GET /api/exports/job-1/file"', () => {
      expect(requests).toEqual([
        { method: 'POST', path: '/api/exports', body: { deckId: 'd1', format: 'pdf', options: { clicks: 'each' } } },
        { method: 'GET', path: '/api/exports/job-1' },
        { method: 'GET', path: '/api/exports/job-1/file' },
      ])
    })
    And('the file is named "Café notes.pdf" from the server\'s download header', () => {
      expect(fileName).toBe('Café notes.pdf')
    })
  })

  Scenario('The export client puts the server\'s problems in words', ({ Given, Then, And }) => {
    Given('an export client talking to a server', () => {
      server((_, path) => {
        if (path === '/api/config')
          return Response.json({ email: true, exports: true })
        return Response.json({ error: 'You already have 3 exports. Wait until one is done.' }, { status: 429 })
      })
    })
    Then('a refusal reads as the server\'s own message', async () => {
      await expect(client.start({ markdown: '# A' }, 'pdf', 'last')).rejects.toEqual(new ExportError('You already have 3 exports. Wait until one is done.'))
    })
    And('a server that cannot be reached reads "The server could not be reached. Check the connection and try again."', async () => {
      const offline = new HttpExportApi((async () => {
        throw new TypeError('Failed to fetch')
      }) as typeof fetch)
      await expect(offline.status('job-1')).rejects.toEqual(new ExportError(UNREACHABLE))
      expect(await offline.enabled()).toBe(false)
    })
    And('it reads from /api/config whether the server makes exports', async () => {
      expect(await client.enabled()).toBe(true)
      expect(requests.filter(request => request.path === '/api/config')).toHaveLength(1)
      // Asked once, then remembered.
      expect(await client.enabled()).toBe(true)
      expect(requests.filter(request => request.path === '/api/config')).toHaveLength(1)
    })
  })

  Scenario('The export client asks again after a check that failed, and keeps an answer that came', ({ Given, When, Then }) => {
    let reachable = false
    let answers: boolean[] = []
    Given('an export client whose server cannot be reached at first', () => {
      server(() => {
        if (!reachable)
          throw new TypeError('Failed to fetch')
        return Response.json({ email: true, exports: true })
      })
    })
    When('it checks whether the server makes exports', async () => {
      answers = [await client.enabled()]
    })
    Then('it says no', () => {
      expect(answers).toEqual([false])
    })
    When('the server can be reached again and it checks twice more', async () => {
      reachable = true
      answers = [await client.enabled(), await client.enabled()]
    })
    Then('it says yes, and asked /api/config twice in all', () => {
      expect(answers).toEqual([true, true])
      expect(requests.filter(request => request.path === '/api/config')).toHaveLength(2)
    })
  })
})
