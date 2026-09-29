import type { SharedRole } from '../apps/web/src/guest/types'
import type { WebApp } from './support/web'
import { describeFeature, loadFeature } from '@amiceli/vitest-cucumber'
import { expect, vi } from 'vitest'
import * as Y from 'yjs'
import { MemoryGuestStorage } from '../apps/web/src/guest/memory-storage'
import { GuestStore } from '../apps/web/src/guest/store'
import { deckToYDoc, fromMarkdown } from '../packages/deck-model/src'
import { FakeAccountService } from './support/account'
import { resetEditorDoubles } from './support/editor-doubles'
import { FakeProjectApi } from './support/project-api'
import { find, findAll, mountWebApp, text } from './support/web'

const feature = await loadFeature('./web-sharing.feature')

const ANA = { name: 'ana', email: 'ana@example.com' }
const BUDI = { name: 'Budi', email: 'budi@example.com' }

describeFeature(feature, ({ Scenario, AfterEachScenario }) => {
  let web: WebApp
  let service: FakeAccountService
  let api: FakeProjectApi
  let projectId: string

  AfterEachScenario(() => {
    web?.unmount()
    resetEditorDoubles()
  })

  const buttonsText = () => findAll('button').map(button => button.textContent!.trim())
  const editor = () => find('[data-testid="markdown-editor"]') as HTMLTextAreaElement

  async function signInAna() {
    service = new FakeAccountService()
    service.addAccount(ANA.email, 'correct horse')
    await service.signIn({ email: ANA.email, password: 'correct horse' })
    api = new FakeProjectApi()
  }

  async function mount(path = '/') {
    web = await mountWebApp({ service, api, path, guest: await GuestStore.open(new MemoryGuestStorage()) })
  }

  async function sharedByBudi(role: SharedRole) {
    await signInAna()
    projectId = 'shared-project'
    const now = Date.now()
    api.sharedProjects.push({
      id: projectId,
      name: 'Algorithms 101',
      createdAt: now,
      updatedAt: now,
      shared: { owner: BUDI, role },
      decks: [{ id: 'shared-deck', name: 'Sorting', slideCount: 1, createdAt: now, updatedAt: now, role }],
    })
    api.putDeckState('shared-deck', Y.encodeStateAsUpdate(deckToYDoc(fromMarkdown('# Sorting\n'))))
    api.shareLists.set(projectId, { owner: BUDI, role, members: [{ userId: 'user-ana', ...ANA, role }], invites: [] })
  }

  async function ownProject(sharedWithBudi?: SharedRole) {
    await signInAna()
    projectId = (await api.createProject('Talks')).id
    api.shareLists.set(projectId, {
      owner: ANA,
      role: 'owner',
      members: sharedWithBudi ? [{ userId: 'user-budi', ...BUDI, role: sharedWithBudi }] : [],
      invites: [],
    })
    await mount(`/p/${projectId}`)
    await web.click('[data-testid="share-project"]')
    await vi.waitFor(() => expect(find('[data-testid="share-owner"]')).not.toBeNull())
  }

  async function shareWith(email: string, role: SharedRole) {
    await web.fill('[data-testid="share-email"]', email)
    const select = find('[data-testid="share-role"]') as HTMLSelectElement
    select.value = role
    select.dispatchEvent(new Event('change'))
    await web.submit('[data-testid="share-form"]')
  }

  const roleOf = (email: string) => (find(`[data-member="${email}"] select`) as HTMLSelectElement | null)?.value

  const sharedGiven = (role: SharedRole) => () => sharedByBudi(role)

  Scenario('Shared projects appear on the home page', ({ Given, When, Then }) => {
    Given('Ana is signed in and Budi shared the project "Algorithms 101" with Ana as a viewer', sharedGiven('viewer'))
    When('Ana opens the home page', () => mount('/'))
    Then('"Shared with you" lists "Algorithms 101" by Budi as view only', () => {
      expect(text('[data-shared-project="Algorithms 101"]').replace(/\s+/g, ' ')).toMatch(/^Algorithms 101\s*Budi · view only · changed/)
    })
  })

  Scenario('A viewer only opens decks', ({ Given, When, Then, And }) => {
    Given('Ana is signed in and Budi shared the project "Algorithms 101" with Ana as a viewer', sharedGiven('viewer'))
    When('Ana opens the project "Algorithms 101"', () => mount(`/p/${projectId}`))
    Then('the page says it is shared by Budi and Ana is a viewer', () => {
      expect(text('[data-testid="shared-by"]').replace(/\s+/g, ' ')).toBe('Shared by Budi. You are a viewer.')
    })
    And('there is no Rename, Delete or New deck button', () => {
      expect(buttonsText()).not.toContain('Rename')
      expect(buttonsText()).not.toContain('Delete')
      expect(find('[data-testid="new-deck"]')).toBeNull()
    })
    And('the deck "Sorting" is marked "View only"', () => {
      expect(text('[data-deck-role="Sorting"]')).toBe('View only')
    })
  })

  Scenario('An editor adds and renames but does not delete', ({ Given, When, Then }) => {
    Given('Ana is signed in and Budi shared the project "Algorithms 101" with Ana as an editor', sharedGiven('editor'))
    When('Ana opens the project "Algorithms 101"', () => mount(`/p/${projectId}`))
    Then('there are Rename and New deck buttons but no Delete button', () => {
      expect(buttonsText()).toContain('Rename')
      expect(find('[data-testid="new-deck"]')).not.toBeNull()
      expect(buttonsText()).not.toContain('Delete')
      expect(text('[data-deck-role="Sorting"]')).toBe('Can edit')
    })
  })

  Scenario('A viewer reads a deck without changing it', ({ Given, When, Then, And }) => {
    Given('Ana is signed in and Budi shared the project "Algorithms 101" with Ana as a viewer', sharedGiven('viewer'))
    When('Ana opens the deck "Sorting"', async () => {
      await mount(`/p/${projectId}/d/shared-deck`)
      await vi.waitFor(() => expect(editor()).not.toBeNull())
    })
    Then('the deck page says "View only"', () => {
      expect(text('[data-testid="view-only"]')).toBe('View only')
      expect(find('[data-testid="save-status"]')).toBeNull()
    })
    And('the editor is read only', () => {
      expect(editor().readOnly).toBe(true)
      expect(editor().value).toContain('# Sorting')
    })
    And('there is no assistant and no Share button', () => {
      expect(find('[data-testid="assistant"]')).toBeNull()
      expect(find('[data-testid="share-deck"]')).toBeNull()
    })
  })

  Scenario('Share a project from its page', ({ Given, And, When, Then }) => {
    Given('Ana is signed in with the project "Talks"', () => ownProject())
    And('Budi has an account', () => {
      api.accounts.set(BUDI.email, BUDI.name)
    })
    When('Ana shares the project with "budi@example.com" as an editor and with "citra@example.com" as a viewer', async () => {
      await shareWith(BUDI.email, 'editor')
      await shareWith('citra@example.com', 'viewer')
    })
    Then('the share list shows Budi as an editor and "citra@example.com" as an invited viewer', () => {
      expect(roleOf(BUDI.email)).toBe('editor')
      expect(text('[data-invite="citra@example.com"]').replace(/\s+/g, ' ')).toContain('citra@example.com invited')
      expect((find('[data-invite="citra@example.com"] select') as HTMLSelectElement).value).toBe('viewer')
    })
  })

  Scenario('The owner changes a role and removes someone', ({ Given, When, Then }) => {
    Given('Ana is signed in with the project "Talks" shared with Budi as a viewer', () => ownProject('viewer'))
    When('Ana makes Budi an editor', async () => {
      const select = find(`[data-member="${BUDI.email}"] select`) as HTMLSelectElement
      select.value = 'editor'
      select.dispatchEvent(new Event('change'))
      await web.settle()
    })
    Then('the share list shows Budi as an editor', async () => {
      await vi.waitFor(() => expect(roleOf(BUDI.email)).toBe('editor'))
    })
    When('Ana removes Budi', () => web.click(`[data-member="${BUDI.email}"] [data-testid="remove-member"]`))
    Then('the share list shows only Ana', async () => {
      await vi.waitFor(() => expect(find(`[data-member="${BUDI.email}"]`)).toBeNull())
      expect(text('[data-testid="share-owner"]')).toContain('ana@example.com')
    })
  })

  Scenario('Leave a shared project', ({ Given, When, Then }) => {
    Given('Ana is signed in and Budi shared the project "Algorithms 101" with Ana as a viewer', sharedGiven('viewer'))
    When('Ana leaves the project from its share list', async () => {
      await mount(`/p/${projectId}`)
      await web.click('[data-testid="share-project"]')
      await web.click('[data-testid="leave"]')
    })
    Then('Ana is back on the home page and nothing is shared with Ana', async () => {
      await vi.waitFor(() => expect(web.router.currentRoute.value.name).toBe('home'))
      expect(find('[data-testid="shared-list"]')).toBeNull()
    })
  })

  Scenario('A refused share says why', ({ Given, When, Then }) => {
    Given('Ana is signed in with the project "Talks" shared with Budi as a viewer', () => ownProject('viewer'))
    When('Ana shares the project with "budi@example.com" as an editor', () => shareWith(BUDI.email, 'editor'))
    Then('the share dialog says "budi@example.com already has access. Change the role in the list instead."', () => {
      expect(text('[data-testid="share-error"]')).toBe('budi@example.com already has access. Change the role in the list instead.')
    })
  })

  Scenario('Guests have nothing to share', ({ Given, When, Then }) => {
    let guest: GuestStore
    Given('a guest with the project "Talks" in the browser', async () => {
      guest = await GuestStore.open(new MemoryGuestStorage())
      projectId = (await guest.createProject('Talks')).id
    })
    When('the guest opens the project "Talks"', async () => {
      web = await mountWebApp({ guest, path: `/p/${projectId}` })
    })
    Then('there is no Share button', () => {
      expect(find('[data-testid="project-name"]')).not.toBeNull()
      expect(find('[data-testid="share-project"]')).toBeNull()
    })
  })
})
