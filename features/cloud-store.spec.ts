// @vitest-environment node
import type { TestBrowser, TestServer } from './support/server'
import { describeFeature, loadFeature } from '@amiceli/vitest-cucumber'
import { parseSync } from '@slidev/parser/core'
import { beforeAll, expect } from 'vitest'
import { MemoryGuestStorage } from '../apps/web/src/guest/memory-storage'
import { GuestStore } from '../apps/web/src/guest/store'
import { HttpProjectApi } from '../apps/web/src/projects/api'
import { CloudStore } from '../apps/web/src/projects/cloud-store'
import { createTestServer, DATABASE_WARM_UP_MS, signedInBrowser, warmUpDatabase } from './support/server'

const feature = await loadFeature('./cloud-store.feature')

beforeAll(warmUpDatabase, DATABASE_WARM_UP_MS)

describeFeature(feature, ({ Background, Scenario }) => {
  let server: TestServer
  let ana: TestBrowser
  let store: CloudStore
  let guest: GuestStore
  let error: unknown
  let networkDown: boolean

  const project = () => store.listProjects()[0]

  async function attempt(action: () => Promise<unknown>) {
    error = undefined
    try {
      await action()
    }
    catch (caught) {
      error = caught
    }
  }

  Background(({ Given, And }) => {
    Given('the Deyslide API with email sending', async () => {
      server = await createTestServer()
      networkDown = false
    })
    And('the web app\'s cloud store for Ana, who is signed in', async () => {
      ana = await signedInBrowser(server, 'ana@example.com')
      const fetchThroughAna = ((input, init) => {
        if (networkDown)
          return Promise.reject(new TypeError('Failed to fetch'))
        return ana.fetch(input, init)
      }) as typeof fetch
      store = await CloudStore.open(new HttpProjectApi(fetchThroughAna))
    })
  })

  Scenario('Create a project and a demo deck, then read the deck back', ({ When, Then, And }) => {
    When('the store creates the project "Algorithms 101" with the demo deck "Sorting"', async () => {
      const created = await store.createProject('Algorithms 101')
      await store.createDeck(created.id, 'Sorting', 'demo')
    })
    Then('the store lists "Algorithms 101" with the deck "Sorting" of 5 slides', () => {
      expect([project().name, project().decks.map(deck => [deck.name, deck.slideCount])]).toEqual(['Algorithms 101', [['Sorting', 5]]])
    })
    And('reading the deck gives 5 slides, the first titled "Deyslide"', async () => {
      const deck = await store.readDeck(project().decks[0].id)
      expect(deck.slides).toHaveLength(5)
      expect(deck.slides[0].frontmatter.title).toBe('Deyslide')
    })
    And('its Markdown is valid Slidev Markdown with 5 slides', async () => {
      expect(parseSync(await store.deckMarkdown(project().decks[0].id), 'slides.md').slides).toHaveLength(5)
    })
  })

  Scenario('Browser projects move with their ids', ({ Given, When, Then, And }) => {
    Given('a browser store with the project "Algorithms 101" holding the demo deck "Sorting"', async () => {
      guest = await GuestStore.open(new MemoryGuestStorage())
      const created = await guest.createProject('Algorithms 101')
      await guest.createDeck(created.id, 'Sorting', 'demo')
    })
    When('the store imports the browser\'s projects', async () => {
      expect(await store.importProjects(await guest.exportProjects())).toBe(1)
    })
    Then('the store lists "Algorithms 101" with the deck "Sorting" of 5 slides', () => {
      expect([project().name, project().decks.map(deck => [deck.name, deck.slideCount])]).toEqual(['Algorithms 101', [['Sorting', 5]]])
    })
    And('the project and the deck keep their browser ids', () => {
      const browserProject = guest.listProjects()[0]
      expect([project().id, project().decks[0].id]).toEqual([browserProject.id, browserProject.decks[0].id])
    })
  })

  Scenario('A signed out request explains itself', ({ Given, When, Then }) => {
    Given('Ana signs out in another tab', async () => {
      expect((await ana.request('/api/auth/sign-out', { json: {} })).status).toBe(200)
    })
    When('the store tries to create the project "Algorithms 101"', () => attempt(() => store.createProject('Algorithms 101')))
    Then('it fails with "You are signed out. Sign in again to keep working."', () => {
      expect((error as Error).message).toBe('You are signed out. Sign in again to keep working.')
    })
  })

  Scenario('An unreachable server explains itself', ({ Given, When, Then }) => {
    Given('the network is down', () => {
      networkDown = true
    })
    When('the store tries to create the project "Algorithms 101"', () => attempt(() => store.createProject('Algorithms 101')))
    Then('it fails with "Deyslide is unreachable. Check your connection and try again."', () => {
      expect((error as Error).message).toBe('Deyslide is unreachable. Check your connection and try again.')
    })
  })
})
