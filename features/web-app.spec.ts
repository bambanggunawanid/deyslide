import type { GuestStore } from '../apps/web/src/guest/store'
import type { WebApp } from './support/web'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describeFeature, loadFeature } from '@amiceli/vitest-cucumber'
import { expect, vi } from 'vitest'
import { previewRequests, resetEditorDoubles } from './support/editor-doubles'
import { find, findAll, mountWebApp, text } from './support/web'

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

  Scenario('Delete a deck from the project page', ({ Given, When, Then, And }) => {
    let graphsId: string
    Given('the project "Algorithms 101" with the decks "Graphs" and "Sorting" is open', async () => {
      const project = await store.createProject('Algorithms 101')
      graphsId = (await store.createDeck(project.id, 'Graphs', 'blank')).id
      await store.createDeck(project.id, 'Sorting', 'blank')
      await router().push({ name: 'project', params: { projectId: project.id } })
      await web.waitFor('[data-deck="Graphs"]')
    })
    When('they delete the deck "Graphs" from the project page', async () => {
      const item = find('[data-deck="Graphs"]')!.closest('li')!
      const remove = [...item.querySelectorAll('button')].find(button => button.textContent?.trim() === 'Delete')!
      remove.click()
      await web.settle()
    })
    Then('the question said "Graphs will be removed from this browser. This cannot be undone."', async () => {
      await vi.waitFor(() => expect(text('[data-testid="confirm-dialog"]')).toContain('Graphs will be removed from this browser. This cannot be undone.'))
      await click('[data-testid="confirm-action"]')
    })
    And('the project page lists only the deck "Sorting"', async () => {
      await vi.waitFor(() => expect(findAll('[data-deck]').map(link => link.dataset.deck)).toEqual(['Sorting']))
    })
    And('the browser no longer holds the deck "Graphs"', async () => {
      expect(store.listProjects()[0].decks.map(deck => deck.name)).toEqual(['Sorting'])
      await expect(store.readDeck(graphsId)).rejects.toThrow()
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

  Scenario('The pages name the Deyslide icon', ({ Then, And }) => {
    const shell = () => new DOMParser().parseFromString(readFileSync(resolve(import.meta.dirname, '../apps/web/index.html'), 'utf8'), 'text/html')
    const icon = () => shell().head.querySelector<HTMLLinkElement>('link[rel="icon"]')
    Then('the page\'s head names an SVG icon with the Deyslide mark', () => {
      expect(icon()?.getAttribute('type')).toBe('image/svg+xml')
      // Vite takes the file from the web app's folder and gives it a hashed name in the build.
      const svg = readFileSync(resolve(import.meta.dirname, `../apps/web${icon()!.getAttribute('href')}`), 'utf8')
      expect(svg).toContain('<svg')
      expect(svg).toContain('fill="#38bdf8"')
    })
    And('browsers that find it there do not ask for "/favicon.ico"', () => {
      // A browser asks for /favicon.ico only when the page names no icon.
      expect(shell().head.querySelectorAll('link[rel~="icon"]')).toHaveLength(1)
    })
  })
})
