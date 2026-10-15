import type { WebApp } from './support/web'
import { describeFeature, loadFeature } from '@amiceli/vitest-cucumber'
import { expect, vi } from 'vitest'
import * as Y from 'yjs'
import { browser } from '../apps/web/src/account/oauth'
import { MemoryGuestStorage } from '../apps/web/src/guest/memory-storage'
import { GuestStore } from '../apps/web/src/guest/store'
import { deckMarkdown, deckToYDoc, fromMarkdown, splitSlides } from '../packages/deck-model/src'
import { FakeAccountService } from './support/account'
import { resetEditorDoubles } from './support/editor-doubles'
import { FakeProjectApi } from './support/project-api'
import { find, mountWebApp, text } from './support/web'

const feature = await loadFeature('./web-mcp-connect.feature')

/** An authorization request the way Better Auth hands it to the sign in and consent pages. */
const REQUEST = {
  response_type: 'code',
  client_id: 'client-1',
  redirect_uri: 'http://localhost:33418/callback',
  code_challenge: 'challenge',
  code_challenge_method: 'S256',
  resource: 'http://deyslide.test/mcp',
}
const SIGNED = { ...REQUEST, exp: '1790668855', ba_iat: '1790668255993', ba_param: 'client_id', sig: 'signature' }
const CONTINUE_URL = `/api/auth/oauth2/authorize?${new URLSearchParams(REQUEST)}`

describeFeature(feature, ({ Scenario, BeforeEachScenario, AfterEachScenario }) => {
  let web: WebApp
  let service: FakeAccountService
  let api: FakeProjectApi
  let left: string[]
  let deckId: string

  BeforeEachScenario(() => {
    left = []
    vi.spyOn(browser, 'leave').mockImplementation((url) => {
      left.push(url)
    })
    service = new FakeAccountService()
    service.addAccount('ana@example.com', 'correct horse')
    api = new FakeProjectApi()
  })

  AfterEachScenario(() => {
    web?.unmount()
    resetEditorDoubles()
    vi.restoreAllMocks()
  })

  const editor = () => find('[data-testid="markdown-editor"]') as HTMLTextAreaElement

  async function signIn() {
    await service.signIn({ email: 'ana@example.com', password: 'correct horse' })
  }

  async function openSignIn() {
    web = await mountWebApp({ service, api, path: `/sign-in?${new URLSearchParams(SIGNED)}` })
  }

  async function openConsent(query: Record<string, string> = SIGNED) {
    web = await mountWebApp({ service, api, path: `/oauth/consent?${new URLSearchParams(query)}` })
    await web.settle()
  }

  function stateOf(markdown: string) {
    const doc = deckToYDoc(fromMarkdown(markdown))
    return Y.encodeStateAsUpdate(doc)
  }

  async function openDeck(markdown?: string) {
    await signIn()
    const project = await api.createProject('Talks')
    web = await mountWebApp({ service, api, guest: await GuestStore.open(new MemoryGuestStorage()), view: 'markdown' })
    deckId = (await web.workspace.store.value.createDeck(project.id, 'Graphs', 'blank')).id
    if (markdown)
      await api.saveDeckState(deckId, stateOf(markdown))
    await web.router.push({ name: 'deck', params: { projectId: project.id, deckId } })
    await vi.waitFor(() => expect(editor()).not.toBeNull())
    await web.settle()
  }

  const slideContents = (markdown: string) => splitSlides(markdown).map(slide => slide.content)

  async function accountSlides() {
    const doc = new Y.Doc()
    Y.applyUpdate(doc, await api.deckState(deckId))
    return slideContents(deckMarkdown(doc))
  }

  const leftForAuthorize = ({ Then }: { Then: (title: string, run: () => void) => void }) =>
    Then('the browser goes back to the authorization endpoint with the request and without its signature', () => {
      expect(left).toEqual([CONTINUE_URL])
    })

  Scenario('Signing in carries on with the app\'s request', ({ Given, When, Then }) => {
    Given('an app sent me to sign in with its request', openSignIn)
    When('I sign in with my email and password', async () => {
      expect(find('[data-testid="oauth-sign-in"]')).not.toBeNull()
      await web.fill('[data-testid="email"]', 'ana@example.com')
      await web.fill('[data-testid="password"]', 'correct horse')
      await web.submit('[data-testid="password-form"]')
    })
    leftForAuthorize({ Then })
  })

  Scenario('Social sign in carries the request too', ({ Given, When, Then }) => {
    Given('an app sent me to sign in with its request', openSignIn)
    When('I choose "Continue with Google"', () => web.click('[data-provider="google"]'))
    Then('Google sign in is asked to lead back to the authorization endpoint', () => {
      expect(service.calls).toContain(`social google then ${CONTINUE_URL}`)
    })
  })

  Scenario('Someone already signed in is passed on at once', ({ Given, When, Then }) => {
    Given('I am signed in', signIn)
    When('an app sends me to sign in with its request', openSignIn)
    leftForAuthorize({ Then })
  })

  Scenario('The consent page says who is asking and what it may do', ({ Given, And, Then }) => {
    Given('I am signed in', signIn)
    And('the app "Claude Code" asks to connect from localhost:33418', async () => {
      service.oauthClients.set('client-1', 'Claude Code')
      await openConsent()
    })
    Then('the consent page names "Claude Code" and my email', () => {
      expect(text('[data-testid="consent-app"]').replace(/\s+/g, ' ')).toBe('Claude Code wants to use your Deyslide account, ana@example.com.')
    })
    And('it lists what the app may do and that the answer goes to "localhost:33418"', () => {
      const permissions = [...find('[data-testid="consent-permissions"]')!.querySelectorAll('li')].map(item => item.textContent!.trim())
      expect(permissions).toEqual(['See your projects and decks, and those shared with you', 'Create projects and decks', 'Change the slides in decks you can edit'])
      expect(text('[data-testid="consent-host"]')).toContain('localhost:33418')
    })
  })

  Scenario('Allowing sends the browser back to the app', ({ Given, And, When, Then }) => {
    Given('I am signed in', signIn)
    And('the app "Claude Code" asks to connect from localhost:33418', async () => {
      service.oauthClients.set('client-1', 'Claude Code')
      await openConsent()
    })
    When('I press "Allow"', () => web.click('[data-testid="consent-allow"]'))
    Then('the browser goes to "http://localhost:33418/callback?code=fake-code"', () => {
      expect(left).toEqual(['http://localhost:33418/callback?code=fake-code'])
      expect(service.calls).toContain('allow client-1')
    })
  })

  Scenario('Denying tells the app no', ({ Given, And, When, Then }) => {
    Given('I am signed in', signIn)
    And('the app "Claude Code" asks to connect from localhost:33418', async () => {
      service.oauthClients.set('client-1', 'Claude Code')
      await openConsent()
    })
    When('I press "Deny"', () => web.click('[data-testid="consent-deny"]'))
    Then('the browser goes to "http://localhost:33418/callback?error=access_denied"', () => {
      expect(left).toEqual(['http://localhost:33418/callback?error=access_denied'])
    })
  })

  Scenario('The consent page without a request', ({ Given, When, Then }) => {
    Given('I am signed in', signIn)
    When('I open the consent page directly', () => openConsent({}))
    Then('it says to start again from the app', () => {
      expect(text('[data-testid="consent-invalid"]')).toBe('This page opens when an app asks to use your Deyslide account. Start again from the app.')
    })
  })

  Scenario('An open deck shows changes from Claude Code at once', ({ Given, When, Then, And }) => {
    Given('I am signed in with the blank deck "Graphs" open', () => openDeck())
    When('Claude Code saves a second slide to that deck', async () => {
      await api.saveDeckState(deckId, stateOf('# Graphs\n\n---\n\n# From Claude Code\n'))
    })
    Then('the editor holds the second slide', async () => {
      await vi.waitFor(() => expect(slideContents(editor().value)).toEqual(['# Graphs', '# From Claude Code']))
    })
    And('the page says "Saved"', () => {
      expect(text('[data-testid="save-status"]')).toBe('Saved')
    })
  })

  Scenario('Typing on one slide and a Claude Code edit to another slide both survive', ({ Given, And, When, Then }) => {
    Given('I am signed in with the deck "Graphs" open, its slides "# Graphs" and "# Second"', () => openDeck('# Graphs\n\n---\n\n# Second\n'))
    And('I typed "# Graphs, typed" on the first slide a moment ago', async () => {
      editor().value = editor().value.replace('# Graphs', '# Graphs, typed')
      editor().dispatchEvent(new Event('input'))
      await web.settle()
      // Typing merges a moment after the last key, so the account does not have it yet.
      expect(await accountSlides()).toEqual(['# Graphs', '# Second'])
    })
    When('Claude Code saves the deck with the second slide changed to "# Second, from Claude Code"', async () => {
      await api.saveDeckState(deckId, stateOf('# Graphs\n\n---\n\n# Second, from Claude Code\n'))
    })
    Then('the editor holds "# Graphs, typed" and "# Second, from Claude Code"', async () => {
      await vi.waitFor(() => expect(slideContents(editor().value)).toEqual(['# Graphs, typed', '# Second, from Claude Code']))
    })
    And('the account\'s deck holds both changes', async () => {
      await vi.waitFor(async () => expect(await accountSlides()).toEqual(['# Graphs, typed', '# Second, from Claude Code']))
    })
  })
})
