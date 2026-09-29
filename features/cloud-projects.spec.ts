// @vitest-environment node
import type { Project } from '../apps/server/src/projects'
import type { TestBrowser, TestServer } from './support/server'
import { describeFeature, loadFeature } from '@amiceli/vitest-cucumber'
import { beforeAll, expect } from 'vitest'
import { demoDeckState, slidesIn } from './support/deck-content'
import { createTestServer, DATABASE_WARM_UP_MS, TestBrowser as Browser, signedInBrowser, warmUpDatabase } from './support/server'

const feature = await loadFeature('./cloud-projects.feature')

beforeAll(warmUpDatabase, DATABASE_WARM_UP_MS)

interface BrowserProject {
  id: string
  name: string
  createdAt: number
  updatedAt: number
  decks: { id: string, name: string, createdAt: number, updatedAt: number, state: string }[]
}

describeFeature(feature, ({ Background, Scenario }) => {
  let server: TestServer
  let ana: TestBrowser
  let budi: TestBrowser
  let result: { status: number, body: any }
  let browserProject: BrowserProject

  const projectsOf = async (browser: TestBrowser) => (await browser.json<Project[]>('/api/projects')).body
  const summary = (projects: Project[]) => projects.map(project => [project.name, project.decks.length])

  async function createProject(browser: TestBrowser, name: string) {
    result = await browser.json<Project>('/api/projects', { json: { name } })
    expect(result.status).toBe(201)
    return result.body as Project
  }

  async function addDemoDeck(browser: TestBrowser, projectId: string, name: string) {
    result = await browser.json(`/api/projects/${projectId}/decks`, { json: { name, state: demoDeckState() } })
    return result
  }

  async function projectWithDeck() {
    const project = await createProject(ana, 'Algorithms 101')
    expect((await addDemoDeck(ana, project.id, 'Sorting')).status).toBe(201)
  }

  const onlyProject = async () => (await projectsOf(ana))[0]

  function browserProjectNamed(name: string, id = 'browser-project-1'): BrowserProject {
    return {
      id,
      name,
      createdAt: Date.UTC(2026, 8, 1),
      updatedAt: Date.UTC(2026, 8, 2),
      decks: [{ id: `${id}-deck`, name: 'Sorting', createdAt: Date.UTC(2026, 8, 1), updatedAt: Date.UTC(2026, 8, 2), state: demoDeckState() }],
    }
  }

  async function importInto(browser: TestBrowser, project: BrowserProject) {
    result = await browser.json('/api/import', { json: { projects: [project] } })
    expect(result.status).toBe(200)
  }

  Background(({ Given, And }) => {
    Given('the Deyslide API with email sending', async () => {
      server = await createTestServer()
    })
    And('Ana is signed in', async () => {
      ana = await signedInBrowser(server, 'ana@example.com')
    })
  })

  Scenario('Create a project', ({ When, Then }) => {
    When('Ana creates the project "Algorithms 101"', async () => {
      await createProject(ana, 'Algorithms 101')
    })
    Then('her projects are "Algorithms 101" with 0 decks', async () => {
      expect(summary(await projectsOf(ana))).toEqual([['Algorithms 101', 0]])
    })
  })

  Scenario('Add a deck and read it back', ({ Given, When, Then, And }) => {
    let projectId: string
    Given('Ana has the project "Algorithms 101"', async () => {
      projectId = (await createProject(ana, 'Algorithms 101')).id
    })
    When('she adds the deck "Sorting" made from the demo template', async () => {
      expect((await addDemoDeck(ana, projectId, 'Sorting')).status).toBe(201)
    })
    Then('the project lists the deck "Sorting" with 5 slides', async () => {
      expect((await onlyProject()).decks.map(deck => [deck.name, deck.slideCount])).toEqual([['Sorting', 5]])
    })
    And('downloading the deck gives the same 5 slides', async () => {
      const deckId = (await onlyProject()).decks[0].id
      const response = await ana.request(`/api/decks/${deckId}/state`)
      expect(response.headers.get('content-type')).toBe('application/octet-stream')
      expect(slidesIn(new Uint8Array(await response.arrayBuffer()))).toBe(5)
    })
  })

  Scenario('Rename and delete', ({ Given, When, And, Then }) => {
    Given('Ana has the project "Algorithms 101" with the deck "Sorting"', projectWithDeck)
    When('she renames the project to "Algorithms 102"', async () => {
      expect((await ana.json(`/api/projects/${(await onlyProject()).id}`, { method: 'PATCH', json: { name: 'Algorithms 102' } })).status).toBe(204)
    })
    And('she renames the deck to "Sorting basics"', async () => {
      expect((await ana.json(`/api/decks/${(await onlyProject()).decks[0].id}`, { method: 'PATCH', json: { name: 'Sorting basics' } })).status).toBe(204)
      expect((await onlyProject()).decks[0].name).toBe('Sorting basics')
    })
    Then('her projects are "Algorithms 102" with 1 deck', async () => {
      expect(summary(await projectsOf(ana))).toEqual([['Algorithms 102', 1]])
    })
    When('she deletes the deck', async () => {
      expect((await ana.json(`/api/decks/${(await onlyProject()).decks[0].id}`, { method: 'DELETE' })).status).toBe(204)
    })
    And('she deletes the project', async () => {
      expect((await ana.json(`/api/projects/${(await onlyProject()).id}`, { method: 'DELETE' })).status).toBe(204)
    })
    Then('she has no projects', async () => {
      expect(await projectsOf(ana)).toEqual([])
    })
  })

  Scenario('A deck must be a valid deck', ({ Given, When, Then }) => {
    let projectId: string
    Given('Ana has the project "Algorithms 101"', async () => {
      projectId = (await createProject(ana, 'Algorithms 101')).id
    })
    When('she adds a deck whose content is not a Yjs document', async () => {
      result = await ana.json(`/api/projects/${projectId}/decks`, { json: { name: 'Broken', state: Buffer.from('not a deck').toString('base64') } })
    })
    Then('it is refused with "The deck content is not a valid deck"', async () => {
      expect(result).toEqual({ status: 400, body: { error: 'The deck content is not a valid deck' } })
      expect((await onlyProject()).decks).toEqual([])
    })
  })

  Scenario('Other people cannot see or change it', ({ Given, And, Then }) => {
    Given('Ana has the project "Algorithms 101" with the deck "Sorting"', projectWithDeck)
    And('Budi is signed in on another browser', async () => {
      budi = await signedInBrowser(server, 'budi@example.com')
    })
    Then('Budi has no projects', async () => {
      expect(await projectsOf(budi)).toEqual([])
    })
    And('Budi cannot rename, delete or download Ana\'s project and deck', async () => {
      const project = await onlyProject()
      const deckId = project.decks[0].id
      const attempts = await Promise.all([
        budi.json(`/api/projects/${project.id}`, { method: 'PATCH', json: { name: 'Taken' } }),
        budi.json(`/api/projects/${project.id}`, { method: 'DELETE' }),
        budi.json(`/api/projects/${project.id}/decks`, { json: { name: 'Extra', state: demoDeckState() } }),
        budi.json(`/api/decks/${deckId}`, { method: 'PATCH', json: { name: 'Taken' } }),
        budi.json(`/api/decks/${deckId}`, { method: 'DELETE' }),
        budi.json(`/api/decks/${deckId}/state`),
      ])
      expect(attempts.map(attempt => attempt.status)).toEqual([404, 404, 404, 404, 404, 404])
      expect(summary(await projectsOf(ana))).toEqual([['Algorithms 101', 1]])
    })
  })

  Scenario('Guests cannot use the API', ({ Given, Then }) => {
    let guest: TestBrowser
    Given('a guest who is not signed in', () => {
      guest = new Browser(server)
    })
    Then('listing projects is refused as not signed in', async () => {
      expect(await guest.json('/api/projects')).toEqual({ status: 401, body: { error: 'Sign in first' } })
    })
  })

  Scenario('Move browser projects into the account', ({ Given, When, Then, And }) => {
    Given('a browser with the project "Algorithms 101" holding the demo deck "Sorting"', () => {
      browserProject = browserProjectNamed('Algorithms 101')
    })
    When('Ana imports it into her account', () => importInto(ana, browserProject))
    Then('her projects are "Algorithms 101" with 1 deck', async () => {
      expect(result.body).toEqual({ imported: 1 })
      const project = await onlyProject()
      expect(summary([project])).toEqual([['Algorithms 101', 1]])
      expect([project.id, project.createdAt, project.updatedAt]).toEqual([browserProject.id, browserProject.createdAt, browserProject.updatedAt])
    })
    And('the imported deck has 5 slides', async () => {
      expect((await onlyProject()).decks[0].slideCount).toBe(5)
    })
  })

  Scenario('Importing twice does not duplicate', ({ Given, When, And, Then }) => {
    Given('a browser with the project "Algorithms 101" holding the demo deck "Sorting"', () => {
      browserProject = browserProjectNamed('Algorithms 101')
    })
    When('Ana imports it into her account', () => importInto(ana, browserProject))
    And('Ana imports it into her account again', () => importInto(ana, browserProject))
    Then('her projects are "Algorithms 101" with 1 deck', async () => {
      expect(result.body).toEqual({ imported: 0 })
      expect(summary(await projectsOf(ana))).toEqual([['Algorithms 101', 1]])
    })
  })

  Scenario('An import cannot take over someone else\'s project', ({ Given, When, Then, And }) => {
    Given('Budi imported a browser project with the id "shared-id"', async () => {
      budi = await signedInBrowser(server, 'budi@example.com')
      await importInto(budi, browserProjectNamed('Budi\'s', 'shared-id'))
    })
    When('Ana imports a browser project with the same id "shared-id" named "Mine"', () => importInto(ana, browserProjectNamed('Mine', 'shared-id')))
    Then('Ana\'s project "Mine" gets a new id', async () => {
      const project = await onlyProject()
      expect(project.name).toBe('Mine')
      expect(project.id).not.toBe('shared-id')
      expect(project.decks[0].id).not.toBe('shared-id-deck')
    })
    And('Budi\'s project keeps the id "shared-id"', async () => {
      const [project] = await projectsOf(budi)
      expect([project.id, project.name, project.decks[0].id]).toEqual(['shared-id', 'Budi\'s', 'shared-id-deck'])
    })
  })
})
