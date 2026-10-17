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
import { IndexedDbOfflineStorage, MemoryOfflineStorage } from '../apps/web/src/projects/offline-storage'
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

/** Each slide's Markdown in a live document, without the blank lines around it. */
const slidesOf = (doc: Y.Doc) => slideMarkdowns(doc).map(slide => slide.trim())

/** The names of the IndexedDB databases on this device. */
async function databases() {
  return (await indexedDB.databases()).map(database => database.name ?? '')
}

describeFeature(feature, ({ Scenario, ScenarioOutline, BeforeEachScenario, AfterEachScenario }) => {
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
  /** Ana's page that is open now, when one is. */
  let anasStore: CloudStore | undefined
  let stopFollowing: (() => void) | undefined

  BeforeEachScenario(() => {
    // A fresh IndexedDB for every scenario, like a new device.
    globalThis.indexedDB = new IDBFactory()
    api = new FakeProjectApi()
    cache = new OfflineCache(new IndexedDbOfflineStorage())
    stores = []
    anasStore = undefined
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
    anasStore = store
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
    if (anasStore === store)
      anasStore = undefined
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

  async function changedOfflineThenClosed(markdown: string) {
    const store = await changedOffline(markdown)
    await vi.waitFor(async () => expect(await cache.pending(ANA.id)).toEqual([deckId]))
    session!.close()
    session = undefined
    await closePage(store)
    expect(await serverSlides()).toEqual(['# Graphs', '## Nodes', '## Edges'])
  }

  async function opensAgainOnline() {
    anaIsOnline()
    await anaOpensDeyslide()
  }

  /** The deck as the server has it, whether or not its room is open. */
  async function serverSlides() {
    const doc = new Y.Doc()
    Y.applyUpdate(doc, await api.deckState(deckId))
    const slides = slidesOf(doc)
    doc.destroy()
    return slides
  }

  /** Ana opens the deck from the page she has open, or from a new one. */
  async function opensFromDevice() {
    session = await openReady(anasStore ?? await anaOpensDeyslide(), projectId, deckId)
  }

  /** Budi's project "Budi's talks" with the deck "Graphs", shared with Ana with this role. Ana opened it once online. */
  async function sharedWithAna(role: 'editor' | 'viewer') {
    const now = Date.now()
    projectId = 'budi-talks'
    deckId = 'budi-graphs'
    api.sharedProjects.push({
      id: projectId,
      name: 'Budi\'s talks',
      createdAt: now,
      updatedAt: now,
      shared: { owner: { name: 'Budi', email: 'budi@example.com' }, role: null },
      decks: [{ id: deckId, name: 'Graphs', slideCount: 3, createdAt: now, updatedAt: now, role }],
    })
    api.putDeckState(deckId, Y.encodeStateAsUpdate(deckToYDoc(fromMarkdown(GRAPHS))))
    const store = await anaOpensDeyslide()
    const first = await openReady(store, projectId, deckId)
    await waitForCopy(deckId)
    first.close()
    await closePage(store)
  }

  /** The deck's copy is gone from the device, and the page no longer counts it. */
  async function noCopyLeft() {
    await vi.waitFor(async () => expect(await databases()).not.toContain(copyName(ANA.id, deckId)))
    expect(await cache.decks(ANA.id)).toEqual([])
    expect(anasStore?.keptOnDevice(deckId)).toBe(false)
  }

  /** The deck's copy is still on the device. */
  async function copyKept() {
    expect(await cache.decks(ANA.id)).toEqual([deckId])
    expect(await databases()).toContain(copyName(ANA.id, deckId))
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
    And('Ana changed slide 2 to "## On the plane" while offline, then closed Deyslide', () => changedOfflineThenClosed('## On the plane'))
    When('Ana opens Deyslide again while online, without opening the deck', opensAgainOnline)
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
    const previous = web!.workspace.stores.value.cloud as CloudStore | undefined
    web!.unmount()
    await previous?.close()
    pageOffline()
    web = await mountWebApp({ service, api, offline: cache })
    const cloud = web.workspace.stores.value.cloud as CloudStore | undefined
    if (cloud)
      stores.push(cloud)
    // As the website does from its start, it asks again once the server may answer.
    stopFollowing?.()
    stopFollowing = followRememberedAccount(web.account, web.router)
  }

  async function signedOutPage() {
    await vi.waitFor(() => expect(find('[data-testid="account-menu"]')).toBeNull())
    expect(find('[data-project="Talks"]')).toBeNull()
    expect(find('[data-testid="projects-offline"]')).toBeNull()
  }

  async function chartsAlsoInTalks() {
    await api.createDeck(projectId, 'Charts', Y.encodeStateAsUpdate(deckToYDoc(fromMarkdown('# Charts\n'))))
    await (web!.workspace.stores.value.cloud as CloudStore).refresh()
  }

  Scenario('Home lists the account\'s projects offline', ({ Given, And, When, Then }) => {
    Given('Ana used Deyslide online and opened the deck "Graphs" of the project "Talks"', usedOnline)
    And('the project "Talks" also has the deck "Charts", never opened on this device', chartsAlsoInTalks)
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
    Then('the page is signed out and lists no account projects', signedOutPage)
    And('the device still keeps Ana\'s decks for the next sign in', async () => {
      expect(await cache.decks(ANA.id)).toEqual([deckId])
      expect(await databases()).toContain(copyName(ANA.id, deckId))
      // Only the copies stay: the next offline start shows nobody.
      expect(await cache.lastAccount()).toBeUndefined()
    })
    When('Ana opens Deyslide while offline again', opensOffline)
    Then('the page shows no account and lists no account projects', async () => {
      await signedOutPage()
      expect(find('[data-testid="empty-projects"]')).not.toBeNull()
    })
  })

  Scenario('A deck never opened on this device says it needs a connection', ({ Given, And, When, Then }) => {
    Given('Ana used Deyslide online and opened the deck "Graphs" of the project "Talks"', usedOnline)
    And('the project "Talks" also has the deck "Charts", never opened on this device', chartsAlsoInTalks)
    When('Ana opens Deyslide while offline', opensOffline)
    And('Ana opens the deck "Charts" from the project page', async () => {
      await web!.router.push({ name: 'project', params: { projectId } })
      await web!.click('[data-deck="Charts"]')
    })
    Then('the deck page says "This deck has no copy on this device yet, so it opens once you are back online."', async () => {
      await vi.waitFor(() => expect(text('[data-testid="deck-needs-connection"]')).toBe('This deck has no copy on this device yet, so it opens once you are back online.'))
      expect(find('[data-testid="design-view"]')).toBeNull()
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

  Scenario('Access removed while the deck is open deletes its copy', ({ Given, And, When, Then }) => {
    Given('Budi shared the deck "Graphs" with Ana as an editor, and Ana opened it once while online', () => sharedWithAna('editor'))
    And('Ana has "Graphs" open online', async () => {
      await opensFromDevice()
      await vi.waitFor(() => expect(header(session!)).toBe('Saved'))
      expect(session!.readOnly.value).toBe(false)
    })
    When('Budi removes Ana from the deck', () => {
      api.sharedProjects.splice(0)
      // Like the server, the connection closes and joins again, and is refused.
      api.rejoinAs(deckId, 'editor')
    })
    Then('the session says "Not saved: You no longer have access to this deck. Its copy on this device was deleted." and is read only', async () => {
      await vi.waitFor(() => expect(header(session!)).toBe('Not saved: You no longer have access to this deck. Its copy on this device was deleted.'))
      expect(session!.readOnly.value).toBe(true)
    })
    And('this device keeps no copy of "Graphs"', noCopyLeft)
  })

  Scenario('A sign in that ended keeps the copy and the changes made offline', ({ Given, And, When, Then }) => {
    Given('Ana opened the deck "Graphs" once while online', openedOnceOnline)
    And('Ana changed slide 2 to "## Offline idea" while offline', async () => {
      await changedOffline('## Offline idea')
      await vi.waitFor(async () => expect(await cache.pending(ANA.id)).toEqual([deckId]))
    })
    And('Ana\'s sign in ended on the server meanwhile', () => {
      api.endSignIn('ana')
    })
    When('Ana is online again', anaIsOnline)
    Then('the session says "Not saved: Your sign in ended. Sign in again to save your changes. They stay on this device until then." and is read only', async () => {
      await vi.waitFor(() => expect(header(session!)).toBe('Not saved: Your sign in ended. Sign in again to save your changes. They stay on this device until then.'))
      expect(session!.readOnly.value).toBe(true)
      expect(slidesOf(session!.doc)[1]).toBe('## Offline idea')
    })
    And('this device still keeps "Graphs" with the change waiting for the server', async () => {
      // Give a deletion the time it would take.
      await new Promise(resolve => setTimeout(resolve, 50))
      await copyKept()
      expect(await cache.pending(ANA.id)).toEqual([deckId])
      expect(anasStore!.keptOnDevice(deckId)).toBe(true)
      expect(await serverSlides()).toEqual(['# Graphs', '## Nodes', '## Edges'])
    })
    When('Ana signs in again and opens Deyslide', async () => {
      api.signInAgain('ana')
      session!.close()
      session = undefined
      await closePage(anasStore!)
      await anaOpensDeyslide()
    })
    Then('the account\'s deck has "## Offline idea" on slide 2', async () => {
      await vi.waitFor(async () => expect((await serverSlides())[1]).toBe('## Offline idea'))
      await vi.waitFor(async () => expect(await cache.pending(ANA.id)).toEqual([]))
    })
  })

  Scenario('A server that cannot check access just then keeps the copy and syncs later', ({ Given, And, When, Then }) => {
    Given('Ana opened the deck "Graphs" once while online', openedOnceOnline)
    And('Ana changed slide 2 to "## Offline idea" while offline', async () => {
      await changedOffline('## Offline idea')
    })
    And('the server cannot check Ana\'s access the next two times she joins', () => {
      api.failAccessChecks('ana', 2)
    })
    When('Ana is online again', anaIsOnline)
    Then('the account\'s deck has "## Offline idea" on slide 2', async () => {
      await vi.waitFor(() => expect(slidesOf(room())[1]).toBe('## Offline idea'))
    })
    And('the header says "Saved"', async () => {
      await vi.waitFor(() => expect(header(session!)).toBe('Saved'))
      expect(session!.error.value).toBe('')
    })
    And('this device still keeps "Graphs"', async () => {
      await copyKept()
      expect(anasStore!.keptOnDevice(deckId)).toBe(true)
    })
  })

  Scenario('Changes the server turns down are kept until Ana sees why', ({ Given, And, When, Then }) => {
    Given('Budi shared the deck "Graphs" with Ana as an editor, and Ana opened it once while online', () => sharedWithAna('editor'))
    And('Ana changed slide 2 to "## On the plane" while offline, then closed Deyslide', () => changedOfflineThenClosed('## On the plane'))
    And('Budi made Ana a viewer of "Graphs" meanwhile', () => {
      api.sharedProjects[0].decks[0].role = 'viewer'
    })
    When('Ana opens Deyslide again while online, without opening the deck', opensAgainOnline)
    Then('the account\'s deck still has "## Nodes" on slide 2', async () => {
      // The page tried to send the change in the background, and the server turned it down.
      await vi.waitFor(async () => expect(await cache.pending(ANA.id)).toEqual([]))
      expect(await serverSlides()).toEqual(['# Graphs', '## Nodes', '## Edges'])
    })
    And('this device still keeps "Graphs", no longer waiting to send it', async () => {
      await copyKept()
      expect(await cache.pending(ANA.id)).toEqual([])
    })
    When('Ana opens "Graphs" from this device', opensFromDevice)
    Then('the session says "Not saved: You can only view this deck now. Reload the page to see it as it is. Its copy on this device was deleted. Download the Markdown to keep your changes."', async () => {
      await vi.waitFor(() => expect(header(session!)).toBe('Not saved: You can only view this deck now. Reload the page to see it as it is. Its copy on this device was deleted. Download the Markdown to keep your changes.'))
      expect(session!.readOnly.value).toBe(true)
    })
    And('the open deck still has "## On the plane" on slide 2', () => {
      expect(slidesOf(session!.doc)[1]).toBe('## On the plane')
      expect(session!.ready.value).toBe(true)
    })
    And('this device keeps no copy of "Graphs"', noCopyLeft)
  })

  Scenario('A viewer\'s kept deck opens offline read only', ({ Given, And, When, Then }) => {
    Given('Budi shared the deck "Graphs" with Ana as a viewer, and Ana opened it once while online', () => sharedWithAna('viewer'))
    And('Ana is offline', anaIsOffline)
    When('Ana opens "Graphs" from this device', opensFromDevice)
    Then('the session holds the deck, is read only and says "Offline. Changes sync when you are back online."', async () => {
      expect(slidesOf(session!.doc)).toEqual(['# Graphs', '## Nodes', '## Edges'])
      expect(session!.readOnly.value).toBe(true)
      await vi.waitFor(() => expect(header(session!)).toBe(OFFLINE))
    })
  })

  ScenarioOutline('Closing Deyslide warns about changes not sent yet, unless the copy outlasts the page', ({ Given, And, When, Then }, variables) => {
    let store: CloudStore
    let warned: string[]
    let asked: boolean
    Given('this device keeps deck copies in <storage>', () => {
      if (variables.storage === 'memory only') {
        cache = new OfflineCache(new MemoryOfflineStorage())
      }
      else if (variables.storage === 'an IndexedDB that refuses to open') {
        // Some private windows and blocked site data refuse IndexedDB like this.
        globalThis.indexedDB = {
          open: () => {
            throw new DOMException('The operation is insecure.', 'SecurityError')
          },
          databases: async () => [],
        } as unknown as IDBFactory
        cache = new OfflineCache(new IndexedDbOfflineStorage())
      }
      else {
        expect(variables.storage).toBe('IndexedDB')
      }
    })
    And('Ana opened the deck "Graphs" while online, changed slide 2 while offline and left the deck', async () => {
      ;({ projectId, deckId } = await accountDeck(api, GRAPHS, 'Graphs'))
      store = await anaOpensDeyslide()
      session = await openReady(store, projectId, deckId)
      if (variables.storage === 'IndexedDB')
        await vi.waitFor(() => expect(store.keptOnDevice(deckId)).toBe(true))
      else
        await new Promise(resolve => setTimeout(resolve, 50))
      anaIsOffline()
      changeSlide(session, 2, () => '## Offline idea')
      session.close()
      session = undefined
    })
    When('Deyslide closes', async () => {
      warned = await store.flushAll()
      const leaving = new Event('beforeunload', { cancelable: true })
      window.dispatchEvent(leaving)
      asked = leaving.defaultPrevented
    })
    Then('it warns about <warned>', () => {
      if (variables.warned === 'no deck') {
        expect(warned).toEqual([])
        expect(asked).toBe(false)
      }
      else {
        expect(variables.warned).toBe('"Graphs"')
        expect(warned).toEqual(['Graphs'])
        expect(asked).toBe(true)
        expect(store.keptOnDevice(deckId)).toBe(false)
      }
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
