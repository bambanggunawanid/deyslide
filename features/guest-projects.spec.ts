import 'fake-indexeddb/auto'
import type { GuestStore } from '../apps/web/src/guest/store'
import { describeFeature, loadFeature } from '@amiceli/vitest-cucumber'
import { parseSync } from '@slidev/parser/core'
import { IDBFactory } from 'fake-indexeddb'
import { expect } from 'vitest'
import { IndexedDbGuestStorage } from '../apps/web/src/guest/indexeddb-storage'
import { GuestStore as Store } from '../apps/web/src/guest/store'

const feature = await loadFeature('./guest-projects.feature')

// Gherkin tables trim cells, so a name of only spaces is written with · here.
const unescapeSpaces = (value: string) => value.replace(/·/g, ' ')

describeFeature(feature, ({ Background, Scenario, ScenarioOutline }) => {
  let store: GuestStore
  let error: unknown

  const openStore = () => Store.open(new IndexedDbGuestStorage())
  const project = () => store.listProjects()[0]
  const deckNamed = (name: string) => project().decks.find(deck => deck.name === name)!

  async function projectWithDemoDeck() {
    const created = await store.createProject('Algorithms 101')
    await store.createDeck(created.id, 'Sorting', 'demo')
  }

  Background(({ Given }) => {
    Given('a visitor with an empty browser', async () => {
      // A fresh IndexedDB for every scenario, like a new browser profile.
      globalThis.indexedDB = new IDBFactory()
      store = await openStore()
      error = undefined
    })
  })

  Scenario('A visitor creates a project', ({ When, Then }) => {
    When('they create the project "Algorithms 101"', async () => {
      await store.createProject('Algorithms 101')
    })
    Then('their projects are "Algorithms 101" with 0 decks', () => {
      expect(store.listProjects().map(item => [item.name, item.decks.length])).toEqual([['Algorithms 101', 0]])
    })
  })

  Scenario('A visitor starts a deck from the demo template', ({ Given, When, Then, And }) => {
    Given('the project "Algorithms 101"', async () => {
      await store.createProject('Algorithms 101')
    })
    When('they add the deck "Sorting" from the demo template', async () => {
      await store.createDeck(project().id, 'Sorting', 'demo')
    })
    Then('the project lists 1 deck named "Sorting" with 5 slides', () => {
      expect(project().decks.map(deck => [deck.name, deck.slideCount])).toEqual([['Sorting', 5]])
    })
    And('the deck\'s Markdown is valid Slidev Markdown with 5 slides', async () => {
      const markdown = await store.deckMarkdown(deckNamed('Sorting').id)
      expect(parseSync(markdown, 'slides.md').slides).toHaveLength(5)
    })
    And('the deck\'s first slide keeps the demo title "Deyslide"', async () => {
      const deck = await store.readDeck(deckNamed('Sorting').id)
      expect(deck.slides[0].frontmatter.title).toBe('Deyslide')
    })
  })

  Scenario('A visitor starts a blank deck', ({ Given, When, Then }) => {
    Given('the project "Algorithms 101"', async () => {
      await store.createProject('Algorithms 101')
    })
    When('they add the deck "Graphs" from the blank template', async () => {
      await store.createDeck(project().id, 'Graphs', 'blank')
    })
    Then('the deck has 1 slide with the heading "# Graphs"', async () => {
      const deck = await store.readDeck(deckNamed('Graphs').id)
      expect(deck.slides).toHaveLength(1)
      expect(deck.slides[0].elements[0]).toMatchObject({ type: 'text', markdown: '# Graphs' })
    })
  })

  Scenario('Guest work survives a reload', ({ Given, When, Then, And }) => {
    Given('the project "Algorithms 101" with the demo deck "Sorting"', projectWithDemoDeck)
    When('the page is reloaded', async () => {
      store = await openStore()
    })
    Then('their projects are "Algorithms 101" with 1 deck', () => {
      expect(store.listProjects().map(item => [item.name, item.decks.length])).toEqual([['Algorithms 101', 1]])
    })
    And('the deck "Sorting" still has 5 slides', async () => {
      expect((await store.readDeck(deckNamed('Sorting').id)).slides).toHaveLength(5)
    })
  })

  Scenario('Rename and delete', ({ Given, When, And, Then }) => {
    let deckId: string
    Given('the project "Algorithms 101" with the demo deck "Sorting"', async () => {
      await projectWithDemoDeck()
      deckId = deckNamed('Sorting').id
    })
    When('they rename the project to "Algorithms 102"', async () => {
      await store.renameProject(project().id, 'Algorithms 102')
    })
    And('they delete the deck "Sorting"', async () => {
      await store.deleteDeck(project().id, deckId)
    })
    And('the page is reloaded', async () => {
      store = await openStore()
    })
    Then('their projects are "Algorithms 102" with 0 decks', () => {
      expect(store.listProjects().map(item => [item.name, item.decks.length])).toEqual([['Algorithms 102', 0]])
    })
    And('the deck content is gone from the browser', async () => {
      await expect(store.readDeck(deckId)).rejects.toThrow()
    })
  })

  ScenarioOutline('Names are checked', ({ When, Then }, variables) => {
    When('they try to create a project named "<name>"', async () => {
      try {
        await store.createProject(unescapeSpaces(variables.name))
      }
      catch (caught) {
        error = caught
      }
    })
    Then('it is refused with "<message>"', () => {
      expect(String(error)).toContain(variables.message)
      expect(store.listProjects()).toHaveLength(0)
    })
  })
})
