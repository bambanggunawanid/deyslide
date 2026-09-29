import type { WebApp } from './support/web'
import { describeFeature, loadFeature } from '@amiceli/vitest-cucumber'
import { expect, vi } from 'vitest'
import { MemoryGuestStorage } from '../apps/web/src/guest/memory-storage'
import { GuestStore } from '../apps/web/src/guest/store'
import { FakeAccountService } from './support/account'
import { FakeProjectApi } from './support/project-api'
import { find, findAll, mountWebApp, text } from './support/web'

const feature = await loadFeature('./web-cloud.feature')

describeFeature(feature, ({ Scenario, BeforeEachScenario, AfterEachScenario }) => {
  let web: WebApp
  let service: FakeAccountService
  let api: FakeProjectApi
  let guest: GuestStore

  BeforeEachScenario(async () => {
    service = new FakeAccountService()
    service.addAccount('ana@example.com', 'correct horse')
    api = new FakeProjectApi()
    guest = await GuestStore.open(new MemoryGuestStorage())
  })
  AfterEachScenario(() => web?.unmount())

  const open = async (path = '/') => {
    web = await mountWebApp({ path, service, api, guest })
  }
  const signedIn = async () => {
    await service.signIn({ email: 'ana@example.com', password: 'correct horse' })
    await open()
  }
  const projectNames = () => findAll('[data-project]').map(item => item.dataset.project)
  const cloudSummary = () => api.projects.map(project => [project.name, project.decks.map(deck => deck.name)])

  async function guestProjectWithDemoDeck() {
    const project = await guest.createProject('Algorithms 101')
    await guest.createDeck(project.id, 'Sorting', 'demo')
  }

  async function signInWithPassword() {
    await open('/sign-in')
    await web.fill('[data-testid="email"]', 'ana@example.com')
    await web.fill('[data-testid="password"]', 'correct horse')
    await web.submit('[data-testid="password-form"]')
    await vi.waitFor(() => expect(web.router.currentRoute.value.name).toBe('home'))
    await web.settle()
  }

  async function accountHoldsProject() {
    await api.createProject('Algorithms 101')
  }

  Scenario('A signed in person sees the projects in their account', ({ Given, When, Then, And }) => {
    Given('Ana\'s account holds the project "Algorithms 101"', accountHoldsProject)
    When('Ana opens the web app signed in', signedIn)
    Then('the home page lists "Algorithms 101"', () => {
      expect(projectNames()).toEqual(['Algorithms 101'])
    })
    And('there is no guest banner', () => {
      expect(find('[data-testid="guest-banner"]')).toBeNull()
    })
  })

  Scenario('Signing in moves browser projects into the account', ({ Given, When, Then, And }) => {
    Given('a guest made the project "Algorithms 101" with the demo deck "Sorting" in this browser', guestProjectWithDemoDeck)
    When('they sign in as Ana with a password', signInWithPassword)
    Then('the home page lists "Algorithms 101" with 1 deck', () => {
      expect(projectNames()).toEqual(['Algorithms 101'])
      expect(text('[data-project="Algorithms 101"]')).toContain('1 deck')
    })
    And('the home page says "Moved 1 project from this browser to your account."', () => {
      expect(text('[data-testid="workspace-notice"] span')).toBe('Moved 1 project from this browser to your account.')
    })
    And('Ana\'s account holds "Algorithms 101" with the deck "Sorting"', () => {
      expect(cloudSummary()).toEqual([['Algorithms 101', ['Sorting']]])
      expect(api.projects[0].decks[0].slideCount).toBe(5)
    })
    And('the browser no longer holds any project', () => {
      expect(guest.listProjects()).toEqual([])
    })
  })

  Scenario('A failed move keeps the browser projects', ({ Given, And, When, Then }) => {
    Given('a guest made the project "Algorithms 101" with the demo deck "Sorting" in this browser', guestProjectWithDemoDeck)
    And('the account cannot accept imports right now', () => {
      api.failImports = true
    })
    When('they sign in as Ana with a password', signInWithPassword)
    Then('the home page says the projects could not be moved yet', () => {
      expect(text('[data-testid="workspace-notice"] span')).toContain('could not be moved to your account yet')
    })
    And('the browser still holds "Algorithms 101"', () => {
      expect(guest.listProjects().map(project => project.name)).toEqual(['Algorithms 101'])
    })
  })

  Scenario('New projects go to the account', ({ Given, When, Then, And }) => {
    Given('Ana is signed in on the web app', signedIn)
    When('she creates the project "Graphs" and adds a deck from the demo template', async () => {
      await web.click('[data-testid="new-project"]')
      await web.fill('[data-testid="name-input"]', 'Graphs')
      await web.click('[data-testid="name-submit"]')
      await vi.waitFor(() => expect(web.router.currentRoute.value.name).toBe('project'))
      await web.click('[data-testid="new-deck"]')
      await web.click('[data-template="demo"]')
      await web.fill('[data-testid="name-input"]', 'Intro')
      await web.click('[data-testid="name-submit"]')
      await vi.waitFor(() => expect(web.router.currentRoute.value.name).toBe('deck'))
    })
    Then('the deck page shows 5 slides starting with "Deyslide"', async () => {
      await web.waitFor('[data-testid="slide-outline"]')
      const titles = findAll('[data-testid="slide-title"]').map(item => item.textContent?.trim())
      expect(titles).toHaveLength(5)
      expect(titles[0]).toBe('Deyslide')
    })
    And('Ana\'s account holds "Graphs" with 1 deck', () => {
      expect(cloudSummary()).toEqual([['Graphs', ['Intro']]])
    })
    And('the browser no longer holds any project', () => {
      expect(guest.listProjects()).toEqual([])
    })
  })

  Scenario('Signing out shows the browser\'s projects again', ({ Given, And, When, Then }) => {
    Given('Ana\'s account holds the project "Algorithms 101"', accountHoldsProject)
    And('Ana opens the web app signed in', signedIn)
    When('she signs out', async () => {
      const trigger = await web.waitFor('[data-testid="account-menu"]')
      trigger.focus()
      trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
      await web.settle()
      await web.click('[data-testid="sign-out"]')
    })
    Then('the home page says there are no projects yet', async () => {
      await vi.waitFor(() => expect(text('[data-testid="empty-projects"]')).toContain('No projects yet'))
    })
    And('the guest banner is back', () => {
      expect(find('[data-testid="guest-banner"]')).not.toBeNull()
    })
  })
})
