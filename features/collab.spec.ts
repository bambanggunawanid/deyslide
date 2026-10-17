// @vitest-environment node
import type { Client } from '@modelcontextprotocol/sdk/client/index.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import type { MockInstance } from 'vitest'
import type { SlideRenderer } from '../apps/server/src/mcp/renderer'
import type { Project } from '../apps/server/src/projects'
import type { Listening, TestBrowser, TestServer } from './support/server'
import { createHash, randomBytes } from 'node:crypto'
import { describeFeature, loadFeature } from '@amiceli/vitest-cucumber'
import { HocuspocusProvider, HocuspocusProviderWebsocket } from '@hocuspocus/provider'
import { beforeAll, expect, vi } from 'vitest'
import WebSocket from 'ws'
import { Awareness, encodeAwarenessUpdate } from 'y-protocols/awareness'
import * as Y from 'yjs'
import { CHECK_DELAY_MS, presenceColor } from '../apps/server/src/collab/hocuspocus'
import { roomName } from '../apps/server/src/collab/rooms'
import { storeAllRooms } from '../apps/server/src/collab/shutdown'
import { BASE_LIMITS, RecentBases } from '../apps/server/src/mcp/decks'
import { LIVE_EDITING } from '../apps/server/src/routes'
import { applyMarkdown, deckToYDoc, deleteSlide, findElement, findSlide, fromMarkdown, insertSlide, joinSlides, newId, readDeckDoc, slideMarkdowns, updateElement, withLiveShape, yDocToDeck } from '../packages/deck-model/src'
import { blankDeckState } from './support/deck-content'
import { legacyDoc } from './support/legacy-deck'
import { approveConsent, connectMcp, FakeClaudeCodeAuth, followInBrowser } from './support/mcp-client'
import { closeTestServers, createTestServer, DATABASE_WARM_UP_MS, signedInBrowser, TEST_ORIGIN, warmUpDatabase } from './support/server'

const feature = await loadFeature('./collab.feature')

beforeAll(warmUpDatabase, DATABASE_WARM_UP_MS)

const SORTING = '---\ntitle: Sorting\n---\n\n# Sorting\n\n---\n\n# Bubble sort\n\n---\n\n# Merge sort\n'
const HEAP = '---\ntitle: Sorting\n---\n\n# Sorting\n\n---\n\n# Heap sort\n'
/** How long a scenario waits for something to arrive over a socket. */
const SOON = { timeout: 4000, interval: 20 }

/** What Claude Code's render_slides drew, by each slide's content. */
const drawn: string[] = []
/** A renderer that keeps what it is asked to draw. */
const renderer: SlideRenderer = {
  render: async (slides) => {
    drawn.push(...slides.map(slide => slide.content.trim()))
    return slides.map(() => ({ png: 'iVBORw0KGgo=', clicks: 0, overflow: false }))
  },
}
/** What clients receive when their access changed. Clients depend on these values, so they are spelled out here. */
const ACCESS_CHANGED = { code: 4001, reason: 'access-changed' }
const TOO_BIG = { code: 4002, reason: 'This deck is too big to save. Remove some content.' }
/** The Hocuspocus message type of a presence update. */
const AWARENESS_MESSAGE = 1

/** A page with the deck open live: its document, and what its connection went through. */
interface LivePage {
  provider: HocuspocusProvider
  socket: HocuspocusProviderWebsocket
  doc: Y.Doc
  closes: { code: number, reason: string }[]
  refusals: string[]
  scopes: string[]
  closed: boolean
}

/** How a page signs in: a browser's session cookie from a page on `origin`, or a token as the apps send. */
type SignIn = { browser: TestBrowser, origin?: string } | { token: string }

interface PageOptions {
  /** The page document's client id, as a page that reconnects keeps it. */
  clientID?: number
  /** False for a client that never answers the server's pings. */
  autoPong?: boolean
  /**
   * The live editing address the page uses. By default it carries the
   * shape of the deck this code reads, as the web app sends it.
   */
  url?: string
}

/** The slides of a deck document, as Markdown. */
const slidesOf = (doc: Y.Doc) => slideMarkdowns(doc).map(slide => slide.markdown)

/** The first heading of each slide. */
const headingsOf = (slides: string[]) => slides.map(slide => slide.match(/^# (.+)$/m)?.[1])

/** The deck in an encoded state, as Markdown per slide. */
function slidesIn(state: Uint8Array) {
  const doc = new Y.Doc()
  Y.applyUpdate(doc, state)
  return slidesOf(doc)
}

const SORTING_SLIDES = slidesIn(Y.encodeStateAsUpdate(deckToYDoc(fromMarkdown(SORTING))))

/** Replaces a slide's whole text, as the Markdown view does. */
function changeSlide(doc: Y.Doc, number: number, text: string) {
  const slides = slidesOf(doc)
  slides[number - 1] = text
  applyMarkdown(doc, joinSlides(slides))
}

/** A deck as the base64 state the API takes. */
const stateOf = (markdown: string) => Buffer.from(Y.encodeStateAsUpdate(deckToYDoc(fromMarkdown(markdown)))).toString('base64')

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

function varUint(value: number) {
  const bytes: number[] = []
  while (value > 0x7F) {
    bytes.push(0x80 | (value & 0x7F))
    value >>>= 7
  }
  bytes.push(value)
  return bytes
}

describeFeature(feature, ({ Background, Scenario, AfterEachScenario }) => {
  let server: TestServer
  let listening: Listening
  let anaBrowser: TestBrowser
  let budiBrowser: TestBrowser
  let citraBrowser: TestBrowser
  let projectId: string
  let deckId: string
  let pages: LivePage[] = []
  let ana: LivePage
  let budi: LivePage
  let citra: LivePage
  let claude: Client | undefined
  let otherClaude: Client | undefined
  let claudeAuth: FakeClaudeCodeAuth
  let result: CallToolResult
  let read: string
  let answer: { status: number, body: unknown }
  let unsavedRooms: string[]
  let failedSaves = 0
  let restoreSaves: (() => void) | undefined
  let quietErrors: MockInstance | undefined

  AfterEachScenario(async () => {
    for (const page of pages.splice(0))
      close(page)
    await claude?.close()
    await otherClaude?.close()
    claude = undefined
    otherClaude = undefined
    restoreSaves?.()
    restoreSaves = undefined
    quietErrors?.mockRestore()
    quietErrors = undefined
    await closeTestServers()
  })

  /** Opens the deck live in a new page. */
  function openLive(id: string, signIn: SignIn, { clientID, autoPong = true, url = withLiveShape(listening.collabUrl) }: PageOptions = {}): LivePage {
    const headers: Record<string, string> = 'browser' in signIn ? { cookie: signIn.browser.cookieHeader(), origin: signIn.origin ?? TEST_ORIGIN } : {}
    /** A WebSocket that sends what a browser would on the upgrade request. */
    class PageSocket extends WebSocket {
      constructor(address: string | URL) {
        super(address, { headers, autoPong })
      }
    }
    const doc = new Y.Doc()
    if (clientID !== undefined)
      doc.clientID = clientID
    const socket = new HocuspocusProviderWebsocket({ url, WebSocketPolyfill: PageSocket })
    const page = { socket, doc, closes: [], refusals: [], scopes: [], closed: false } as unknown as LivePage
    page.provider = new HocuspocusProvider({
      websocketProvider: socket,
      name: roomName(id),
      document: doc,
      token: 'browser' in signIn ? 'cookie' : signIn.token,
      onClose: ({ event }) => {
        page.closes.push({ code: event.code, reason: event.reason })
        // Like the web app, a page stops when the deck is too big to save.
        if (event.code === TOO_BIG.code)
          queueMicrotask(() => close(page))
      },
      onAuthenticationFailed: ({ reason }) => {
        page.refusals.push(reason)
      },
      onAuthenticated: ({ scope }) => {
        page.scopes.push(scope)
      },
    })
    // Pages say where they are. A state nobody ever changed is not shared.
    page.provider.setAwarenessField('view', 'design')
    page.provider.attach()
    pages.push(page)
    return page
  }

  function close(page: LivePage) {
    if (page.closed)
      return
    page.closed = true
    page.provider.destroy()
    page.socket.destroy()
  }

  async function synced(...live: LivePage[]) {
    for (const page of live)
      await vi.waitFor(() => expect(page.provider.isSynced).toBe(true), SOON)
  }

  async function openSynced(signIn: SignIn) {
    const page = openLive(deckId, signIn)
    await synced(page)
    return page
  }

  /** Waits until the server holds what the page changed. */
  async function sent(page: LivePage) {
    await vi.waitFor(() => expect(page.provider.hasUnsyncedChanges).toBe(false), SOON)
  }

  const room = () => server.collab.documents.get(roomName(deckId))

  async function closeDeck(...live: LivePage[]) {
    for (const page of live)
      close(page)
    await vi.waitFor(() => expect(room()).toBeUndefined(), SOON)
  }

  async function savedSlides() {
    return slidesIn((await server.projects.storedState(deckId))!)
  }

  async function userIdOf(browser: TestBrowser) {
    return (await browser.json<{ id: string }>('/api/me')).body.id
  }

  async function share(email: string, role: 'editor' | 'viewer') {
    const shared = await anaBrowser.json(`/api/projects/${projectId}/sharing`, { json: { email, role } })
    expect(shared.status).toBe(201)
  }

  async function seesOnSlide(page: LivePage, text: string, number: number) {
    await vi.waitFor(() => expect(slidesOf(page.doc)[number - 1]).toContain(text), SOON)
  }

  async function closesBecauseAccessChanged(...live: LivePage[]) {
    for (const page of live) {
      await vi.waitFor(() => expect(page.closes).toEqual([ACCESS_CHANGED]), SOON)
      await vi.waitFor(() => expect(page.refusals).toEqual(['permission-denied']), SOON)
    }
  }

  async function connectClaude() {
    claudeAuth = new FakeClaudeCodeAuth(async (url) => {
      const page = await followInBrowser(anaBrowser, url)
      return page.pathname === '/oauth/consent' ? approveConsent(anaBrowser, page) : page
    })
    claude = await connectMcp(server, claudeAuth)
  }

  async function callTool(name: string, args: Record<string, unknown>, client = claude!) {
    result = await client.callTool({ name, arguments: args }) as CallToolResult
    return result
  }

  async function call(name: string, args: Record<string, unknown>, client = claude!) {
    const answered = await callTool(name, args, client)
    expect(answered.isError, JSON.stringify(answered.content)).toBeFalsy()
    return answered
  }

  const resultText = () => (result.content as { type: string, text: string }[])[0].text

  async function readDeck(client = claude!) {
    await call('read_deck', { deckId }, client)
    read = (result.structuredContent as { markdown: string }).markdown
  }

  /** Makes the next `times` saves fail, as a lost database connection does. */
  function failSaves(times: number) {
    const store = server.projects.storeState.bind(server.projects)
    let left = times
    failedSaves = 0
    server.projects.storeState = async (...args) => {
      if (left > 0) {
        left--
        failedSaves++
        throw new Error('The database connection was lost')
      }
      return store(...args)
    }
    restoreSaves = () => {
      server.projects.storeState = store
    }
    // Hocuspocus logs each failed save.
    quietErrors = vi.spyOn(console, 'error').mockImplementation(() => {})
  }

  /**
   * Holds a room's loading until `release`, so a scenario can act while a
   * room loads. The room has read the saved deck by then.
   */
  function holdLoading() {
    const load = server.projects.storedState.bind(server.projects)
    let release!: () => void
    const released = new Promise<void>(resolve => (release = resolve))
    let started!: () => void
    const entered = new Promise<void>(resolve => (started = resolve))
    server.projects.storedState = async (id) => {
      const state = await load(id)
      started()
      await released
      return state
    }
    return {
      entered,
      release() {
        server.projects.storedState = load
        release()
      },
    }
  }

  /** Sends presence for any client ids over a page's socket, as a modified page could. Null says a client left. */
  function sendPresence(page: LivePage, states: Map<number, Record<string, unknown> | null>, clock: number) {
    const scratch = new Awareness(new Y.Doc())
    scratch.setLocalState(null)
    for (const [clientId, state] of states) {
      if (state)
        scratch.states.set(clientId, state)
      scratch.meta.set(clientId, { clock, lastUpdated: Date.now() })
    }
    const update = encodeAwarenessUpdate(scratch, [...states.keys()])
    scratch.destroy()
    const name = new TextEncoder().encode(page.provider.effectiveName)
    page.socket.webSocket!.send(Uint8Array.from([...varUint(name.length), ...name, ...varUint(AWARENESS_MESSAGE), ...varUint(update.length), ...update]))
  }

  /**
   * Waits until the room handled everything the page sent so far: the room
   * handles a connection's messages in order, so once Ana sees the page's
   * next presence change, the room has dealt with what came before it.
   */
  async function handled(page: LivePage) {
    const view = `checked-${Math.random()}`
    page.provider.setAwarenessField('view', view)
    await vi.waitFor(() => expect(ana.provider.awareness!.getStates().get(page.doc.clientID)?.view).toBe(view), SOON)
  }

  /** The OAuth sign in the apps do, ending with an access token for the API. */
  async function appToken(browser: TestBrowser) {
    const redirect = 'http://127.0.0.1:49152/callback'
    const registered = await server.app.request(`${TEST_ORIGIN}/api/auth/oauth2/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        client_name: 'Deyslide app',
        application_type: 'native',
        token_endpoint_auth_method: 'none',
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        redirect_uris: ['http://127.0.0.1/callback'],
        resources: [`${TEST_ORIGIN}/api`],
      }),
    })
    const { client_id: clientId } = await registered.json() as { client_id: string }
    const verifier = randomBytes(32).toString('base64url')
    const authorize = new URL(`${TEST_ORIGIN}/api/auth/oauth2/authorize`)
    authorize.search = new URLSearchParams({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: redirect,
      scope: 'openid profile email offline_access',
      state: 'collab',
      code_challenge: createHash('sha256').update(verifier).digest('base64url'),
      code_challenge_method: 'S256',
      resource: `${TEST_ORIGIN}/api`,
    }).toString()
    const page = await followInBrowser(browser, authorize)
    const landed = page.pathname === '/oauth/consent' ? await approveConsent(browser, page) : page
    const tokens = await server.app.request(`${TEST_ORIGIN}/api/auth/oauth2/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'authorization_code', code: landed.searchParams.get('code')!, redirect_uri: redirect, client_id: clientId, code_verifier: verifier }),
    })
    return (await tokens.json() as { access_token: string }).access_token
  }

  async function savesWholeDeck() {
    answer = await anaBrowser.json(`/api/decks/${deckId}/state`, { method: 'PUT', json: { state: blankDeckState('Older') } })
  }

  async function shareWithBudi(role: 'editor' | 'viewer') {
    budiBrowser = await signedInBrowser(server, 'budi@example.com', 'Budi')
    await share('budi@example.com', role)
  }

  async function anaAndBudiOpen() {
    ana = await openSynced({ browser: anaBrowser })
    budi = await openSynced({ browser: budiBrowser })
  }

  async function removeBudi() {
    const removed = await anaBrowser.request(`/api/projects/${projectId}/sharing/members/${await userIdOf(budiBrowser)}`, { method: 'DELETE' })
    expect(removed.status).toBe(204)
  }

  Background(({ Given, And }) => {
    Given('the Deyslide API on a port with live editing', async () => {
      // Short checks and pings, so scenarios see their effects in moments.
      drawn.length = 0
      server = await createTestServer({ signInCheckMs: 200, renderer })
      listening = await server.listen({ pingIntervalMs: 200 })
    })
    And('Ana owns the deck "Sorting" with the slides "Sorting", "Bubble sort" and "Merge sort"', async () => {
      anaBrowser = await signedInBrowser(server, 'ana@example.com', 'Ana')
      projectId = (await anaBrowser.json<Project>('/api/projects', { json: { name: 'Talks' } })).body.id
      deckId = (await anaBrowser.json<{ id: string }>(`/api/projects/${projectId}/decks`, { json: { name: 'Sorting', state: stateOf(SORTING) } })).body.id
    })
  })

  Scenario('Two editors see each other\'s change', ({ Given, And, When, Then }) => {
    Given('Ana shared the project with Budi as an editor', () => shareWithBudi('editor'))
    And('Ana and Budi have the deck open live', anaAndBudiOpen)
    When('Ana changes slide 2 to "# Insertion sort"', () => {
      changeSlide(ana.doc, 2, '# Insertion sort')
    })
    Then('Budi sees "# Insertion sort" on slide 2', () => seesOnSlide(budi, '# Insertion sort', 2))
    When('Budi changes slide 3 to "# Quick sort"', () => {
      changeSlide(budi.doc, 3, '# Quick sort')
    })
    Then('Ana sees "# Quick sort" on slide 3', () => seesOnSlide(ana, '# Quick sort', 3))
  })

  Scenario('A viewer follows along and shows up in presence, but changes nothing', ({ Given, And, Then, When }) => {
    Given('Ana shared the project with Budi as a viewer', () => shareWithBudi('viewer'))
    And('Ana and Budi have the deck open live', anaAndBudiOpen)
    Then('Budi\'s connection is read only', () => {
      expect(budi.scopes).toEqual(['readonly'])
      expect(ana.scopes).toEqual(['read-write'])
    })
    And('Ana and Budi see each other in presence', async () => {
      const [anaId, budiId] = [await userIdOf(anaBrowser), await userIdOf(budiBrowser)]
      await vi.waitFor(() => {
        expect(ana.provider.awareness!.getStates().get(budi.doc.clientID)?.user).toEqual({ id: budiId, name: 'Budi', color: presenceColor(budiId) })
        expect(budi.provider.awareness!.getStates().get(ana.doc.clientID)?.user).toEqual({ id: anaId, name: 'Ana', color: presenceColor(anaId) })
      }, SOON)
    })
    When('Budi changes slide 2 to "# Mine"', async () => {
      changeSlide(budi.doc, 2, '# Mine')
      await handled(budi)
    })
    Then('the live deck still has "# Bubble sort" on slide 2', () => {
      expect(slidesOf(room()!)[1]).toContain('# Bubble sort')
      expect(slidesOf(ana.doc)[1]).toContain('# Bubble sort')
    })
    When('Ana changes slide 3 to "# Quick sort"', () => {
      changeSlide(ana.doc, 3, '# Quick sort')
    })
    Then('Budi sees "# Quick sort" on slide 3', () => seesOnSlide(budi, '# Quick sort', 3))
  })

  Scenario('A viewer cannot pass for someone else in presence', ({ Given, And, When, Then }) => {
    let anaId: string
    Given('Ana shared the project with Budi as a viewer', () => shareWithBudi('viewer'))
    And('Ana and Budi have the deck open live', anaAndBudiOpen)
    When('Budi\'s page claims to be Ana in presence', async () => {
      anaId = await userIdOf(anaBrowser)
      budi.provider.setAwarenessField('user', { id: anaId, name: 'Ana', color: '#000000' })
      budi.provider.setAwarenessField('slideId', 'claimed')
    })
    Then('Ana sees Budi\'s presence with Budi\'s account, name and color', async () => {
      const budiId = await userIdOf(budiBrowser)
      await vi.waitFor(() => {
        const state = ana.provider.awareness!.getStates().get(budi.doc.clientID)
        expect(state?.slideId).toBe('claimed')
        expect(state?.user).toEqual({ id: budiId, name: 'Budi', color: presenceColor(budiId) })
      }, SOON)
      expect(budiId).not.toBe(anaId)
    })
  })

  Scenario('A page shows one presence, its own, and cannot take over anyone else\'s', ({ Given, And, When, Then }) => {
    let citraId: number
    Given('Ana shared the project with Budi as a viewer and Citra as an editor', async () => {
      await shareWithBudi('viewer')
      citraBrowser = await signedInBrowser(server, 'citra@example.com', 'Citra')
      await share('citra@example.com', 'editor')
    })
    And('Ana, Budi and Citra have the deck open live', async () => {
      await anaAndBudiOpen()
      citra = await openSynced({ browser: citraBrowser })
      citraId = citra.doc.clientID
      await vi.waitFor(() => expect(ana.provider.awareness!.getStates().get(citraId)?.user?.name).toBe('Citra'), SOON)
    })
    When('Budi\'s page sends presence for 50 more clients and for Citra\'s client', () => {
      const states = new Map<number, Record<string, unknown> | null>()
      for (let index = 0; index < 50; index++)
        states.set(900_000 + index, { view: 'design' })
      states.set(citraId, { view: 'present' })
      sendPresence(budi, states, 1000)
    })
    And('Budi\'s page says Citra\'s client left', async () => {
      sendPresence(budi, new Map([[citraId, null]]), 2000)
      await handled(budi)
    })
    Then('Ana sees three people in presence: Ana, Budi and Citra', () => {
      const states = ana.provider.awareness!.getStates()
      expect([...states.keys()].sort()).toEqual([ana.doc.clientID, budi.doc.clientID, citraId].sort())
      expect(states.get(citraId)).toMatchObject({ view: 'design', user: { name: 'Citra' } })
      expect(states.get(budi.doc.clientID)?.user?.name).toBe('Budi')
    })
    When('Citra closes the deck and Budi\'s page claims Citra\'s client meanwhile', async () => {
      close(citra)
      await vi.waitFor(() => expect(ana.provider.awareness!.getStates().has(citraId)).toBe(false), SOON)
      sendPresence(budi, new Map([[citraId, { view: 'present' }]]), 5000)
      await handled(budi)
      expect(ana.provider.awareness!.getStates().has(citraId)).toBe(false)
    })
    And('Citra\'s page comes back with the same client', async () => {
      citra = openLive(deckId, { browser: citraBrowser }, { clientID: citraId })
      await synced(citra)
      // A new page counts its presence from zero. It goes past the count the
      // room remembers from Citra's first page, as a reconnecting page does.
      for (let step = 0; step < 10; step++)
        citra.provider.setAwarenessField('view', 'design')
    })
    Then('Ana sees Citra\'s presence as Citra\'s', async () => {
      const id = await userIdOf(citraBrowser)
      await vi.waitFor(() => expect(ana.provider.awareness!.getStates().get(citraId)).toMatchObject({ view: 'design', user: { id, name: 'Citra' } }), SOON)
    })
  })

  Scenario('Strangers are refused', ({ Given, When, Then, And }) => {
    let dewiBrowser: TestBrowser
    let dewi: LivePage
    async function refused(page: LivePage) {
      await vi.waitFor(() => expect(page.refusals).toEqual(['permission-denied']), SOON)
      expect(page.provider.isSynced).toBe(false)
    }
    Given('Dewi has an account', async () => {
      dewiBrowser = await signedInBrowser(server, 'dewi@example.com', 'Dewi')
    })
    When('Dewi opens the deck live', () => {
      dewi = openLive(deckId, { browser: dewiBrowser })
    })
    Then('Dewi is refused', () => refused(dewi))
    And('Ana opening the deck from a page on another site is refused the same way', () => refused(openLive(deckId, { browser: anaBrowser, origin: 'https://elsewhere.example' })))
    And('Ana opening a deck that does not exist is refused the same way', () => refused(openLive('no-such-deck', { browser: anaBrowser })))
  })

  Scenario('A page with code from before settings were split is turned away', ({ When, Then }) => {
    let page: LivePage
    let older: LivePage
    When('Ana opens the deck live from a page that does not say which shape of the deck it reads', () => {
      page = openLive(deckId, { browser: anaBrowser }, { url: listening.collabUrl })
    })
    Then('Ana\'s page is refused because it is out of date, and gets no deck', async () => {
      await vi.waitFor(() => expect(page.refusals).toEqual(['update-required']), SOON)
      expect(page.provider.isSynced).toBe(false)
      expect(page.doc.getMap('deck').size).toBe(0)
    })
    When('Ana opens the deck live from a page that says an older shape', () => {
      older = openLive(deckId, { browser: anaBrowser }, { url: `${listening.collabUrl}?shape=1` })
    })
    Then('that page is refused the same way', async () => {
      await vi.waitFor(() => expect(older.refusals).toEqual(['update-required']), SOON)
      expect(older.provider.isSynced).toBe(false)
    })
  })

  Scenario('A deck stored before settings were split is converted when its room loads', ({ Given, And, When, Then }) => {
    let slideId: string
    /** The rectangle's settings in a document. */
    const box = (doc: Y.Doc) => findElement(doc, slideId, 'box')!.get('props')
    Given('Ana shared the project with Budi as an editor', () => shareWithBudi('editor'))
    And('the deck is stored the way decks were before settings were split, with a rectangle on slide 2', async () => {
      const deck = readDeckDoc(deckToYDoc(fromMarkdown(SORTING)))
      slideId = deck.slides[1].id
      deck.slides[1].elements.push({ id: 'box', type: 'shape', pos: { x: 100, y: 100, w: 200, h: 120, rotate: 0 }, props: { shape: 'rect', fill: '#ffffff' } })
      await server.projects.storeState(deckId, Y.encodeStateAsUpdate(legacyDoc(deck)), deck.slides.length)
    })
    And('Ana and Budi have the deck open live', anaAndBudiOpen)
    Then('both see the rectangle\'s settings and the slides\' frontmatter stored key by key', () => {
      for (const page of [ana, budi]) {
        expect(box(page.doc)).toBeInstanceOf(Y.Map)
        expect((box(page.doc) as Y.Map<unknown>).toJSON()).toEqual({ shape: 'rect', fill: '#ffffff' })
        for (const slide of readDeckDoc(page.doc).slides)
          expect(findSlide(page.doc, slide.id)!.get('frontmatter')).toBeInstanceOf(Y.Map)
        expect(readDeckDoc(page.doc).slides[0].frontmatter).toEqual({ title: 'Sorting' })
      }
    })
    When('Ana changes the rectangle\'s fill while Budi changes its stroke', () => {
      // Both change it before either hears of the other's change.
      updateElement(ana.doc, slideId, 'box', { props: { shape: 'rect', fill: '#22d3ee' } })
      updateElement(budi.doc, slideId, 'box', { props: { shape: 'rect', fill: '#ffffff', stroke: '#0f172a' } })
    })
    Then('Ana and Budi both soon see Ana\'s fill and Budi\'s stroke', async () => {
      for (const page of [ana, budi])
        await vi.waitFor(() => expect((box(page.doc) as Y.Map<unknown>).toJSON()).toEqual({ shape: 'rect', fill: '#22d3ee', stroke: '#0f172a' }), SOON)
    })
    When('Ana and Budi close the deck', () => closeDeck(ana, budi))
    Then('the saved deck has the rectangle\'s settings stored key by key, with Ana\'s fill and Budi\'s stroke', async () => {
      const saved = new Y.Doc()
      Y.applyUpdate(saved, (await server.projects.storedState(deckId))!)
      expect(box(saved)).toBeInstanceOf(Y.Map)
      expect((box(saved) as Y.Map<unknown>).toJSON()).toEqual({ shape: 'rect', fill: '#22d3ee', stroke: '#0f172a' })
    })
  })

  Scenario('The apps join with a token for the API', ({ Given, When, Then, But }) => {
    let token: string
    let app: LivePage
    Given('Ana\'s app signed in and holds a token for the API', async () => {
      token = await appToken(anaBrowser)
    })
    When('the app opens the deck live with its token', () => {
      app = openLive(deckId, { token })
    })
    Then('the app gets the deck\'s 3 slides', async () => {
      await synced(app)
      expect(slidesOf(app.doc)).toHaveLength(3)
      expect(app.scopes).toEqual(['read-write'])
    })
    But('a token Claude Code got for the MCP server is refused', async () => {
      await connectClaude()
      const mcpToken = claudeAuth.tokens()!.access_token
      const page = openLive(deckId, { token: mcpToken })
      await vi.waitFor(() => expect(page.refusals).toEqual(['permission-denied']), SOON)
    })
  })

  Scenario('The deck is saved and loads again after everyone leaves', ({ Given, When, And, Then }) => {
    Given('Ana has the deck open live', async () => {
      ana = await openSynced({ browser: anaBrowser })
    })
    When('Ana changes slide 2 to "# Insertion sort"', async () => {
      changeSlide(ana.doc, 2, '# Insertion sort')
      await sent(ana)
    })
    And('Ana closes the deck', () => closeDeck(ana))
    Then('the live deck is unloaded and the saved deck has "# Insertion sort" on slide 2', async () => {
      expect(server.collab.getDocumentsCount()).toBe(0)
      expect((await savedSlides())[1]).toContain('# Insertion sort')
    })
    When('Ana opens the deck live again', async () => {
      ana = await openSynced({ browser: anaBrowser })
    })
    Then('Ana sees "# Insertion sort" on slide 2', () => seesOnSlide(ana, '# Insertion sort', 2))
  })

  Scenario('A stopping server saves every open deck first', ({ Given, When, And, Then }) => {
    Given('Ana has the deck open live', async () => {
      ana = await openSynced({ browser: anaBrowser })
    })
    When('Ana changes slide 2 to "# Insertion sort"', async () => {
      changeSlide(ana.doc, 2, '# Insertion sort')
      await sent(ana)
    })
    And('the server stops', async () => {
      // What the server's shutdown does before it closes the database.
      unsavedRooms = await storeAllRooms(server.collab)
    })
    Then('every live deck was saved and unloaded, and the saved deck has "# Insertion sort" on slide 2', async () => {
      expect(unsavedRooms).toEqual([])
      expect(server.collab.getDocumentsCount()).toBe(0)
      expect((await savedSlides())[1]).toContain('# Insertion sort')
    })
  })

  Scenario('A save that fails is tried again, and nothing is lost meanwhile', ({ Given, And, When, Then }) => {
    Given('Ana has the deck open live', async () => {
      ana = await openSynced({ browser: anaBrowser })
    })
    And('the next save fails', () => failSaves(1))
    When('Ana changes slide 2 to "# Insertion sort"', async () => {
      changeSlide(ana.doc, 2, '# Insertion sort')
      await sent(ana)
    })
    And('Ana closes the deck once that save failed', async () => {
      // The room saves 2 seconds after the change.
      await vi.waitFor(() => expect(failedSaves).toBe(1), SOON)
      close(ana)
    })
    Then('soon the saved deck has "# Insertion sort" on slide 2, and the live deck is unloaded', async () => {
      await vi.waitFor(() => expect(room()).toBeUndefined(), SOON)
      expect((await savedSlides())[1]).toContain('# Insertion sort')
    })
  })

  Scenario('Claude Code is told when its change is in the deck but not saved yet', ({ Given, And, When, Then }) => {
    Given('Claude Code is connected as Ana and has read the deck', async () => {
      await connectClaude()
      await readDeck()
    })
    And('the next save fails', () => failSaves(1))
    When('Claude Code replaces slide 3 with "# Quick sort"', async () => {
      await callTool('edit_slides', { deckId, edits: [{ action: 'replace', slide: 3, text: '# Quick sort' }] })
    })
    Then('Claude Code is told "The change is in the deck, but the server could not save it yet. It keeps trying. Do not send the change again."', () => {
      expect(result.isError).toBe(true)
      expect(resultText()).toBe('The change is in the deck, but the server could not save it yet. It keeps trying. Do not send the change again.')
      expect(room()).toBeDefined()
    })
    And('soon the saved deck has "# Quick sort" on slide 3', async () => {
      await vi.waitFor(() => expect(room()).toBeUndefined(), SOON)
      expect(await savedSlides()).toEqual([SORTING_SLIDES[0], SORTING_SLIDES[1], expect.stringContaining('# Quick sort')])
    })
  })

  Scenario('A stopping server names the decks it could not save', ({ Given, And, When, Then }) => {
    Given('Ana has the deck open live', async () => {
      ana = await openSynced({ browser: anaBrowser })
    })
    And('every save fails', () => failSaves(Number.POSITIVE_INFINITY))
    When('Ana changes slide 2 to "# Insertion sort"', async () => {
      changeSlide(ana.doc, 2, '# Insertion sort')
      await sent(ana)
    })
    And('the server stops', async () => {
      unsavedRooms = await storeAllRooms(server.collab, 1000)
    })
    Then('the server names the deck as not saved', () => {
      expect(failedSaves).toBeGreaterThan(0)
      expect(unsavedRooms).toEqual([roomName(deckId)])
    })
  })

  Scenario('Claude Code\'s edit reaches open pages and keeps an edit made a second earlier', ({ Given, And, When, Then }) => {
    Given('Ana shared the project with Budi as an editor', () => shareWithBudi('editor'))
    And('Ana and Budi have the deck open live', anaAndBudiOpen)
    And('Claude Code is connected as Ana and has read the deck', async () => {
      await connectClaude()
      await readDeck()
    })
    When('Budi changes slide 2 to "# Insertion sort"', async () => {
      changeSlide(budi.doc, 2, '# Insertion sort')
      await sent(budi)
    })
    And('a second later Claude Code replaces slide 3 with "# Quick sort"', async () => {
      await sleep(1000)
      await call('edit_slides', { deckId, edits: [{ action: 'replace', slide: 3, text: '# Quick sort' }] })
    })
    Then('Ana and Budi see "# Quick sort" on slide 3', async () => {
      await seesOnSlide(ana, '# Quick sort', 3)
      await seesOnSlide(budi, '# Quick sort', 3)
    })
    And('Ana and Budi still see "# Insertion sort" on slide 2', () => {
      expect(slidesOf(ana.doc)[1]).toContain('# Insertion sort')
      expect(slidesOf(budi.doc)[1]).toContain('# Insertion sort')
    })
  })

  Scenario('A whole deck from Claude Code keeps what people changed since its read', ({ Given, And, When, Then }) => {
    Given('Ana shared the project with Budi as an editor', () => shareWithBudi('editor'))
    And('Ana and Budi have the deck open live', anaAndBudiOpen)
    And('Claude Code is connected as Ana and has read the deck', async () => {
      await connectClaude()
      await readDeck()
    })
    When('Budi changes slide 2 to "# Insertion sort"', async () => {
      changeSlide(budi.doc, 2, '# Insertion sort')
      await sent(budi)
    })
    And('Claude Code writes the deck it read with slide 3 changed to "# Quick sort"', async () => {
      expect(read).toContain('# Bubble sort')
      await call('write_deck', { deckId, markdown: read.replace('# Merge sort', '# Quick sort') })
    })
    Then('Ana and Budi see "# Quick sort" on slide 3', async () => {
      await seesOnSlide(ana, '# Quick sort', 3)
      await seesOnSlide(budi, '# Quick sort', 3)
    })
    And('Ana and Budi still see "# Insertion sort" on slide 2', () => {
      expect(slidesOf(ana.doc)[1]).toContain('# Insertion sort')
      expect(slidesOf(budi.doc)[1]).toContain('# Insertion sort')
    })
    And('Claude Code is told its Markdown was merged, and the deck now has "Insertion sort" as slide 2', () => {
      expect(resultText()).toMatch(/^Saved, merged with what people changed since you read the deck\. The deck now has these slides:\n/)
      expect(resultText()).toContain('\n2. Insertion sort\n3. Quick sort\n')
    })
  })

  Scenario('Slide numbers in Claude Code\'s edits mean the slides it read', ({ Given, And, When, Then }) => {
    Given('Ana shared the project with Budi as an editor', () => shareWithBudi('editor'))
    And('Budi has the deck open live', async () => {
      budi = await openSynced({ browser: budiBrowser })
    })
    And('Claude Code is connected as Ana and has read the deck', async () => {
      await connectClaude()
      await readDeck()
    })
    When('Budi adds "# Insertion sort" as slide 2', async () => {
      const slides = slidesOf(budi.doc)
      slides.splice(1, 0, '# Insertion sort')
      applyMarkdown(budi.doc, joinSlides(slides))
      await sent(budi)
    })
    And('Claude Code replaces slide 3 with "# Quick sort"', async () => {
      // Slide 3 of what Claude read is "Merge sort", now the fourth slide.
      await call('edit_slides', { deckId, edits: [{ action: 'replace', slide: 3, text: '# Quick sort' }] })
    })
    Then('Budi sees the slides "Sorting", "Insertion sort", "Bubble sort" and "Quick sort"', async () => {
      await vi.waitFor(() => expect(headingsOf(slidesOf(budi.doc))).toEqual(['Sorting', 'Insertion sort', 'Bubble sort', 'Quick sort']), SOON)
    })
    And('Claude Code is told the slides numbered as it knows them, "Sorting", "Bubble sort" and "Quick sort", and that someone added "Insertion sort"', () => {
      expect(resultText()).toContain('The deck now has these slides, numbered as you know them:\n1. Sorting\n2. Bubble sort\n3. Quick sort\nSomeone also added slides you have not read: "Insertion sort".\n')
    })
  })

  Scenario('Claude Code\'s next edit by the numbers it was just shown lands on the slide it means', ({ Given, And, When, Then }) => {
    Given('Ana shared the project with Budi as an editor', () => shareWithBudi('editor'))
    And('Budi has the deck open live', async () => {
      budi = await openSynced({ browser: budiBrowser })
    })
    And('Claude Code is connected as Ana and has read the deck', async () => {
      await connectClaude()
      await readDeck()
    })
    /** The number Claude's last answer gave the slide with this title. */
    const numberOf = (title: string) => Number(resultText().match(new RegExp(`^(\\d+)\\. ${title}$`, 'm'))![1])
    When('Budi adds "# Agenda" as slide 2 from the slide strip', async () => {
      insertSlide(budi.doc, 1, { id: newId('s'), frontmatter: {}, elements: [{ id: newId('e'), type: 'raw', markdown: '# Agenda' }] })
      await sent(budi)
      expect(headingsOf(slidesOf(budi.doc))).toEqual(['Sorting', 'Agenda', 'Bubble sort', 'Merge sort'])
    })
    And('Claude Code replaces slide 3 with "# Merge sort, edited"', async () => {
      await call('edit_slides', { deckId, edits: [{ action: 'replace', slide: 3, text: '# Merge sort, edited' }] })
    })
    And('Claude Code replaces "Bubble sort", by the number its answer gave it, with "# Bubble sort, edited"', async () => {
      await call('edit_slides', { deckId, edits: [{ action: 'replace', slide: numberOf('Bubble sort'), text: '# Bubble sort, edited' }] })
    })
    Then('Budi sees the slides "Sorting", "Agenda", "Bubble sort, edited" and "Merge sort, edited"', async () => {
      await vi.waitFor(() => expect(headingsOf(slidesOf(budi.doc))).toEqual(['Sorting', 'Agenda', 'Bubble sort, edited', 'Merge sort, edited']), SOON)
    })
    When('Claude Code draws "Bubble sort, edited", by the number its answer gave it', async () => {
      const number = numberOf('Bubble sort, edited')
      drawn.length = 0
      await call('render_slides', { deckId, slides: [number] })
    })
    Then('the renderer drew "# Bubble sort, edited"', () => {
      expect(drawn).toEqual(['# Bubble sort, edited'])
    })
    When('Budi deletes the slide "Sorting" and Claude Code draws slide 1', async () => {
      deleteSlide(budi.doc, readDeckDoc(budi.doc).slides[0]!.id)
      await sent(budi)
      await callTool('render_slides', { deckId, slides: [1] })
    })
    Then('Claude Code is told someone deleted slide 1 since it last read the deck', () => {
      expect(result.isError).toBe(true)
      expect(resultText()).toBe('Someone deleted slide 1 since you last read the deck. Call read_deck to see the deck as it is now.')
    })
  })

  Scenario('Each Claude Code session\'s write keeps what people changed since that session read', ({ Given, And, When, Then }) => {
    Given('Ana shared the project with Budi as an editor', () => shareWithBudi('editor'))
    And('Budi has the deck open live', async () => {
      budi = await openSynced({ browser: budiBrowser })
    })
    And('Claude Code is connected as Ana and has read the deck', async () => {
      await connectClaude()
      await readDeck()
    })
    When('Budi changes slide 2 to "# Insertion sort"', async () => {
      changeSlide(budi.doc, 2, '# Insertion sort')
      await sent(budi)
    })
    And('another Claude Code session of Ana\'s reads the deck', async () => {
      otherClaude = await connectMcp(server, claudeAuth)
      await call('read_deck', { deckId }, otherClaude)
    })
    And('the first session writes the deck it read with slide 3 changed to "# Quick sort"', async () => {
      expect(read).toContain('# Bubble sort')
      await call('write_deck', { deckId, markdown: read.replace('# Merge sort', '# Quick sort') })
    })
    Then('Budi sees "# Quick sort" on slide 3', () => seesOnSlide(budi, '# Quick sort', 3))
    And('Budi still sees "# Insertion sort" on slide 2', () => {
      expect(slidesOf(budi.doc)[1]).toContain('# Insertion sort')
    })
  })

  Scenario('Edits Claude Code sends at the same time are not made again by its next write', ({ Given, When, And, Then }) => {
    Given('Claude Code is connected as Ana and has read the deck', async () => {
      await connectClaude()
      await readDeck()
    })
    When('Claude Code replaces slide 3 with "# Quick sort" while it adds "# Heap sort" as slide 4', async () => {
      // Both calls start from what Claude read, before either one changes the deck.
      const open = server.collab.openDirectConnection.bind(server.collab)
      let arrived = 0
      let bothArrived!: () => void
      const both = new Promise<void>(resolve => (bothArrived = resolve))
      server.collab.openDirectConnection = async (name, context) => {
        if (++arrived === 2)
          bothArrived()
        await both
        return open(name, context)
      }
      try {
        await Promise.all([
          call('edit_slides', { deckId, edits: [{ action: 'replace', slide: 3, text: '# Quick sort' }] }),
          call('edit_slides', { deckId, edits: [{ action: 'insert', position: 4, text: '# Heap sort' }] }),
        ])
      }
      finally {
        server.collab.openDirectConnection = open
      }
    })
    And('Claude Code writes the deck with both changes', async () => {
      await call('write_deck', { deckId, markdown: '---\ntitle: Sorting\n---\n\n# Sorting\n\n---\n\n# Bubble sort\n\n---\n\n# Quick sort\n\n---\n\n# Heap sort\n' })
    })
    Then('the saved deck has the slides "Sorting", "Bubble sort", "Quick sort" and "Heap sort"', async () => {
      const saved = await savedSlides()
      expect(headingsOf(saved)).toEqual(['Sorting', 'Bubble sort', 'Quick sort', 'Heap sort'])
      expect(saved.slice(2).map(slide => slide.trim())).toEqual(['# Quick sort', '# Heap sort'])
    })
  })

  Scenario('A whole deck from Claude Code that never read it says it replaced the deck', ({ Given, When, Then }) => {
    Given('Claude Code is connected as Ana', connectClaude)
    When('Claude Code writes a deck with the slides "Sorting" and "Heap sort" without reading it first', async () => {
      await call('write_deck', { deckId, markdown: HEAP })
    })
    Then('Claude Code is told its Markdown replaced the whole deck', () => {
      expect(resultText()).toBe('Saved. There was no read of this deck to merge with (reads are kept for an hour), so your Markdown replaced the whole deck. The deck now has these slides:\n1. Sorting\n2. Heap sort\n\nCheck them with render_slides.')
    })
  })

  Scenario('The reads the server keeps for one person do not push out another person\'s', ({ Given, When, Then, And }) => {
    let bases: RecentBases
    const state = () => new Uint8Array(10)
    Given('the server keeps at most 2 reads for each person and 3 in all', () => {
      bases = new RecentBases({ ...BASE_LIMITS, count: 3, personCount: 2 })
    })
    When('Ana\'s Claude Code reads one deck and Budi\'s reads five', () => {
      bases.set('ana', 'ana:deck-1', state())
      for (let number = 1; number <= 5; number++)
        bases.set('budi', `budi:deck-${number}`, state())
    })
    Then('Ana\'s read is still kept', () => {
      expect(bases.get('ana:deck-1')).toBeDefined()
    })
    And('of Budi\'s reads only the last two are kept', () => {
      expect([1, 2, 3, 4, 5].map(number => bases.get(`budi:deck-${number}`) !== undefined)).toEqual([false, false, false, true, true])
    })
  })

  Scenario('A change from Claude Code that would make the deck too big is refused, and people keep their work', ({ Given, And, When, Then }) => {
    const long = `# Bubble sort\n\n${'notes '.repeat(20_000)}`
    Given('Ana shared the project with Budi as an editor', () => shareWithBudi('editor'))
    And('Budi has the deck open live', async () => {
      budi = await openSynced({ browser: budiBrowser })
    })
    And('Claude Code is connected as Ana and has read the deck', async () => {
      await connectClaude()
      await readDeck()
    })
    When('Budi writes 120000 characters on slide 2', async () => {
      changeSlide(budi.doc, 2, long)
      await sent(budi)
    })
    And('Claude Code writes the deck it read with a slide of 90000 characters added', async () => {
      await callTool('write_deck', { deckId, markdown: `${read}\n---\n\n# Appendix\n\n${'words '.repeat(15_000)}\n` })
    })
    Then('Claude Code is told "Nothing was saved. This deck is too big to save. Remove some content."', () => {
      expect(result.isError).toBe(true)
      expect(resultText()).toBe('Nothing was saved. This deck is too big to save. Remove some content.')
    })
    And('Budi is still connected and never saw that slide', async () => {
      // Time for a close or an update to arrive, if one were sent.
      await sleep(300)
      expect(budi.closes).toEqual([])
      expect(slidesOf(budi.doc).some(slide => slide.includes('# Appendix'))).toBe(false)
    })
    When('Budi closes the deck', () => closeDeck(budi))
    Then('the saved deck has Budi\'s 120000 characters on slide 2', async () => {
      expect((await savedSlides())[1].trim()).toBe(long.trim())
    })
  })

  Scenario('The server reads a deck as it is live, before it is saved', ({ Given, And, When, Then, But }) => {
    Given('Ana has the deck open live', async () => {
      ana = await openSynced({ browser: anaBrowser })
    })
    And('Claude Code is connected as Ana', connectClaude)
    When('Ana changes slide 2 to "# Insertion sort"', async () => {
      changeSlide(ana.doc, 2, '# Insertion sort')
      await sent(ana)
    })
    Then('the saved deck still has "# Bubble sort" on slide 2', async () => {
      expect((await savedSlides())[1]).toContain('# Bubble sort')
    })
    But('the deck\'s state from the API has "# Insertion sort" on slide 2', async () => {
      const response = await anaBrowser.request(`/api/decks/${deckId}/state`)
      expect(response.status).toBe(200)
      expect(slidesIn(new Uint8Array(await response.arrayBuffer()))[1]).toContain('# Insertion sort')
    })
    And('Claude Code reads "# Insertion sort" on slide 2', async () => {
      await readDeck()
      expect(read).toContain('# Insertion sort')
      expect(read).not.toContain('# Bubble sort')
    })
  })

  Scenario('Claude Code writing while a page connects loses nothing', ({ Given, When, Then }) => {
    Given('Claude Code is connected as Ana', connectClaude)
    When('Ana\'s page connects while Claude Code writes a deck with the slides "Sorting" and "Heap sort"', async () => {
      // The page's connection starts loading the room and reads the saved
      // deck. The write joins the same room while it still loads.
      const loading = holdLoading()
      ana = openLive(deckId, { browser: anaBrowser })
      await loading.entered
      const open = server.collab.openDirectConnection.bind(server.collab)
      let joinedWhileLoading: boolean | undefined
      server.collab.openDirectConnection = (name, context) => {
        joinedWhileLoading = server.collab.loadingDocuments.has(name) && !server.collab.documents.has(name)
        return open(name, context)
      }
      try {
        const writing = call('write_deck', { deckId, markdown: HEAP })
        await vi.waitFor(() => expect(joinedWhileLoading).toBe(true), SOON)
        loading.release()
        await writing
      }
      finally {
        server.collab.openDirectConnection = open
      }
      await synced(ana)
    })
    Then('Ana\'s page shows the slides "Sorting" and "Heap sort"', async () => {
      await vi.waitFor(() => expect(headingsOf(slidesOf(ana.doc))).toEqual(['Sorting', 'Heap sort']), SOON)
    })
    When('Ana closes the deck', () => closeDeck(ana))
    Then('the saved deck has the slides "Sorting" and "Heap sort"', async () => {
      expect(headingsOf(await savedSlides())).toEqual(['Sorting', 'Heap sort'])
    })
  })

  Scenario('Someone removed while their page is still joining is let go too', ({ Given, And, When, Then }) => {
    let loading: ReturnType<typeof holdLoading>
    Given('Ana shared the project with Budi as an editor', () => shareWithBudi('editor'))
    And('the deck takes a moment to load', () => {
      loading = holdLoading()
    })
    When('Budi opens the deck live', () => {
      budi = openLive(deckId, { browser: budiBrowser })
    })
    And('Ana removes Budi from the project while the deck loads', async () => {
      // Budi's access was checked; the room loads for him now.
      await loading.entered
      await removeBudi()
      expect(room()).toBeUndefined()
      loading.release()
    })
    Then('Budi\'s connection closes because access changed, and joining again is refused', () => closesBecauseAccessChanged(budi))
  })

  Scenario('A removed person\'s client that ignores the closing socket changes nothing', ({ Given, And, When, Then }) => {
    let socket: { pause: () => void, resume: () => void }
    Given('Ana shared the project with Budi as an editor', () => shareWithBudi('editor'))
    And('Ana and Budi have the deck open live', anaAndBudiOpen)
    And('Budi\'s client stops reading from its socket', () => {
      // It never sees the server close the socket, so it keeps sending.
      socket = (budi.socket.webSocket as unknown as { _socket: typeof socket })._socket
      socket.pause()
    })
    When('Ana removes Budi from the project', removeBudi)
    And('Budi\'s client changes slide 2 to "# Still here"', async () => {
      changeSlide(budi.doc, 2, '# Still here')
      // Time for the change to reach the server.
      await sleep(1000)
    })
    Then('the live deck still has "# Bubble sort" on slide 2', () => {
      expect(slidesOf(room()!)[1]).toContain('# Bubble sort')
      expect(slidesOf(ana.doc)[1]).toContain('# Bubble sort')
      socket.resume()
    })
  })

  Scenario('Removing someone closes their connection while the others keep editing', ({ Given, And, When, Then }) => {
    Given('Ana shared the project with Budi and Citra as editors', async () => {
      await shareWithBudi('editor')
      citraBrowser = await signedInBrowser(server, 'citra@example.com', 'Citra')
      await share('citra@example.com', 'editor')
    })
    And('Ana, Budi and Citra have the deck open live', async () => {
      await anaAndBudiOpen()
      citra = await openSynced({ browser: citraBrowser })
    })
    When('Ana removes Budi from the project', removeBudi)
    Then('Budi\'s connection closes because access changed, and joining again is refused', () => closesBecauseAccessChanged(budi))
    And('Ana and Citra are still connected', () => {
      expect(ana.closes).toEqual([])
      expect(citra.closes).toEqual([])
    })
    When('Citra changes slide 2 to "# Insertion sort"', () => {
      changeSlide(citra.doc, 2, '# Insertion sort')
    })
    Then('Ana sees "# Insertion sort" on slide 2', () => seesOnSlide(ana, '# Insertion sort', 2))
  })

  Scenario('Deleting the deck lets everyone go', ({ Given, And, When, Then }) => {
    Given('Ana shared the project with Budi as an editor', () => shareWithBudi('editor'))
    And('Ana and Budi have the deck open live', anaAndBudiOpen)
    When('Ana deletes the deck', async () => {
      expect((await anaBrowser.request(`/api/decks/${deckId}`, { method: 'DELETE' })).status).toBe(204)
    })
    Then('Ana\'s and Budi\'s connections close because access changed, and joining again is refused', () => closesBecauseAccessChanged(ana, budi))
  })

  Scenario('Deleting the project lets everyone go', ({ Given, And, When, Then }) => {
    Given('Ana shared the project with Budi as an editor', () => shareWithBudi('editor'))
    And('Ana and Budi have the deck open live', anaAndBudiOpen)
    When('Ana deletes the project', async () => {
      expect((await anaBrowser.request(`/api/projects/${projectId}`, { method: 'DELETE' })).status).toBe(204)
    })
    Then('Ana\'s and Budi\'s connections close because access changed, and joining again is refused', () => closesBecauseAccessChanged(ana, budi))
  })

  Scenario('Someone who leaves the project is let go', ({ Given, And, When, Then }) => {
    Given('Ana shared the project with Budi as an editor', () => shareWithBudi('editor'))
    And('Ana and Budi have the deck open live', anaAndBudiOpen)
    When('Budi leaves the project', async () => {
      const left = await budiBrowser.request(`/api/projects/${projectId}/sharing/members/${await userIdOf(budiBrowser)}`, { method: 'DELETE' })
      expect(left.status).toBe(204)
    })
    Then('Budi\'s connection closes because access changed, and joining again is refused', () => closesBecauseAccessChanged(budi))
    And('Ana is still connected', () => {
      expect(ana.closes).toEqual([])
    })
  })

  Scenario('Signing out ends the live connection', ({ Given, When, Then }) => {
    Given('Ana has the deck open live', async () => {
      ana = await openSynced({ browser: anaBrowser })
    })
    When('Ana signs out', async () => {
      expect((await anaBrowser.request('/api/auth/sign-out', { json: {} })).status).toBe(200)
      expect(await anaBrowser.signedInEmail()).toBeUndefined()
    })
    Then('Ana\'s connection closes because access changed, and joining again is refused', () => closesBecauseAccessChanged(ana))
  })

  Scenario('Pages that only listen stay connected, and a client that stops answering is let go', ({ Given, And, When, Then, But }) => {
    let deaf: LivePage
    Given('connections that send nothing for a second are let go', () => {
      server.collab.configuration.timeout = 1000
    })
    And('Ana and a client that does not answer pings have the deck open live', async () => {
      ana = await openSynced({ browser: anaBrowser })
      deaf = openLive(deckId, { browser: anaBrowser }, { autoPong: false })
      await synced(deaf)
    })
    When('neither sends anything for two seconds', () => sleep(2000))
    Then('Ana is still connected', () => {
      expect(ana.closes).toEqual([])
    })
    But('the client that does not answer pings was let go', async () => {
      await vi.waitFor(() => expect(deaf.closes.length).toBeGreaterThan(0), SOON)
    })
  })

  Scenario('A new role applies at once', ({ Given, And, When, Then }) => {
    Given('Ana shared the project with Budi as an editor', () => shareWithBudi('editor'))
    And('Budi has the deck open live', async () => {
      budi = await openSynced({ browser: budiBrowser })
      expect(budi.scopes).toEqual(['read-write'])
    })
    When('Ana makes Budi a viewer', async () => {
      const changed = await anaBrowser.request(`/api/projects/${projectId}/sharing/members/${await userIdOf(budiBrowser)}`, { method: 'PATCH', json: { role: 'viewer' } })
      expect(changed.status).toBe(204)
    })
    Then('Budi\'s connection closes because access changed, and joins again read only', async () => {
      await vi.waitFor(() => expect(budi.closes).toEqual([ACCESS_CHANGED]), SOON)
      await vi.waitFor(() => expect(budi.scopes).toEqual(['read-write', 'readonly']), SOON)
    })
  })

  Scenario('Deleting every slide at the same time leaves one empty slide', ({ Given, And, When, Then }) => {
    Given('Ana shared the project with Budi as an editor', () => shareWithBudi('editor'))
    And('Ana and Budi have the deck open live', anaAndBudiOpen)
    When('Ana deletes slides 1 and 2 while Budi deletes slide 3', () => {
      // Both delete before either hears from the other, as on two computers.
      const [first, second, third] = slideMarkdowns(ana.doc).map(slide => slide.id)
      deleteSlide(ana.doc, first)
      deleteSlide(ana.doc, second)
      deleteSlide(budi.doc, third)
    })
    Then('Ana and Budi soon see one empty slide', async () => {
      for (const page of [ana, budi]) {
        await vi.waitFor(() => {
          expect((page.doc.getMap('deck').get('slides') as Y.Array<unknown>).length).toBe(1)
          expect(readDeckDoc(page.doc).slides[0].elements).toEqual([])
        }, SOON)
      }
    })
    When('Ana and Budi close the deck', () => closeDeck(ana, budi))
    Then('the saved deck has one empty slide', async () => {
      const doc = new Y.Doc()
      Y.applyUpdate(doc, (await server.projects.storedState(deckId))!)
      const saved = yDocToDeck(doc)
      expect(saved.slides).toHaveLength(1)
      expect(saved.slides[0].elements).toEqual([])
      const [project] = (await anaBrowser.json<Project[]>('/api/projects')).body
      expect(project.decks[0].slideCount).toBe(1)
    })
  })

  Scenario('A page that clears the whole deck gets it back as last saved', ({ Given, And, When, Then }) => {
    Given('Ana shared the project with Budi as an editor', () => shareWithBudi('editor'))
    And('Ana and Budi have the deck open live', anaAndBudiOpen)
    When('Budi\'s page clears the whole deck', () => {
      budi.doc.transact(() => {
        const root = budi.doc.getMap('deck')
        for (const key of [...root.keys()])
          root.delete(key)
      })
    })
    Then('Ana and Budi soon see the slides "Sorting", "Bubble sort" and "Merge sort" again', async () => {
      for (const page of [ana, budi])
        await vi.waitFor(() => expect(slidesOf(page.doc)).toEqual(SORTING_SLIDES), SOON)
    })
    When('Ana and Budi close the deck', () => closeDeck(ana, budi))
    Then('the saved deck has the slides "Sorting", "Bubble sort" and "Merge sort"', async () => {
      expect(await savedSlides()).toEqual(SORTING_SLIDES)
    })
  })

  Scenario('A deck past the content limit is not saved, and everyone is told', ({ Given, And, When, Then }) => {
    Given('Ana shared the project with Budi as an editor', () => shareWithBudi('editor'))
    And('Ana and Budi have the deck open live', anaAndBudiOpen)
    When('Ana adds a slide with 210000 characters of text', () => {
      insertSlide(ana.doc, 3, { id: newId('s'), frontmatter: {}, elements: [{ id: newId('e'), type: 'raw', markdown: 'words '.repeat(35_000) }] })
    })
    Then('Ana\'s and Budi\'s connections close with "This deck is too big to save. Remove some content."', async () => {
      for (const page of [ana, budi])
        await vi.waitFor(() => expect(page.closes).toEqual([TOO_BIG]), SOON)
    })
    And('the saved deck still has the slides "Sorting", "Bubble sort" and "Merge sort"', async () => {
      await vi.waitFor(() => expect(room()).toBeUndefined(), SOON)
      expect(await savedSlides()).toEqual(SORTING_SLIDES)
    })
  })

  Scenario('A deck that grows too big keeps the changes made a moment before', ({ Given, And, When, Then }) => {
    Given('Ana shared the project with Budi as an editor', () => shareWithBudi('editor'))
    And('Ana and Budi have the deck open live', anaAndBudiOpen)
    When('Budi changes slide 2 to "# Insertion sort"', async () => {
      changeSlide(budi.doc, 2, '# Insertion sort')
      await sent(budi)
    })
    And('a moment later, before the deck is saved, Ana adds a slide with 210000 characters of text', async () => {
      // After the room checked Budi's change, and well before it saves (2 seconds after the last change).
      await sleep(CHECK_DELAY_MS + 300)
      expect(headingsOf(await savedSlides())).toEqual(['Sorting', 'Bubble sort', 'Merge sort'])
      insertSlide(ana.doc, 3, { id: newId('s'), frontmatter: {}, elements: [{ id: newId('e'), type: 'raw', markdown: 'words '.repeat(35_000) }] })
    })
    Then('Ana\'s and Budi\'s connections close with "This deck is too big to save. Remove some content."', async () => {
      for (const page of [ana, budi])
        await vi.waitFor(() => expect(page.closes).toEqual([TOO_BIG]), SOON)
    })
    And('the saved deck has the slides "Sorting", "Insertion sort" and "Merge sort"', async () => {
      await vi.waitFor(() => expect(room()).toBeUndefined(), SOON)
      expect(headingsOf(await savedSlides())).toEqual(['Sorting', 'Insertion sort', 'Merge sort'])
    })
  })

  Scenario('A deck past 500 slides is not saved either', ({ Given, When, Then, And }) => {
    Given('Ana has the deck open live', async () => {
      ana = await openSynced({ browser: anaBrowser })
    })
    When('Ana adds slides until the deck has 501', () => {
      ana.doc.transact(() => {
        for (let number = 4; number <= 501; number++)
          insertSlide(ana.doc, number - 1, { id: newId('s'), frontmatter: {}, elements: [{ id: newId('e'), type: 'raw', markdown: `# Slide ${number}` }] })
      })
      expect(slidesOf(ana.doc)).toHaveLength(501)
    })
    Then('Ana\'s connection closes with "This deck is too big to save. Remove some content."', async () => {
      await vi.waitFor(() => expect(ana.closes).toEqual([TOO_BIG]), SOON)
    })
    And('the saved deck still has the slides "Sorting", "Bubble sort" and "Merge sort"', async () => {
      await vi.waitFor(() => expect(room()).toBeUndefined(), SOON)
      expect(await savedSlides()).toEqual(SORTING_SLIDES)
    })
  })

  Scenario('A page whose changes would take the deck\'s data past 5 MB is let go, and the others keep editing', ({ Given, When, Then, And }) => {
    Given('Ana shared the project with Budi as an editor', () => shareWithBudi('editor'))
    And('Ana and Budi have the deck open live', anaAndBudiOpen)
    When('Budi\'s page stores 1 MB of data that no slide shows, 6 times', () => {
      // Each change goes in a message of its own.
      for (let index = 1; index <= 6; index++)
        budi.doc.getMap('deck').set(`unused-${index}`, String(index).repeat(1_000_000))
    })
    Then('Budi\'s connection closes with "This deck is too big to save. Remove some content."', async () => {
      await vi.waitFor(() => expect(budi.closes).toEqual([TOO_BIG]), SOON)
    })
    And('the live deck holds no more than 5 MB', () => {
      expect(Y.encodeStateAsUpdate(room()!).byteLength).toBeLessThanOrEqual(5 * 1024 * 1024)
      expect(room()!.getMap('deck').has('unused-6')).toBe(false)
    })
    When('Ana changes slide 2 to "# Insertion sort"', () => {
      changeSlide(ana.doc, 2, '# Insertion sort')
    })
    And('Ana closes the deck', async () => {
      await sent(ana)
      expect(ana.closes).toEqual([])
      await closeDeck(ana)
    })
    Then('the saved deck has the slides "Sorting", "Insertion sort" and "Merge sort"', async () => {
      expect(headingsOf(await savedSlides())).toEqual(['Sorting', 'Insertion sort', 'Merge sort'])
    })
    And('it holds no more than 5 MB', async () => {
      expect((await server.projects.storedState(deckId))!.byteLength).toBeLessThanOrEqual(5 * 1024 * 1024)
    })
  })

  Scenario('A change too big for one message never reaches the deck', ({ Given, When, Then, And }) => {
    Given('Ana shared the project with Budi as an editor', () => shareWithBudi('editor'))
    And('Ana and Budi have the deck open live', anaAndBudiOpen)
    When('Budi\'s page stores 3 MB of data that no slide shows in one change', () => {
      budi.doc.getMap('deck').set('unused', 'x'.repeat(3_000_000))
    })
    Then('Budi\'s connection closes with "This deck is too big to save. Remove some content."', async () => {
      await vi.waitFor(() => expect(budi.closes).toEqual([TOO_BIG]), SOON)
    })
    And('the live deck does not hold that data', () => {
      expect(room()!.getMap('deck').has('unused')).toBe(false)
    })
    And('Ana\'s connection stays open', async () => {
      await sleep(CHECK_DELAY_MS + 200)
      expect(ana.closes).toEqual([])
      changeSlide(ana.doc, 2, '# Insertion sort')
      await sent(ana)
      expect(slidesOf(room()!)[1]).toContain('# Insertion sort')
    })
  })

  Scenario('A page that writes anything but the deck is let go', ({ Given, When, Then, And }) => {
    Given('Ana shared the project with Budi as an editor', () => shareWithBudi('editor'))
    And('Ana and Budi have the deck open live', anaAndBudiOpen)
    When('Budi\'s page writes to a part of the document outside the deck', () => {
      budi.doc.getMap('elsewhere').set('unused', 'x'.repeat(1000))
    })
    Then('Budi\'s connection closes with "This change is not part of the deck."', async () => {
      await vi.waitFor(() => expect(budi.closes).toEqual([{ code: 4003, reason: 'This change is not part of the deck.' }]), SOON)
    })
    And('the live deck holds nothing outside the deck', () => {
      expect([...room()!.share.keys()]).toEqual(['deck'])
    })
    And('Ana\'s connection stays open', async () => {
      await sleep(CHECK_DELAY_MS + 200)
      expect(ana.closes).toEqual([])
      changeSlide(ana.doc, 2, '# Insertion sort')
      await sent(ana)
      expect(slidesOf(room()!)[1]).toContain('# Insertion sort')
    })
  })

  Scenario('Presence passes on only what pages show, and only a little of it', ({ Given, When, Then, And }) => {
    Given('Ana shared the project with Budi as a viewer', () => shareWithBudi('viewer'))
    And('Ana and Budi have the deck open live', anaAndBudiOpen)
    const budiSeen = () => ana.provider.awareness!.getStates().get(budi.doc.clientID)
    When('Budi\'s page adds a field of its own to its presence', () => {
      budi.provider.setAwarenessField('slideId', 'first')
      budi.provider.setAwarenessField('banner', 'Click here')
    })
    Then('Ana sees Budi\'s presence without that field', async () => {
      await vi.waitFor(() => expect(budiSeen()?.slideId).toBe('first'), SOON)
      expect(budiSeen()).not.toHaveProperty('banner')
    })
    const seen: unknown[] = []
    When('Budi\'s page goes to slide "second" with 100 KB in its selection', () => {
      ana.provider.awareness!.on('change', () => seen.push(budiSeen()?.slideId, budiSeen()?.selection))
      budi.provider.setAwarenessField('slideId', 'second')
      budi.provider.setAwarenessField('selection', ['e'.repeat(100 * 1024)])
    })
    And('then goes to slide "third" with nothing selected', () => {
      budi.provider.setAwarenessField('selection', [])
      budi.provider.setAwarenessField('slideId', 'third')
    })
    Then('Ana sees Budi on slide "third", and never saw slide "second" or that selection', async () => {
      await vi.waitFor(() => expect(budiSeen()?.slideId).toBe('third'), SOON)
      expect(budiSeen()?.selection).toEqual([])
      expect(seen).not.toContain('second')
      expect(seen.some(selection => Array.isArray(selection) && selection.length > 0)).toBe(false)
    })
  })

  Scenario('Decks too big to edit live cannot be added', ({ When, Then }) => {
    const refusal = { status: 400, body: { error: 'This deck is too big to save. Remove some content.' } }
    When('Ana adds a deck with 501 slides', async () => {
      const markdown = Array.from({ length: 501 }, (_, index) => `# Slide ${index + 1}`).join('\n\n---\n\n')
      answer = await anaBrowser.json(`/api/projects/${projectId}/decks`, { json: { name: 'Every sort', state: stateOf(markdown) } })
    })
    Then('it is refused with "This deck is too big to save. Remove some content."', () => {
      expect(answer).toEqual(refusal)
    })
    When('Ana imports a project with a deck of 210000 characters', async () => {
      const now = Date.now()
      answer = await anaBrowser.json('/api/import', {
        json: { projects: [{ id: 'browser-project', name: 'Long talk', createdAt: now, updatedAt: now, decks: [{ id: 'browser-deck', name: 'Long talk', createdAt: now, updatedAt: now, state: stateOf(`# Long talk\n\n${'words '.repeat(35_000)}`) }] }] },
      })
    })
    Then('that is refused the same way', () => {
      expect(answer).toEqual(refusal)
    })
  })

  Scenario('Pages that save whole decks wait until nobody has the deck open live', ({ Given, When, Then, And }) => {
    Given('Ana has the deck open live', async () => {
      ana = await openSynced({ browser: anaBrowser })
    })
    When('an older page saves a whole deck for Ana', savesWholeDeck)
    Then('it is refused with "This deck is open for live editing. Reload the page to keep editing."', () => {
      expect(answer).toEqual({ status: 400, body: { error: LIVE_EDITING } })
      expect(LIVE_EDITING).toBe('This deck is open for live editing. Reload the page to keep editing.')
    })
    When('Ana closes the deck', () => closeDeck(ana))
    And('an older page saves a whole deck for Ana', savesWholeDeck)
    Then('the saved deck has the older page\'s content', async () => {
      expect(answer.status).toBe(204)
      expect(await savedSlides()).toEqual([expect.stringContaining('# Older')])
    })
  })
})
