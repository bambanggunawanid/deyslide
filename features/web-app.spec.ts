import type { GuestStore } from '../apps/web/src/guest/store'
import type { WebApp } from './support/web'
import { describeFeature, loadFeature } from '@amiceli/vitest-cucumber'
import { expect, vi } from 'vitest'
import { previewRequests, resetEditorDoubles } from './support/editor-doubles'
import { find, mountWebApp, text } from './support/web'

const feature = await loadFeature('./web-app.feature')

describeFeature(feature, ({ Background, Scenario, AfterEachScenario }) => {
  let web: WebApp
  let store: GuestStore

  const click = (selector: string) => web.click(selector)
  const router = () => web.router

  async function submitName(name: string) {
    await web.fill('[data-testid="name-input"]', name)
    await click('[data-testid="name-submit"]')
  }

  async function createProject(name: string) {
    await click('[data-testid="new-project"]')
    await submitName(name)
    await vi.waitFor(() => expect(router().currentRoute.value.name).toBe('project'))
  }

  async function addDeck(name: string, template: string) {
    await click('[data-testid="new-deck"]')
    await click(`[data-template="${template}"]`)
    await submitName(name)
    await vi.waitFor(() => expect(router().currentRoute.value.name).toBe('deck'))
    await vi.waitFor(() => expect(find('[data-testid="slide-position"]')).not.toBeNull())
  }

  AfterEachScenario(() => {
    web?.unmount()
    resetEditorDoubles()
  })

  Background(({ Given }) => {
    Given('the web app opened at "/"', async () => {
      web = await mountWebApp()
      store = web.store
    })
  })

  Scenario('A first visit shows an empty home page', ({ Then, And }) => {
    Then('the home page says there are no projects yet', () => {
      expect(text('[data-testid="empty-projects"]')).toContain('No projects yet')
    })
    And('the guest banner says the work is saved in this browser only', () => {
      expect(text('[data-testid="guest-banner"]')).toContain('saved in this browser only')
    })
  })

  Scenario('Create a project from the home page', ({ When, Then, And }) => {
    When('they create the project "Algorithms 101" from the home page', async () => {
      await createProject('Algorithms 101')
    })
    Then('the project page for "Algorithms 101" is open', () => {
      expect(router().currentRoute.value.params.projectId).toBe(store.listProjects()[0].id)
      expect(text('[data-testid="project-name"]')).toBe('Algorithms 101')
    })
    And('it says the project has no decks', () => {
      expect(text('[data-testid="empty-decks"]')).toContain('No decks in this project')
    })
  })

  Scenario('Start a deck from the demo template', ({ Given, When, Then, And }) => {
    Given('the project "Algorithms 101" is open', async () => {
      await createProject('Algorithms 101')
    })
    When('they add the deck "Sorting" from the demo template', async () => {
      await addDeck('Sorting', 'demo')
    })
    Then('the deck page for "Sorting" is open', () => {
      expect(text('[data-testid="deck-name"]')).toBe('Sorting')
    })
    And('the editor shows slide 1 of 5, the cover titled "Deyslide"', async () => {
      await vi.waitFor(() => expect(text('[data-testid="slide-position"]')).toBe('Slide 1 of 5'))
      const request = previewRequests.at(-1)!
      expect(request.slide.first).toBe(true)
      expect(request.slide.content).toContain('Deyslide')
    })
  })

  Scenario('Download a deck as Markdown', ({ Given, When, Then }) => {
    let saved: { name: string, type: string } | undefined

    Given('the deck "Sorting" from the demo template is open', async () => {
      await createProject('Algorithms 101')
      await addDeck('Sorting', 'demo')
    })
    When('they download the deck as Markdown', async () => {
      let blob: Blob | undefined
      vi.spyOn(URL, 'createObjectURL').mockImplementation((object) => {
        blob = object as Blob
        return 'blob:deck'
      })
      vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
      vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
        saved = { name: this.download, type: blob?.type ?? '' }
      })
      await click('[data-testid="download-markdown"]')
    })
    Then('the browser saves the file "Sorting.md"', () => {
      expect(saved).toEqual({ name: 'Sorting.md', type: 'text/markdown' })
      vi.restoreAllMocks()
    })
  })

  Scenario('A project name is required', ({ When, Then }) => {
    When('they try to create a project with an empty name', async () => {
      await click('[data-testid="new-project"]')
      await submitName('   ')
    })
    Then('the dialog stays open with the error "A project needs a name"', () => {
      expect(find('[data-testid="name-dialog"]')).not.toBeNull()
      expect(text('[data-testid="name-dialog"] [role="alert"]')).toBe('A project needs a name')
      expect(store.listProjects()).toEqual([])
    })
  })

  Scenario('A link to a project from another browser', ({ When, Then }) => {
    When('they open "/p/unknown-project"', async () => {
      await router().push('/p/unknown-project')
      await web.settle()
    })
    Then('the page says the project is not in this browser', () => {
      expect(text('[data-testid="missing-project"]')).toContain('not in this browser')
    })
  })
})
