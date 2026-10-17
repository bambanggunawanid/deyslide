import 'fake-indexeddb/auto'
import type { Account } from '../apps/web/src/account/types'
import type { DeckSession } from '../apps/web/src/deck/session'
import type { ProjectApi } from '../apps/web/src/projects/api'
import type { WebApp } from './support/web'
import { describeFeature, loadFeature } from '@amiceli/vitest-cucumber'
import { IDBFactory } from 'fake-indexeddb'
import { expect, vi } from 'vitest'
import * as Y from 'yjs'
import { holdsDeck, statusLabel } from '../apps/web/src/deck/session'
import { followRememberedAccount } from '../apps/web/src/account/remembered'
import { CloudStore } from '../apps/web/src/projects/cloud-store'
import { StoreError } from '../apps/web/src/projects/names'
import { copyName, copyPrefix, OfflineCache } from '../apps/web/src/projects/offline-cache'
import { IndexedDbOfflineStorage } from '../apps/web/src/projects/offline-storage'
import { deckToYDoc, fromMarkdown } from '../packages/deck-model/src'
import { FakeAccountService } from './support/account'
import { accountDeck, changeSlide, openReady, slidesOf as slideMarkdowns } from './support/live-decks'
import { FakeProjectApi } from './support/project-api'
import { find, mountWebApp, text } from './support/web'

const feature = await loadFeature('./offline-decks.feature')

/** What the API says without a connection. */
const UNREACHABLE = 'Deyslide is unreachable. Check your connection and try again.'
const OFFLINE = 'Offline. Changes sync when you are back online.'
const GRAPHS = '# Graphs\n\n---\n\n## Nodes\n\n---\n\n## Edges\n'

const ANA: Account = { id: 'user-ana', name: 'Ana', email: 'ana@example.com' }

/** The names of the IndexedDB databases on this device. */
/** Each slide's Markdown in a live document, without the blank lines around it. */
const slidesOf = (doc: Y.Doc) => slideMarkdowns(doc).map(slide => slide.trim())

async function databases() {
  return (await indexedDB.databases()).map(database => database.name ?? '')
}

describeFeature(feature, ({ Scenario, BeforeEachScenario, AfterEachScenario }) => {
  let api: FakeProjectApi
  let cache: OfflineCache
  let projectId: string
  let deckId: string
  let session: DeckSession | undefined
  let budiSession: DeckSession | undefined
  let web: WebApp | undefined
  let service: FakeAccountService
  /** Every store a scenario opened, so each lets go of its decks at the end. */
  let stores: CloudStore[]
  let stopFollowing: (() => void) | undefined

  BeforeEachScenario(() => {
    // A fresh IndexedDB for every scenario, like a new device.
    globalThis.indexedDB = new IDBFactory()
    api = new FakeProjectApi()
    cache = new OfflineCache(new IndexedDbOfflineStorage())
    stores = []
    session = undefined
    budiSession = undefined
    web = undefined
    stopFollowing = undefined
  })

  AfterEachScenario(async () => {
    stopFollowing?.()
    session?.close()
    budiSession?.close()
    web?.unmount()
    for (const store of stores)
      await store.close()
  })

  // One person's page against the shared fake server ------------------------

  /** Ana's view of the API: everything fails while Ana's connection is down, as `fetch` would. */
  function anasApi(): ProjectApi {
    return new Proxy(api, {
      get(target, key, receiver) {
        const value = Reflect.get(target, key, receiver)
        if (typeof value !== 'function')
          return value
        if (key === 'connectDeck')
          return value.bind(target)
        return (...args: unknown[]) => target.reaches('ana') ? value.apply(target, args) : Promise.reject(new StoreError(UNREACHABLE))
      },
    })
  }

  /** Ana opens Deyslide: a store that keeps her decks on this device. */
  async function anaOpensDeyslide() {
    const store = await CloudStore.open(anasApi(), { token: async () => 'ana', cache, userId: ANA.id })
    stores.push(store)
    return store
  }

  /** Budi opens Deyslide in another browser, which keeps nothing. */
  async function budiOpensDeyslide() {
    const store = await CloudStore.open(api, { token: async () => 'budi' })
    stores.push(store)
    return store
  }

  /** Closes a store as closing the page would, keeping only what the device has. */
  async function closePage(store: CloudStore) {
    await store.close()
    stores = stores.filter(item => item !== store)
  }

  /** Waits until the device keeps a copy of the deck that holds it. */
  async function waitForCopy(id: string) {
    await vi.waitFor(async () => {
      expect(await cache.decks(ANA.id)).toContain(id)
      expect(await databases()).toContain(copyName(ANA.id, id))
    })
    // y-indexeddb writes the deck as the copy starts, in its own transaction.
    await new Promise(resolve => setTimeout(resolve, 20))
  }

  async function openedOnceOnline() {
    ;({ projectId, deckId } = await accountDeck(api, GRAPHS, 'Graphs'))
    const store = await anaOpensDeyslide()
    const first = await openReady(store, projectId, deckId)
    await waitForCopy(deckId)
    first.close()
    await closePage(store)
  }

  const anaIsOffline = () => api.goOfflineFor('ana')
  const anaIsOnline = () => api.goOnlineFor('ana')
  const room = () => api.rooms.get(deckId)!
  const header = (current: DeckSession) => statusLabel(current.status.value, current.error.value)

  async function changedOffline(markdown: string) {
    anaIsOffline()
    const store = await anaOpensDeyslide()
    session = await openReady(store, projectId, deckId)
    changeSlide(session, 2, () => markdown)
    return store
  }

  Scenario('Edit a deck kept on this device while offline', ({ Given, And, When, Then }) => {
    Given('Ana opened the deck "Graphs" once while online', openedOnceOnline)
    And('Ana is offline', anaIsOffline)
    When('Ana opens "Graphs" and changes slide 2 to "## Offline idea"', async () => {
      const store = await anaOpensDeyslide()
      session = await openReady(store, projectId, deckId)
      changeSlide(session, 2, () => '## Offline idea')
    })
    Then('the change shows at once and the header says "Offline. Changes sync when you are back online."', async () => {
      expect(slidesOf(session!.doc)[1]).toBe('## Offline idea')
      expect(session!.readOnly.value).toBe(false)
      await vi.waitFor(() => expect(header(session!)).toBe(OFFLINE))
      expect(slidesOf(room())[1]).toBe('## Nodes')
    })
    When('Ana is online again', anaIsOnline)
    Then('the account\'s deck has "## Offline idea" on slide 2', async () => {
      await vi.waitFor(() => expect(slidesOf(room())[1]).toBe('## Offline idea'))
    })
    And('the header says "Saved"', async () => {
      await vi.waitFor(() => expect(header(session!)).toBe('Saved'))
    })
  })

  Scenario('Offline edits merge with an edit made online meanwhile', ({ Given, And, When, Then }) => {
    Given('Ana opened the deck "Graphs" once while online', openedOnceOnline)
    And('Ana changed slide 2 to "## From Ana" while offline', async () => {
      await changedOffline('## From Ana')
    })
    And('Budi changed slide 3 to "## From Budi" online meanwhile', async () => {
      budiSession = await openReady(await budiOpensDeyslide(), projectId, deckId)
      changeSlide(budiSession, 3, () => '## From Budi')
      await vi.waitFor(() => expect(slidesOf(room())[2]).toBe('## From Budi'))
      expect(slidesOf(session!.doc)[2]).toBe('## Edges')
    })
    When('Ana is online again', anaIsOnline)
    Then('Ana\'s deck has "## From Ana" on slide 2 and "## From Budi" on slide 3', async () => {
      await vi.waitFor(() => expect(slidesOf(session!.doc)).toEqual(['# Graphs', '## From Ana', '## From Budi']))
    })
    And('so does Budi\'s', async () => {
      await vi.waitFor(() => expect(slidesOf(budiSession!.doc)).toEqual(['# Graphs', '## From Ana', '## From Budi']))
      expect(slidesOf(room())).toEqual(['# Graphs', '## From Ana', '## From Budi'])
    })
  })

  Scenario('Changes kept on this device reach the account after the page closed', ({ Given, And, When, Then }) => {
    Given('Ana opened the deck "Graphs" once while online', openedOnceOnline)
    And('Ana changed slide 2 to "## On the plane" while offline, then closed Deyslide', async () => {
      const store = await changedOffline('## On the plane')
      await vi.waitFor(async () => expect(await cache.pending(ANA.id)).toEqual([deckId]))
      session!.close()
      session = undefined
      await closePage(store)
      expect(slidesOf(room())[1]).toBe('## Nodes')
    })
    When('Ana opens Deyslide again while online, without opening the deck', async () => {
      anaIsOnline()
      await anaOpensDeyslide()
    })
    Then('the account\'s deck has "## On the plane" on slide 2', async () => {
      await vi.waitFor(() => expect(slidesOf(room())[1]).toBe('## On the plane'))
      await vi.waitFor(async () => expect(await cache.pending(ANA.id)).toEqual([]))
    })
  })

  Scenario('A deck never opened on this device stays read only offline', ({ Given, And, When, Then }) => {
    Given('Ana has the deck "Charts" in Ana\'s account and never opened it on this device', async () => {
      ;({ projectId, deckId } = await accountDeck(api, '# Charts\n', 'Charts'))
      // Ana's projects were listed on this device, but the deck never opened here.
      await closePage(await anaOpensDeyslide())
    })
    And('Ana is offline', anaIsOffline)
    When('Ana opens "Charts"', async () => {
      const store = await anaOpensDeyslide()
      expect(store.offline.value).toBe(true)
      session = await store.openDeck(projectId, deckId)
    })
    Then('the session holds no deck, is read only and says "Offline. Changes sync when you are back online."', async () => {
      await vi.waitFor(() => expect(header(session!)).toBe(OFFLINE))
      expect(session!.ready.value).toBe(false)
      expect(session!.readOnly.value).toBe(true)
      expect(holdsDeck(session!.doc)).toBe(false)
      // Nothing is kept of a deck the device never had.
      expect(await databases()).not.toContain(copyName(ANA.id, deckId))
    })
    When('Ana is online again', anaIsOnline)
    Then('the session holds the deck and can be changed', async () => {
      await vi.waitFor(() => expect(session!.ready.value).toBe(true))
      expect(session!.readOnly.value).toBe(false)
      expect(slidesOf(session!.doc)).toEqual(['# Charts'])
    })
  })

  // The web app -------------------------------------------------------------

  /** The whole server is out of reach for the page, its lists included. */
  function pageOffline() {
    api.failWith = UNREACHABLE
    api.goOffline()
    service.unreachable = true
  }

  function pageOnline() {
    api.failWith = ''
    api.goOnline()
    service.unreachable = false
  }

  async function usedOnline() {
    service = new FakeAccountService()
    service.signedIn = ANA
    ;({ projectId, deckId } = await accountDeck(api, GRAPHS, 'Graphs'))
    web = await mountWebApp({ service, api, offline: cache })
    await web.router.push({ name: 'deck', params: { projectId, deckId } })
    await vi.waitFor(() => expect(text('[data-testid="save-status"]')).toBe('Saved'))
    await waitForCopy(deckId)
    await web.router.push({ name: 'home' })
    await web.settle()
  }

  /** Closes the open page, then opens Deyslide again without a connection. */
  async function opensOffline() {
    const cloud = web!.workspace.stores.value.cloud as CloudStore | undefined
    web!.unmount()
    await cloud?.close()
    pageOffline()
    web = await mountWebApp({ service, api, offline: cache })
    stores.push(web.workspace.stores.value.cloud as CloudStore)
    // As the website does from its start, it asks again once the server may answer.
    stopFollowing = followRememberedAccount(web.account, web.router)
  }

  Scenario('Home lists the account\'s projects offline', ({ Given, And, When, Then }) => {
    Given('Ana used Deyslide online and opened the deck "Graphs" of the project "Talks"', usedOnline)
    And('the project "Talks" also has the deck "Charts", never opened on this device', async () => {
      await api.createDeck(projectId, 'Charts', Y.encodeStateAsUpdate(deckToYDoc(fromMarkdown('# Charts\n'))))
      await (web!.workspace.stores.value.cloud as CloudStore).refresh()
    })
    When('Ana opens Deyslide while offline', opensOffline)
    Then('the account menu shows Ana', () => {
      expect(text('[data-testid="account-menu"]')).toBe('Ana')
    })
    And('Home lists the project "Talks" with the mark "Offline"', () => {
      expect(find('[data-project="Talks"]')).not.toBeNull()
      expect(text('[data-testid="projects-offline"]')).toContain('Offline')
    })
    And('the project page says "Graphs" is "On this device" and "Charts" "Needs a connection"', async () => {
      await web!.router.push({ name: 'project', params: { projectId } })
      await web!.settle()
      expect(text('[data-testid="project-offline"]')).toContain('Offline')
      expect(text('[data-deck-offline="Graphs"]')).toBe('On this device')
      expect(text('[data-deck-offline="Charts"]')).toBe('Needs a connection')
      await web!.router.push({ name: 'home' })
      await web!.settle()
    })
    When('the server answers again and lists a new project "Lectures"', async () => {
      pageOnline()
      await api.createProject('Lectures')
      window.dispatchEvent(new Event('online'))
    })
    Then('Home lists "Lectures" and "Talks" without the mark', async () => {
      await vi.waitFor(() => expect(find('[data-project="Lectures"]')).not.toBeNull())
      expect(find('[data-project="Talks"]')).not.toBeNull()
      expect(find('[data-testid="projects-offline"]')).toBeNull()
    })
  })

  Scenario('Home says so when the connection drops while it is open', ({ Given, When, Then }) => {
    Given('Ana used Deyslide online and opened the deck "Graphs" of the project "Talks"', usedOnline)
    When('the browser says the connection dropped', async () => {
      pageOffline()
      window.dispatchEvent(new Event('offline'))
      await web!.settle()
    })
    Then('Home lists the project "Talks" with the mark "Offline"', () => {
      expect(find('[data-project="Talks"]')).not.toBeNull()
      expect(text('[data-testid="projects-offline"]')).toContain('Offline')
    })
    When('the browser says the connection is back and the server answers', () => {
      pageOnline()
      window.dispatchEvent(new Event('online'))
    })
    Then('Home lists "Talks" without the mark', async () => {
      await vi.waitFor(() => expect(find('[data-testid="projects-offline"]')).toBeNull())
      expect(find('[data-project="Talks"]')).not.toBeNull()
    })
  })

  Scenario('The website follows the server once it answers again', ({ Given, And, When, Then }) => {
    Given('Ana used Deyslide online and opened the deck "Graphs" of the project "Talks"', usedOnline)
    And('Ana\'s sign in ended on the server meanwhile', () => {
      service.signedIn = undefined
    })
    When('Ana opens Deyslide while offline', opensOffline)
    Then('the account menu shows Ana', () => {
      expect(text('[data-testid="account-menu"]')).toBe('Ana')
    })
    When('the browser says the connection is back and the server answers', () => {
      pageOnline()
      window.dispatchEvent(new Event('online'))
    })
    Then('the page is signed out and lists no account projects', async () => {
      await vi.waitFor(() => expect(find('[data-testid="account-menu"]')).toBeNull())
      expect(find('[data-project="Talks"]')).toBeNull()
      expect(find('[data-testid="projects-offline"]')).toBeNull()
    })
    And('the device still keeps Ana\'s decks for the next sign in', async () => {
      expect(await cache.decks(ANA.id)).toEqual([deckId])
      expect(await databases()).toContain(copyName(ANA.id, deckId))
    })
  })

  Scenario('The deck page opens a kept deck offline', ({ Given, When, And, Then }) => {
    Given('Ana used Deyslide online and opened the deck "Graphs" of the project "Talks"', usedOnline)
    When('Ana opens Deyslide while offline', opensOffline)
    And('Ana opens the deck "Graphs" from the project page', async () => {
      await web!.router.push({ name: 'project', params: { projectId } })
      await web!.click('[data-deck="Graphs"]')
    })
    Then('the deck page shows the deck and its header says "Offline. Changes sync when you are back online."', async () => {
      await vi.waitFor(() => expect(text('[data-testid="slide-position"]')).toBe('Slide 1 of 3'))
      expect(find('[data-testid="design-view"]')).not.toBeNull()
      await vi.waitFor(() => expect(text('[data-testid="save-status"]')).toBe(OFFLINE))
    })
  })

  Scenario('A deck the server refuses loses its copy and says why', ({ Given, And, When, Then }) => {
    let store: CloudStore
    Given('Ana opened the deck "Graphs" once while online', openedOnceOnline)
    And('the deck "Graphs" was deleted from the account in another browser', async () => {
      await api.deleteDeck(deckId)
    })
    And('Ana is offline', anaIsOffline)
    When('Ana opens "Graphs" from this device', async () => {
      store = await anaOpensDeyslide()
      session = await openReady(store, projectId, deckId)
    })
    Then('the deck opens from its copy and can be changed', () => {
      expect(slidesOf(session!.doc)).toEqual(['# Graphs', '## Nodes', '## Edges'])
      expect(session!.readOnly.value).toBe(false)
    })
    When('Ana is online again', anaIsOnline)
    Then('the session says "Not saved: You no longer have access to this deck. Its copy on this device was deleted." and is read only', async () => {
      await vi.waitFor(() => expect(header(session!)).toBe('Not saved: You no longer have access to this deck. Its copy on this device was deleted.'))
      expect(session!.readOnly.value).toBe(true)
    })
    And('this device keeps no copy of "Graphs"', async () => {
      await vi.waitFor(async () => expect(await databases()).not.toContain(copyName(ANA.id, deckId)))
      expect(await cache.decks(ANA.id)).toEqual([])
      expect(store.keptOnDevice(deckId)).toBe(false)
    })
    And('the project no longer lists "Graphs"', async () => {
      await vi.waitFor(() => expect(store.getProject(projectId)?.decks).toEqual([]))
      expect((await cache.lists(ANA.id))?.projects[0].decks).toEqual([])
    })
  })

  Scenario('Signing out clears the device', ({ Given, When, Then, And }) => {
    Given('Ana used Deyslide online and opened the deck "Graphs" of the project "Talks"', usedOnline)
    When('Ana signs out', async () => {
      expect(await cache.lists(ANA.id)).toBeDefined()
      // The account menu opens from the keyboard here, the way it does for keyboard users.
      find('[data-testid="account-menu"]')!.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Enter' }))
      await web!.settle()
      await web!.click('[data-testid="sign-out"]')
      await vi.waitFor(() => expect(find('[data-testid="account-menu"]')).toBeNull())
    })
    Then('no account deck, project list or remembered account is left on the device', async () => {
      expect(find('[data-testid="account-menu"]')).toBeNull()
      // The menu goes as soon as the page is signed out; the device is cleared right after.
      await vi.waitFor(async () => expect(await cache.lists(ANA.id)).toBeUndefined())
      expect(await cache.decks(ANA.id)).toEqual([])
      expect(await cache.lastAccount()).toBeUndefined()
      await vi.waitFor(async () => expect((await databases()).filter(name => name.startsWith(copyPrefix(ANA.id)))).toEqual([]))
    })
    And('opening Deyslide offline afterwards shows no account projects', async () => {
      web!.unmount()
      pageOffline()
      web = await mountWebApp({ service, api, offline: cache })
      expect(find('[data-testid="account-menu"]')).toBeNull()
      expect(find('[data-testid="projects-offline"]')).toBeNull()
      expect(find('[data-project="Talks"]')).toBeNull()
      expect(find('[data-testid="empty-projects"]')).not.toBeNull()
    })
  })
})
