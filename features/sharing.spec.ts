// @vitest-environment node
import type { Project, SharedProject } from '../apps/server/src/projects'
import type { ShareList } from '../apps/server/src/sharing'
import type { TestBrowser, TestServer } from './support/server'
import { describeFeature, loadFeature } from '@amiceli/vitest-cucumber'
import { beforeAll, expect } from 'vitest'
import { blankDeckState, demoDeckState } from './support/deck-content'
import { createTestServer, DATABASE_WARM_UP_MS, signedInBrowser, warmUpDatabase } from './support/server'

const feature = await loadFeature('./sharing.feature')

beforeAll(warmUpDatabase, DATABASE_WARM_UP_MS)

describeFeature(feature, ({ Background, Scenario, ScenarioOutline }) => {
  let server: TestServer
  let ana: TestBrowser
  let budi: TestBrowser
  let projectId: string
  let decks: Record<string, string>
  let result: { status: number, body: any }

  const ROLE: Record<string, string> = { 'a viewer': 'viewer', 'an editor': 'editor', 'an owner': 'owner' }

  async function share(browser: TestBrowser, email: string, role: string, target = `/api/projects/${projectId}`) {
    result = await browser.json<ShareList>(`${target}/sharing`, { json: { email, role } })
  }

  async function shareOk(browser: TestBrowser, email: string, role: string, target?: string) {
    await share(browser, email, role, target)
    expect(result.status, JSON.stringify(result.body)).toBe(201)
  }

  const sharedWith = async (browser: TestBrowser) => (await browser.json<SharedProject[]>('/api/shared')).body
  const listOf = async (browser: TestBrowser) => (await browser.json<ShareList>(`/api/projects/${projectId}/sharing`)).body
  const status = async (browser: TestBrowser, path: string, init: { method?: string, json?: unknown } = {}) => (await browser.request(path, init)).status
  const download = (browser: TestBrowser, deck: string) => status(browser, `/api/decks/${decks[deck]}/state`)
  const emailTo = (address: string) => server.mailer!.sent.filter(email => email.to === address).map(email => email.subject)
  const userIdOf = async (email: string) => (await listOf(ana)).members.find(member => member.email === email)!.userId

  Background(({ Given, And }) => {
    Given('the Deyslide API with email sending', async () => {
      server = await createTestServer()
    })
    And('Ana owns the project "Algorithms 101" with the decks "Sorting" and "Graphs"', async () => {
      ana = await signedInBrowser(server, 'ana@example.com', 'Ana')
      projectId = (await ana.json<Project>('/api/projects', { json: { name: 'Algorithms 101' } })).body.id
      decks = {}
      for (const name of ['Sorting', 'Graphs'])
        decks[name] = (await ana.json<{ id: string }>(`/api/projects/${projectId}/decks`, { json: { name, state: demoDeckState() } })).body.id
    })
    And('Budi has an account', async () => {
      budi = await signedInBrowser(server, 'budi@example.com', 'Budi')
    })
  })

  Scenario('Share a project with a viewer', ({ When, Then, And, But }) => {
    When('Ana shares the project with "budi@example.com" as a viewer', () => shareOk(ana, 'budi@example.com', 'viewer'))
    Then('Budi gets an email "Ana shared Algorithms 101 with you"', () => {
      expect(emailTo('budi@example.com')).toContain('Ana shared Algorithms 101 with you')
    })
    And('Budi sees "Algorithms 101" shared by Ana as a viewer, with 2 decks', async () => {
      const [shared] = await sharedWith(budi)
      expect(shared).toMatchObject({ name: 'Algorithms 101', owner: { name: 'Ana', email: 'ana@example.com' }, role: 'viewer' })
      expect(shared.decks.map(deck => [deck.name, deck.role])).toEqual([['Sorting', 'viewer'], ['Graphs', 'viewer']])
      expect((await budi.json<Project[]>('/api/projects')).body).toEqual([])
    })
    And('Budi can download the deck "Sorting"', async () => {
      expect(await download(budi, 'Sorting')).toBe(200)
    })
    But('Budi cannot rename the project, add a deck, rename a deck or save a deck', async () => {
      expect(await status(budi, `/api/projects/${projectId}`, { method: 'PATCH', json: { name: 'Mine' } })).toBe(403)
      expect(await status(budi, `/api/projects/${projectId}/decks`, { json: { name: 'Trees', state: blankDeckState('Trees') } })).toBe(403)
      expect(await status(budi, `/api/decks/${decks.Sorting}`, { method: 'PATCH', json: { name: 'Mine' } })).toBe(403)
      result = await budi.json(`/api/decks/${decks.Sorting}/state`, { method: 'PUT', json: { state: blankDeckState('Mine') } })
      expect(result).toEqual({ status: 403, body: { error: 'You can view this deck but not change it.' } })
    })
  })

  Scenario('An editor adds, renames and saves, but does not delete', ({ When, Then, But }) => {
    When('Ana shares the project with "budi@example.com" as an editor', () => shareOk(ana, 'budi@example.com', 'editor'))
    Then('Budi can add the deck "Trees", rename the project to "Algorithms 102" and save the deck "Sorting"', async () => {
      expect(await status(budi, `/api/projects/${projectId}/decks`, { json: { name: 'Trees', state: blankDeckState('Trees') } })).toBe(201)
      expect(await status(budi, `/api/projects/${projectId}`, { method: 'PATCH', json: { name: 'Algorithms 102' } })).toBe(204)
      expect(await status(budi, `/api/decks/${decks.Sorting}/state`, { method: 'PUT', json: { state: blankDeckState('Sorting') } })).toBe(204)
      const [project] = (await ana.json<Project[]>('/api/projects')).body
      expect(project.name).toBe('Algorithms 102')
      expect(project.decks.map(deck => [deck.name, deck.slideCount])).toEqual([['Sorting', 1], ['Graphs', 5], ['Trees', 1]])
    })
    But('Budi cannot delete the project or the deck "Sorting"', async () => {
      result = await budi.json(`/api/projects/${projectId}`, { method: 'DELETE' })
      expect(result).toEqual({ status: 403, body: { error: 'Only the owner can delete this project.' } })
      result = await budi.json(`/api/decks/${decks.Sorting}`, { method: 'DELETE' })
      expect(result).toEqual({ status: 403, body: { error: 'Only the owner can delete this deck.' } })
    })
  })

  Scenario('Share a single deck', ({ When, Then, And, But }) => {
    When('Ana shares the deck "Sorting" with "budi@example.com" as a viewer', () => shareOk(ana, 'budi@example.com', 'viewer', `/api/decks/${decks.Sorting}`))
    Then('Budi gets an email "Ana shared Sorting with you"', () => {
      expect(emailTo('budi@example.com')).toContain('Ana shared Sorting with you')
    })
    And('Budi sees only the deck "Sorting" from "Algorithms 101", shared by Ana', async () => {
      const [shared] = await sharedWith(budi)
      expect(shared).toMatchObject({ name: 'Algorithms 101', owner: { name: 'Ana' }, role: null })
      expect(shared.decks.map(deck => [deck.name, deck.role])).toEqual([['Sorting', 'viewer']])
    })
    And('Budi can download the deck "Sorting"', async () => {
      expect(await download(budi, 'Sorting')).toBe(200)
    })
    But('Budi cannot download the deck "Graphs" or rename the project', async () => {
      expect(await download(budi, 'Graphs')).toBe(404)
      expect(await status(budi, `/api/projects/${projectId}`, { method: 'PATCH', json: { name: 'Mine' } })).toBe(404)
    })
  })

  Scenario('A deck uses the higher of its own role and its project\'s role', ({ Given, When, Then, But }) => {
    Given('Ana shared the project with "budi@example.com" as a viewer', () => shareOk(ana, 'budi@example.com', 'viewer'))
    When('Ana shares the deck "Sorting" with "budi@example.com" as an editor', () => shareOk(ana, 'budi@example.com', 'editor', `/api/decks/${decks.Sorting}`))
    Then('Budi can rename the deck "Sorting"', async () => {
      expect(await status(budi, `/api/decks/${decks.Sorting}`, { method: 'PATCH', json: { name: 'Sorting 2' } })).toBe(204)
      const [shared] = await sharedWith(budi)
      expect(shared.decks.map(deck => [deck.name, deck.role])).toEqual([['Sorting 2', 'editor'], ['Graphs', 'viewer']])
    })
    But('Budi cannot rename the deck "Graphs"', async () => {
      expect(await status(budi, `/api/decks/${decks.Graphs}`, { method: 'PATCH', json: { name: 'Mine' } })).toBe(403)
    })
  })

  Scenario('Invite someone without an account', ({ When, Then, And }) => {
    let citra: TestBrowser
    When('Ana shares the project with "citra@example.com" as an editor', () => shareOk(ana, 'citra@example.com', 'editor'))
    Then('Citra gets an email "Ana invited you to Algorithms 101 on Deyslide"', () => {
      expect(emailTo('citra@example.com')).toEqual(['Ana invited you to Algorithms 101 on Deyslide'])
    })
    And('the project lists "citra@example.com" as an invited editor', async () => {
      expect((await listOf(ana)).invites).toEqual([{ id: expect.any(String), email: 'citra@example.com', role: 'editor' }])
    })
    When('Citra signs up with "citra@example.com" and confirms the address', async () => {
      citra = await signedInBrowser(server, 'citra@example.com', 'Citra')
    })
    Then('Citra sees "Algorithms 101" shared by Ana as an editor, with 2 decks', async () => {
      const [shared] = await sharedWith(citra)
      expect(shared).toMatchObject({ name: 'Algorithms 101', owner: { name: 'Ana' }, role: 'editor' })
      expect(shared.decks).toHaveLength(2)
    })
    And('the project lists "citra@example.com" as an editor', async () => {
      const list = await listOf(ana)
      expect(list.invites).toEqual([])
      expect(list.members.map(member => [member.email, member.role])).toEqual([['citra@example.com', 'editor']])
    })
  })

  Scenario('Editors invite, but only the owner changes roles and removes people', ({ Given, When, Then, But, And }) => {
    let inviteId: string
    Given('Ana shared the project with "budi@example.com" as an editor', () => shareOk(ana, 'budi@example.com', 'editor'))
    When('Budi shares the project with "citra@example.com" as a viewer', () => shareOk(budi, 'citra@example.com', 'viewer'))
    Then('the project lists "citra@example.com" as an invited viewer', async () => {
      const [invite] = (await listOf(budi)).invites
      expect(invite).toMatchObject({ email: 'citra@example.com', role: 'viewer' })
      inviteId = invite.id
    })
    But('Budi cannot make "citra@example.com" an editor or remove that invite', async () => {
      result = await budi.json(`/api/projects/${projectId}/sharing/invites/${inviteId}`, { method: 'PATCH', json: { role: 'editor' } })
      expect(result).toEqual({ status: 403, body: { error: 'Only the owner can change roles.' } })
      result = await budi.json(`/api/projects/${projectId}/sharing/invites/${inviteId}`, { method: 'DELETE' })
      expect(result).toEqual({ status: 403, body: { error: 'Only the owner can remove people.' } })
    })
    And('Ana can make "citra@example.com" an editor', async () => {
      expect(await status(ana, `/api/projects/${projectId}/sharing/invites/${inviteId}`, { method: 'PATCH', json: { role: 'editor' } })).toBe(204)
      expect((await listOf(ana)).invites[0].role).toBe('editor')
    })
  })

  Scenario('Viewers cannot share', ({ Given, When, Then }) => {
    Given('Ana shared the project with "budi@example.com" as a viewer', () => shareOk(ana, 'budi@example.com', 'viewer'))
    When('Budi shares the project with "citra@example.com" as a viewer', () => share(budi, 'citra@example.com', 'viewer'))
    Then('sharing is refused with "Only the owner and editors can share"', () => {
      expect(result).toEqual({ status: 403, body: { error: 'Only the owner and editors can share.' } })
    })
  })

  Scenario('The owner removes someone', ({ Given, When, Then, And }) => {
    Given('Ana shared the project with "budi@example.com" as an editor', () => shareOk(ana, 'budi@example.com', 'editor'))
    When('Ana removes "budi@example.com" from the project', async () => {
      expect(await status(ana, `/api/projects/${projectId}/sharing/members/${await userIdOf('budi@example.com')}`, { method: 'DELETE' })).toBe(204)
    })
    Then('Budi has nothing shared', async () => {
      expect(await sharedWith(budi)).toEqual([])
    })
    And('Budi cannot download the deck "Sorting"', async () => {
      expect(await download(budi, 'Sorting')).toBe(404)
    })
  })

  Scenario('Leave a shared project', ({ Given, When, Then, And }) => {
    Given('Ana shared the project with "budi@example.com" as a viewer', () => shareOk(ana, 'budi@example.com', 'viewer'))
    When('Budi leaves the project', async () => {
      const budiId = (await listOf(budi)).members[0].userId
      expect(await status(budi, `/api/projects/${projectId}/sharing/members/${budiId}`, { method: 'DELETE' })).toBe(204)
    })
    Then('Budi has nothing shared', async () => {
      expect(await sharedWith(budi)).toEqual([])
    })
    And('the project lists nobody but Ana', async () => {
      const list = await listOf(ana)
      expect(list).toEqual({ owner: { name: 'Ana', email: 'ana@example.com' }, role: 'owner', members: [], invites: [] })
    })
  })

  Scenario('Deleting a project ends its sharing', ({ Given, And, When, Then }) => {
    Given('Ana shared the project with "budi@example.com" as a viewer', () => shareOk(ana, 'budi@example.com', 'viewer'))
    And('Ana shared the project with "citra@example.com" as a viewer', () => shareOk(ana, 'citra@example.com', 'viewer'))
    When('Ana deletes the project', async () => {
      expect(await status(ana, `/api/projects/${projectId}`, { method: 'DELETE' })).toBe(204)
    })
    Then('Budi has nothing shared', async () => {
      expect(await sharedWith(budi)).toEqual([])
    })
    And('Citra has nothing shared after signing up with "citra@example.com"', async () => {
      expect(await sharedWith(await signedInBrowser(server, 'citra@example.com', 'Citra'))).toEqual([])
    })
  })

  Scenario('Strangers see nothing', ({ Given, Then }) => {
    let dewi: TestBrowser
    Given('Dewi has an account', async () => {
      dewi = await signedInBrowser(server, 'dewi@example.com', 'Dewi')
    })
    Then('Dewi cannot list the project\'s members, download the deck "Sorting" or share the project', async () => {
      expect(await status(dewi, `/api/projects/${projectId}/sharing`)).toBe(404)
      expect(await download(dewi, 'Sorting')).toBe(404)
      await share(dewi, 'dewi2@example.com', 'viewer')
      expect(result.status).toBe(404)
      expect(emailTo('dewi2@example.com')).toEqual([])
    })
  })

  ScenarioOutline('Sharing is checked', ({ When, Then }, variables) => {
    When('Ana shares the project with "<email>" as <role>', () => share(ana, variables.email, ROLE[variables.role]))
    Then('sharing is refused with "<message>"', () => {
      expect(result.status).toBe(400)
      expect(result.body.error.replace(/\.$/, '')).toBe(variables.message)
    })
  })

  Scenario('Sharing twice with the same person is refused', ({ Given, When, Then }) => {
    Given('Ana shared the project with "budi@example.com" as a viewer', () => shareOk(ana, 'budi@example.com', 'viewer'))
    When('Ana shares the project with "budi@example.com" as an editor', () => share(ana, 'budi@example.com', 'editor'))
    Then('sharing is refused with "budi@example.com already has access. Change the role in the list instead."', () => {
      expect(result).toEqual({ status: 400, body: { error: 'budi@example.com already has access. Change the role in the list instead.' } })
    })
  })
})
