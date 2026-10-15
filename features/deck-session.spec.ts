import type { DeckSession } from '../apps/web/src/deck/session'
import type { Project } from '../apps/web/src/guest/types'
import type { DeckElement } from '../packages/deck-model/src'
import { describeFeature, loadFeature } from '@amiceli/vitest-cucumber'
import { expect, vi } from 'vitest'
import * as Y from 'yjs'
import { ASSISTANT_ORIGIN, CAPTURE_TIMEOUT_MS, holdsDeck, statusLabel } from '../apps/web/src/deck/session'
import { MemoryGuestStorage } from '../apps/web/src/guest/memory-storage'
import { GuestStore } from '../apps/web/src/guest/store'
import { CloudStore } from '../apps/web/src/projects/cloud-store'
import { applyMarkdown, deckMarkdown, deckToYDoc, fromMarkdown, joinSlides, readDeckDoc, slideTexts, updateElement } from '../packages/deck-model/src'
import { introduce, openReady } from './support/live-decks'
import { FakeProjectApi } from './support/project-api'

const feature = await loadFeature('./deck-session.feature')

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

/** The Markdown of a text or raw element. */
const markdownOf = (element: DeckElement) => 'markdown' in element ? element.markdown : undefined

/** The title text of a blank deck: the first element of its first slide. */
const titleOf = (doc: Y.Doc) => markdownOf(readDeckDoc(doc).slides[0].elements[0])

/** Changes a blank deck's title through the session, as the canvas would. */
function changeTitle(session: DeckSession, markdown: string) {
  const slide = readDeckDoc(session.doc).slides[0]
  session.transact(() => updateElement(session.doc, slide.id, slide.elements[0].id, { markdown }))
}

describeFeature(feature, ({ Scenario, AfterEachScenario }) => {
  let storage: MemoryGuestStorage
  let guest: GuestStore
  let api: FakeProjectApi
  let cloud: CloudStore
  let projectId: string
  let deckId: string
  let session: DeckSession
  let other: DeckSession | undefined
  let budi: DeckSession | undefined
  let time = 1000

  AfterEachScenario(() => {
    session?.close()
    other?.close()
    budi?.close()
    other = undefined
    budi = undefined
  })

  const project = () => guest.listProjects()[0]

  async function guestDeck() {
    storage = new MemoryGuestStorage()
    guest = await GuestStore.open(storage, { now: () => time })
    projectId = (await guest.createProject('Talks')).id
    deckId = (await guest.createDeck(projectId, 'Graphs', 'blank')).id
  }

  async function accountDeck() {
    api = new FakeProjectApi()
    cloud = await CloudStore.open(api)
    projectId = (await cloud.createProject('Talks')).id
    deckId = (await cloud.createDeck(projectId, 'Graphs', 'blank')).id
  }

  const room = () => api.rooms.get(deckId)!

  Scenario('A deck in the browser opens ready and keeps every change', ({ Given, When, Then, And }) => {
    Given('a guest has the blank deck "Graphs" in this browser', guestDeck)
    When('they open the deck', async () => {
      session = await guest.openDeck(projectId, deckId)
    })
    Then('the session holds the deck, can be changed and says "Saved"', () => {
      expect(session.ready.value).toBe(true)
      expect(session.readOnly.value).toBe(false)
      expect(statusLabel(session.status.value, session.error.value)).toBe('Saved')
    })
    When('they change the title to "# Changed" through the session', () => {
      time = 2000
      changeTitle(session, '# Changed')
    })
    Then('the browser\'s copy of the deck has "# Changed" while the deck is still open', async () => {
      const copy = await storage.openDeck(deckId)
      expect(titleOf(copy.doc)).toBe('# Changed')
      copy.doc.destroy()
    })
    And('a moment later the project lists the deck as changed', async () => {
      await vi.waitFor(() => expect(project().decks[0]).toMatchObject({ slideCount: 1, updatedAt: 2000 }))
      expect(project().updatedAt).toBe(2000)
    })
  })

  Scenario('Everything that reads a browser deck shares the open document', ({ Given, And, Then, When }) => {
    let slideId: string
    Given('a guest has the blank deck "Graphs" in this browser', guestDeck)
    And('they open the deck twice', async () => {
      session = await guest.openDeck(projectId, deckId)
      other = await guest.openDeck(projectId, deckId)
      slideId = readDeckDoc(session.doc).slides[0].id
    })
    Then('both sessions share one document', () => {
      expect(other!.doc).toBe(session.doc)
    })
    When('the store saves new content for the deck', async () => {
      const deck = readDeckDoc(session.doc)
      deck.slides[0].elements[0] = { ...deck.slides[0].elements[0], markdown: '# Charts' } as DeckElement
      await guest.saveDeck(projectId, deckId, deck)
    })
    Then('both sessions have it at once, and the title slide keeps its id', async () => {
      expect(titleOf(session.doc)).toBe('# Charts')
      expect(titleOf(other!.doc)).toBe('# Charts')
      expect(readDeckDoc(session.doc).slides[0].id).toBe(slideId)
      expect(await guest.deckMarkdown(deckId)).toContain('# Charts')
    })
  })

  Scenario('An account deck is read only until it first syncs', ({ Given, And, When, Then }) => {
    Given('Ana is signed in with the blank deck "Graphs" in Ana\'s account', accountDeck)
    And('Ana\'s connection is down', () => {
      api.goOffline()
    })
    When('Ana opens the deck', async () => {
      session = await cloud.openDeck(projectId, deckId)
      await sleep(10)
    })
    Then('the session is read only, holds no deck yet and says "Offline. Changes sync when you are back online."', () => {
      expect(session.readOnly.value).toBe(true)
      expect(session.ready.value).toBe(false)
      expect(holdsDeck(session.doc)).toBe(false)
      expect(statusLabel(session.status.value, session.error.value)).toBe('Offline. Changes sync when you are back online.')
    })
    And('a change through the session does nothing', () => {
      session.transact(() => session.doc.getMap('deck').set('version', 1))
      expect(holdsDeck(session.doc)).toBe(false)
    })
    When('Ana\'s connection comes back', () => {
      api.goOnline()
    })
    Then('the session holds the deck, can be changed and says "Saved"', async () => {
      await vi.waitFor(() => expect(session.ready.value).toBe(true))
      expect(session.readOnly.value).toBe(false)
      expect(titleOf(session.doc)).toBe('# Graphs')
      expect(statusLabel(session.status.value, session.error.value)).toBe('Saved')
    })
    And('it asked for a token to connect', () => {
      expect(api.tokens).toEqual(['cookie', 'cookie'])
    })
  })

  Scenario('Changes made offline after the first sync are kept and go out later', ({ Given, And, When, Then }) => {
    Given('Ana is signed in with the blank deck "Graphs" in Ana\'s account', accountDeck)
    And('Ana has the deck open', async () => {
      session = await openReady(cloud, projectId, deckId)
    })
    When('Ana\'s connection drops', () => {
      api.goOffline()
    })
    And('Ana changes the title to "# Offline" through the session', () => {
      changeTitle(session, '# Offline')
    })
    Then('the session says "Offline. Changes sync when you are back online." and can still be changed', () => {
      expect(statusLabel(session.status.value, session.error.value)).toBe('Offline. Changes sync when you are back online.')
      expect(session.readOnly.value).toBe(false)
      expect(titleOf(session.doc)).toBe('# Offline')
      expect(titleOf(room())).toBe('# Graphs')
    })
    When('Ana\'s connection comes back', () => {
      api.goOnline()
    })
    Then('the account\'s deck has "# Offline"', async () => {
      await vi.waitFor(() => expect(titleOf(room())).toBe('# Offline'))
      expect(statusLabel(session.status.value, session.error.value)).toBe('Saved')
    })
  })

  Scenario('Changes made offline still reach the account after the deck is closed', ({ Given, And, When, Then }) => {
    Given('Ana is signed in with the blank deck "Graphs" in Ana\'s account', accountDeck)
    And('Ana has the deck open', async () => {
      session = await openReady(cloud, projectId, deckId)
    })
    When('Ana\'s connection drops', () => {
      api.goOffline()
    })
    And('Ana changes the title to "# On the train" through the session and closes the deck', () => {
      changeTitle(session, '# On the train')
      session.close()
      // Nobody sees Ana here any more, though the change still waits.
      expect(session.awareness.getLocalState()).toBeNull()
      expect(session.doc.isDestroyed).toBe(false)
    })
    And('Ana\'s connection comes back', () => {
      api.goOnline()
    })
    Then('the account\'s deck has "# On the train"', async () => {
      await vi.waitFor(() => expect(titleOf(room())).toBe('# On the train'))
    })
    And('the store lets go of the deck once the server has the change', async () => {
      await vi.waitFor(() => expect(session.doc.isDestroyed).toBe(true))
    })
  })

  Scenario('Opening a deck again while its offline changes wait shows them', ({ Given, And, When, Then }) => {
    Given('Ana is signed in with the blank deck "Graphs" in Ana\'s account', accountDeck)
    And('Ana has the deck open', async () => {
      session = await openReady(cloud, projectId, deckId)
    })
    When('Ana\'s connection drops', () => {
      api.goOffline()
    })
    And('Ana changes the title to "# On the train" through the session and closes the deck', () => {
      changeTitle(session, '# On the train')
      session.close()
    })
    And('Ana opens the deck again while still offline', async () => {
      other = await cloud.openDeck(projectId, deckId)
    })
    Then('the session has "# On the train" and can be changed', () => {
      expect(other!.ready.value).toBe(true)
      expect(other!.readOnly.value).toBe(false)
      expect(titleOf(other!.doc)).toBe('# On the train')
      expect(statusLabel(other!.status.value, other!.error.value)).toBe('Offline. Changes sync when you are back online.')
    })
  })

  Scenario('Two people see each other\'s changes at once', ({ Given, And, When, Then }) => {
    Given('Ana is signed in with the blank deck "Graphs" in Ana\'s account', accountDeck)
    And('Ana has the deck open', async () => {
      session = await openReady(cloud, projectId, deckId)
    })
    And('Budi has the same deck open in another browser', async () => {
      budi = await openReady(await CloudStore.open(api), projectId, deckId)
    })
    When('Ana changes the title to "# From Ana" through the session', () => {
      changeTitle(session, '# From Ana')
    })
    Then('Budi\'s copy has "# From Ana" at once', () => {
      expect(titleOf(budi!.doc)).toBe('# From Ana')
    })
  })

  const sharedWithAna = (Given: (title: string, run: () => Promise<void>) => void) =>
    Given('Budi shared the deck "Sorting" with Ana as a viewer', async () => {
      api = new FakeProjectApi()
      const now = Date.now()
      const shared: Project = {
        id: 'shared-project',
        name: 'Algorithms 101',
        createdAt: now,
        updatedAt: now,
        shared: { owner: { name: 'Budi', email: 'budi@example.com' }, role: null },
        decks: [{ id: 'shared-deck', name: 'Sorting', slideCount: 1, createdAt: now, updatedAt: now, role: 'viewer' }],
      }
      api.sharedProjects.push(shared)
      api.putDeckState('shared-deck', Y.encodeStateAsUpdate(deckToYDoc(fromMarkdown('# Sorting\n'))))
      cloud = await CloudStore.open(api)
      projectId = shared.id
      deckId = 'shared-deck'
    })

  Scenario('A viewer follows along but changes nothing', ({ Given, When, Then }) => {
    sharedWithAna(Given)
    When('Ana opens the deck', async () => {
      session = await openReady(cloud, projectId, deckId)
    })
    Then('Ana\'s session holds the deck and is read only', () => {
      expect(session.readOnly.value).toBe(true)
      expect(titleOf(session.doc)).toBe('# Sorting')
    })
    When('Budi changes the deck to "# Live"', () => {
      api.changeRoom(deckId, doc => applyMarkdown(doc, '# Live\n'))
    })
    Then('Ana\'s copy has "# Live"', () => {
      expect(titleOf(session.doc)).toBe('# Live')
    })
  })

  Scenario('The store does not save through a deck open read only', ({ Given, And, When, Then }) => {
    let saving: Promise<void>
    sharedWithAna(Given)
    And('Ana has the shared deck open', async () => {
      session = await openReady(cloud, projectId, deckId)
    })
    When('the store saves new content for the shared deck', () => {
      const deck = readDeckDoc(session.doc)
      deck.slides[0].elements[0] = { ...deck.slides[0].elements[0], markdown: '# Mine' } as DeckElement
      saving = cloud.saveDeck(projectId, deckId, deck)
    })
    Then('the save fails with "This deck can only be viewed here right now, so the change was not saved."', async () => {
      await expect(saving).rejects.toThrow('This deck can only be viewed here right now, so the change was not saved.')
    })
    And('Ana\'s copy still has "# Sorting"', () => {
      expect(titleOf(session.doc)).toBe('# Sorting')
      expect(titleOf(room())).toBe('# Sorting')
    })
  })

  Scenario('Losing access stops editing', ({ Given, And, When, Then }) => {
    Given('Ana is signed in with the blank deck "Graphs" in Ana\'s account', accountDeck)
    And('Ana has the deck open', async () => {
      session = await openReady(cloud, projectId, deckId)
    })
    When('the server stops letting Ana into the deck', () => {
      api.failAuth()
    })
    Then('the session says "Not saved: You no longer have access to this deck." and is read only', () => {
      expect(statusLabel(session.status.value, session.error.value)).toBe('Not saved: You no longer have access to this deck.')
      expect(session.readOnly.value).toBe(true)
      changeTitle(session, '# Mine')
      expect(titleOf(session.doc)).toBe('# Graphs')
    })
  })

  Scenario('People see who else has the deck open', ({ Given, And, Then, When }) => {
    Given('Ana is signed in with the blank deck "Graphs" in Ana\'s account', accountDeck)
    And('Ana has the deck open', async () => {
      session = await openReady(cloud, projectId, deckId)
      introduce(session, 'user-ana', 'Ana')
    })
    And('Budi has the same deck open in another browser', async () => {
      budi = await openReady(await CloudStore.open(api), projectId, deckId)
      introduce(budi, 'user-budi', 'Budi')
    })
    Then('Ana\'s session lists Budi as here, and Budi\'s lists Ana', async () => {
      await vi.waitFor(() => expect(session.peers.value.map(peer => peer.user.name)).toEqual(['Budi']))
      expect(budi!.peers.value.map(peer => peer.user.name)).toEqual(['Ana'])
      expect(session.peers.value[0]).toMatchObject({ clientId: budi!.doc.clientID, user: { id: 'user-budi', name: 'Budi' } })
    })
    When('Budi closes the deck', () => {
      budi!.close()
      budi = undefined
    })
    Then('Ana\'s session lists nobody else', async () => {
      await vi.waitFor(() => expect(session.peers.value).toEqual([]))
    })
  })

  Scenario('The store reads and saves an open account deck through its live copy', ({ Given, And, When, Then }) => {
    Given('Ana is signed in with the blank deck "Graphs" in Ana\'s account', accountDeck)
    And('Ana has the deck open', async () => {
      session = await openReady(cloud, projectId, deckId)
    })
    When('the store saves new content for the deck', async () => {
      const deck = readDeckDoc(session.doc)
      deck.slides[0].elements[0] = { ...deck.slides[0].elements[0], markdown: '# Charts' } as DeckElement
      await cloud.saveDeck(projectId, deckId, deck)
    })
    Then('the session has it at once, and so does the server', () => {
      expect(titleOf(session.doc)).toBe('# Charts')
      expect(titleOf(room())).toBe('# Charts')
    })
    And('reading the deck from the store gives the open session\'s content', async () => {
      // The server is not asked: the open deck has it.
      api.failWith = 'Deyslide is unreachable. Check your connection and try again.'
      expect(markdownOf((await cloud.readDeck(deckId)).slides[0].elements[0])).toBe('# Charts')
      expect(await cloud.deckMarkdown(deckId)).toContain('# Charts')
    })
  })

  Scenario('Changes grouped together undo in one step, and redo', ({ Given, And, When, Then }) => {
    Given('a guest has the blank deck "Graphs" in this browser', guestDeck)
    And('they open the deck', async () => {
      session = await guest.openDeck(projectId, deckId)
    })
    When('they change the title twice in one group', async () => {
      const group = session.group()
      changeTitle(session, '# One')
      // Longer than one undo step lasts on its own.
      await sleep(CAPTURE_TIMEOUT_MS + 100)
      changeTitle(session, '# Two')
      group.end()
    })
    And('they undo', () => {
      session.undoStep()
    })
    Then('the title is back to "# Graphs"', () => {
      expect(titleOf(session.doc)).toBe('# Graphs')
    })
    When('they redo', () => {
      session.redoStep()
    })
    Then('the title is the second change again', () => {
      expect(titleOf(session.doc)).toBe('# Two')
    })
  })

  Scenario('Undo skips the assistant\'s changes', ({ Given, And, When, Then }) => {
    Given('a guest has the blank deck "Graphs" in this browser', guestDeck)
    And('they open the deck', async () => {
      session = await guest.openDeck(projectId, deckId)
    })
    When('they change the title to "# Mine" through the session', () => {
      changeTitle(session, '# Mine')
    })
    And('the assistant adds a slide', () => {
      const markdown = joinSlides([...slideTexts(deckMarkdown(session.doc)), '# From Claude\n'])
      applyMarkdown(session.doc, markdown, ASSISTANT_ORIGIN)
      expect(readDeckDoc(session.doc).slides).toHaveLength(2)
    })
    And('they undo', () => {
      session.undoStep()
    })
    Then('the title is back to "# Graphs" and the assistant\'s slide is still there', () => {
      expect(titleOf(session.doc)).toBe('# Graphs')
      expect(slideTexts(deckMarkdown(session.doc))[1]).toContain('# From Claude')
      // Nothing else to undo: the assistant's own Undo takes its slide back.
      session.undoStep()
      expect(readDeckDoc(session.doc).slides).toHaveLength(2)
    })
  })
})
