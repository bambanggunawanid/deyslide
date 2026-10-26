// @vitest-environment node
import type { Project } from '../apps/server/src/projects'
import type { DeckConnection } from '../apps/web/src/projects/collab'
import type { Listening, TestBrowser, TestServer } from './support/server'
import { Buffer } from 'node:buffer'
import { describeFeature, loadFeature } from '@amiceli/vitest-cucumber'
import { beforeAll, expect, vi } from 'vitest'
import { watch } from 'vue'
import WebSocket from 'ws'
import { Awareness } from 'y-protocols/awareness'
import * as Y from 'yjs'
import { roomName } from '../apps/server/src/collab/rooms'
import { statusLabel } from '../apps/web/src/deck/session'
import { HttpProjectApi } from '../apps/web/src/projects/api'
import { applyMarkdown, deckToYDoc, fromMarkdown, insertSlide, joinSlides, newId, SHAPE_REFUSED, slideMarkdowns } from '../packages/deck-model/src'
import { closeTestServers, createTestServer, DATABASE_WARM_UP_MS, signedInBrowser, TEST_ORIGIN, warmUpDatabase } from './support/server'

const feature = await loadFeature('./deck-connection.feature')

beforeAll(warmUpDatabase, DATABASE_WARM_UP_MS)

const SORTING = '---\ntitle: Sorting\n---\n\n# Sorting\n\n---\n\n# Bubble sort\n\n---\n\n# Merge sort\n'
/** How long a scenario waits for something to arrive over a socket. */
const SOON = { timeout: 4000, interval: 20 }

const slidesOf = (doc: Y.Doc) => slideMarkdowns(doc).map(slide => slide.markdown)
const stateOf = (markdown: string) => Buffer.from(Y.encodeStateAsUpdate(deckToYDoc(fromMarkdown(markdown)))).toString('base64')

/** A page with the deck open: its document, its connection, and the tokens it handed over. */
interface Page {
  doc: Y.Doc
  awareness: Awareness
  connection: DeckConnection
  tokens: number
}

describeFeature(feature, ({ Background, Scenario, AfterEachScenario }) => {
  let server: TestServer
  let listening: Listening
  let anaBrowser: TestBrowser
  let budiBrowser: TestBrowser
  let projectId: string
  let deckId: string
  let pages: Page[] = []
  let page: Page

  AfterEachScenario(async () => {
    for (const open of pages.splice(0)) {
      open.connection.destroy()
      open.doc.destroy()
    }
    await closeTestServers()
  })

  /** Connects the way the web app does, from a page on the site with the browser's cookie. */
  function connect(browser: TestBrowser, token = async () => 'cookie') {
    class PageSocket extends WebSocket {
      constructor(address: string | URL) {
        super(address, { headers: { cookie: browser.cookieHeader(), origin: TEST_ORIGIN } })
      }
    }
    const api = new HttpProjectApi(undefined, { collabUrl: () => listening.collabUrl, WebSocketPolyfill: PageSocket })
    const doc = new Y.Doc()
    const awareness = new Awareness(doc)
    const opened: Page = { doc, awareness, connection: undefined as unknown as DeckConnection, tokens: 0 }
    opened.connection = api.connectDeck(deckId, doc, awareness, async () => {
      opened.tokens++
      return token()
    })
    pages.push(opened)
    return opened
  }

  async function connected(browser: TestBrowser) {
    const opened = connect(browser)
    await vi.waitFor(() => expect(opened.connection.synced.value).toBe(true), SOON)
    return opened
  }

  const label = (open: Page) => statusLabel(open.connection.status.value, open.connection.error.value)
  const room = () => server.collab.documents.get(roomName(deckId))

  async function shareWithBudi(role: 'editor' | 'viewer') {
    budiBrowser = await signedInBrowser(server, 'budi@example.com', 'Budi')
    const shared = await anaBrowser.json(`/api/projects/${projectId}/sharing`, { json: { email: 'budi@example.com', role } })
    expect(shared.status).toBe(201)
  }

  async function budiId() {
    return (await budiBrowser.json<{ id: string }>('/api/me')).body.id
  }

  Background(({ Given }) => {
    Given('the Deyslide API on a port with live editing, and Ana\'s deck "Sorting" of three slides', async () => {
      server = await createTestServer()
      listening = await server.listen({ pingIntervalMs: 200 })
      anaBrowser = await signedInBrowser(server, 'ana@example.com', 'Ana')
      projectId = (await anaBrowser.json<Project>('/api/projects', { json: { name: 'Talks' } })).body.id
      deckId = (await anaBrowser.json<{ id: string }>(`/api/projects/${projectId}/decks`, { json: { name: 'Sorting', state: stateOf(SORTING) } })).body.id
    })
  })

  Scenario('A page joins the deck live, sends its changes and says "Saved"', ({ When, Then }) => {
    When('Ana\'s page connects to the deck', () => {
      page = connect(anaBrowser)
      expect(page.connection.readOnly.value).toBe(true)
      expect(label(page)).toBe('Connecting...')
    })
    Then('the connection holds the deck, can be changed and says "Saved"', async () => {
      await vi.waitFor(() => expect(label(page)).toBe('Saved'), SOON)
      expect(page.connection.synced.value).toBe(true)
      expect(page.connection.readOnly.value).toBe(false)
      expect(slidesOf(page.doc)).toHaveLength(3)
      expect(page.tokens).toBe(1)
    })
    When('the page changes slide 2 to "# Insertion sort"', () => {
      const slides = slidesOf(page.doc)
      slides[1] = '\n# Insertion sort\n'
      applyMarkdown(page.doc, joinSlides(slides))
    })
    Then('the server\'s live deck has "# Insertion sort" on slide 2, and the connection says "Saved"', async () => {
      await vi.waitFor(() => expect(slidesOf(room()!)[1]).toBe('\n# Insertion sort\n'), SOON)
      await vi.waitFor(() => expect(label(page)).toBe('Saved'), SOON)
    })
  })

  Scenario('A viewer\'s connection is read only', ({ Given, When, Then }) => {
    Given('Ana shared the project with Budi as a viewer', () => shareWithBudi('viewer'))
    When('Budi\'s page connects to the deck', () => {
      page = connect(budiBrowser)
    })
    Then('Budi\'s connection holds the deck, is read only and says "Saved"', async () => {
      await vi.waitFor(() => expect(page.connection.synced.value).toBe(true), SOON)
      expect(slidesOf(page.doc)).toHaveLength(3)
      expect(page.connection.readOnly.value).toBe(true)
      expect(label(page)).toBe('Saved')
    })
  })

  Scenario('A change a viewer\'s page sends anyway is turned down, and the page says so', ({ Given, And, When, Then }) => {
    Given('Ana shared the project with Budi as a viewer', () => shareWithBudi('viewer'))
    And('Budi\'s page is connected to the deck', async () => {
      page = await connected(budiBrowser)
      await vi.waitFor(() => expect(label(page)).toBe('Saved'), SOON)
    })
    When('Budi\'s page changes slide 2 to "# Insertion sort" anyway', () => {
      // A page that turned view only while a change was on its way.
      const slides = slidesOf(page.doc)
      slides[1] = '\n# Insertion sort\n'
      applyMarkdown(page.doc, joinSlides(slides))
    })
    Then('Budi\'s connection says "You can only view this deck now. Reload the page to see it as it is." and is read only', async () => {
      await vi.waitFor(() => expect(label(page)).toBe('Not saved: You can only view this deck now. Reload the page to see it as it is.'), SOON)
      expect(page.connection.readOnly.value).toBe(true)
      expect(page.connection.unsaved.value).toBe(false)
    })
    And('the server\'s live deck still has "# Bubble sort" on slide 2', async () => {
      const response = await anaBrowser.request(`/api/decks/${deckId}/state`)
      const doc = new Y.Doc()
      Y.applyUpdate(doc, new Uint8Array(await response.arrayBuffer()))
      expect(slidesOf(doc)[1]).toBe('\n# Bubble sort\n')
    })
  })

  Scenario('A page that cannot get a token is offline, not refused', ({ When, Then, And }) => {
    When('Ana\'s page connects to the deck, and its first token cannot be fetched', () => {
      let first = true
      page = connect(anaBrowser, async () => {
        if (!first)
          return 'cookie'
        first = false
        throw new Error('No network to refresh the token')
      })
    })
    Then('the connection says "Offline. Changes sync when you are back online."', async () => {
      await vi.waitFor(() => expect(label(page)).toBe('Offline. Changes sync when you are back online.'), SOON)
      expect(page.connection.error.value).toBe('')
    })
    And('a moment later it holds the deck and says "Saved", after asking for a token again', async () => {
      await vi.waitFor(() => expect(label(page)).toBe('Saved'), { timeout: 8000, interval: 50 })
      expect(page.connection.readOnly.value).toBe(false)
      expect(slidesOf(page.doc)).toHaveLength(3)
      expect(page.tokens).toBe(2)
    })
  })

  Scenario('Someone removed from the project is told they no longer have access', ({ Given, And, When, Then }) => {
    Given('Ana shared the project with Budi as an editor', () => shareWithBudi('editor'))
    And('Budi\'s page is connected to the deck', async () => {
      page = await connected(budiBrowser)
      expect(page.connection.readOnly.value).toBe(false)
    })
    When('Ana removes Budi from the project', async () => {
      const removed = await anaBrowser.request(`/api/projects/${projectId}/sharing/members/${await budiId()}`, { method: 'DELETE' })
      expect(removed.status).toBe(204)
    })
    Then('Budi\'s connection says "You no longer have access to this deck." and is read only', async () => {
      await vi.waitFor(() => expect(label(page)).toBe('Not saved: You no longer have access to this deck.'), SOON)
      expect(page.connection.readOnly.value).toBe(true)
      // A refusal for good: a copy of the deck on the device goes with it.
      expect(page.connection.failure.value).toBe('refused')
    })
  })

  Scenario('A page whose sign in ended is told to sign in again, not refused for good', ({ Given, When, Then, And }) => {
    Given('Ana\'s sign in ended on the server', async () => {
      await server.db.updateTable('session').set({ expiresAt: new Date(Date.now() - 1000) }).execute()
    })
    When('Ana\'s page connects to the deck', () => {
      page = connect(anaBrowser)
    })
    Then('the connection says "Your sign in ended. Sign in again to save your changes." and is read only', async () => {
      await vi.waitFor(() => expect(label(page)).toBe('Not saved: Your sign in ended. Sign in again to save your changes.'), SOON)
      expect(page.connection.readOnly.value).toBe(true)
    })
    And('the failure is a sign in that ended, not a refusal', () => {
      expect(page.connection.failure.value).toBe('signed-out')
    })
  })

  Scenario('A page joins again when the server cannot check access just then', ({ Given, When, Then }) => {
    Given('the server cannot check access the next time someone joins', () => {
      const real = server.projects.deckAccess.bind(server.projects)
      let fails = 1
      vi.spyOn(server.projects, 'deckAccess').mockImplementation(async (...args) => {
        if (fails-- > 0)
          throw new Error('database connection reset')
        return real(...args)
      })
      // The server logs the error it hides from the page.
      vi.spyOn(console, 'error').mockImplementation(() => {})
    })
    When('Ana\'s page connects to the deck', () => {
      page = connect(anaBrowser)
    })
    Then('a moment later it holds the deck and says "Saved", without failing', async () => {
      const statuses = new Set<string>()
      const stop = watch(page.connection.status, status => statuses.add(status), { immediate: true })
      await vi.waitFor(() => expect(label(page)).toBe('Saved'), { timeout: 8000, interval: 20 })
      stop()
      expect(statuses.has('failed')).toBe(false)
      expect(page.connection.failure.value).toBeUndefined()
      expect(page.connection.readOnly.value).toBe(false)
      expect(page.tokens).toBe(2)
      vi.restoreAllMocks()
    })
  })

  Scenario('A page older than the deck\'s shape on the server is told to update', ({ Given, When, Then }) => {
    Given('the server holds decks in a newer shape than Ana\'s page reads', () => {
      // A later server turns this page's shape away the way this one turns away an older one.
      server.collab.configuration.extensions.unshift({
        async onAuthenticate() {
          throw Object.assign(new Error(''), { reason: SHAPE_REFUSED })
        },
      })
    })
    When('Ana\'s page connects to the deck', () => {
      page = connect(anaBrowser)
    })
    Then('the connection says "Deyslide was updated. Reload the page, or update the app, to keep editing this deck." and is read only', async () => {
      await vi.waitFor(() => expect(label(page)).toBe('Not saved: Deyslide was updated. Reload the page, or update the app, to keep editing this deck.'), SOON)
      expect(page.connection.readOnly.value).toBe(true)
      expect(page.connection.synced.value).toBe(false)
    })
  })

  Scenario('Someone whose role changes joins again with the new role', ({ Given, And, When, Then }) => {
    Given('Ana shared the project with Budi as an editor', () => shareWithBudi('editor'))
    And('Budi\'s page is connected to the deck', async () => {
      page = await connected(budiBrowser)
      await vi.waitFor(() => expect(label(page)).toBe('Saved'), SOON)
      expect(page.connection.readOnly.value).toBe(false)
    })
    When('Ana makes Budi a viewer', async () => {
      const changed = await anaBrowser.request(`/api/projects/${projectId}/sharing/members/${await budiId()}`, { method: 'PATCH', json: { role: 'viewer' } })
      expect(changed.status).toBe(204)
    })
    Then('Budi\'s connection joins again with a fresh token, read only, and says "Saved"', async () => {
      await vi.waitFor(() => expect(page.tokens).toBe(2), SOON)
      await vi.waitFor(() => expect(label(page)).toBe('Saved'), SOON)
      // Saved again, after the new sync: read only now comes from the viewer role, not from joining again.
      expect(page.connection.synced.value).toBe(true)
      expect(page.connection.readOnly.value).toBe(true)
      expect(page.connection.error.value).toBe('')
    })
  })

  Scenario('A deck too big to save says so', ({ Given, When, Then }) => {
    Given('Ana\'s page is connected to the deck', async () => {
      page = await connected(anaBrowser)
    })
    When('the page adds a slide with 210000 characters of text', () => {
      insertSlide(page.doc, 3, { id: newId('s'), frontmatter: {}, elements: [{ id: newId('e'), type: 'raw', markdown: 'words '.repeat(35_000) }] })
    })
    Then('the connection says "This deck is too big to save. Remove some content." and is read only', async () => {
      await vi.waitFor(() => expect(label(page)).toBe('Not saved: This deck is too big to save. Remove some content.'), SOON)
      expect(page.connection.readOnly.value).toBe(true)
    })
  })
})
