import type { WebApp } from './support/web'
import { describeFeature, loadFeature } from '@amiceli/vitest-cucumber'
import { expect, vi } from 'vitest'
import { browser } from '../apps/web/src/account/oauth'
import { FakeAccountService } from './support/account'
import { resetEditorDoubles } from './support/editor-doubles'
import { find, mountWebApp, text } from './support/web'

const feature = await loadFeature('./app-auth-consent.feature')

const API = 'http://deyslide.test/api'
const MCP = 'http://deyslide.test/mcp'

/** An authorization request as Better Auth hands it to the consent page, signed. */
function signedRequest(resource: string, redirect: string) {
  return {
    response_type: 'code',
    client_id: 'client-1',
    redirect_uri: redirect,
    scope: 'openid profile email offline_access',
    code_challenge: 'challenge',
    code_challenge_method: 'S256',
    resource,
    exp: '1790668855',
    ba_iat: '1790668255993',
    ba_param: 'client_id',
    sig: 'signature',
  }
}

describeFeature(feature, ({ Scenario, BeforeEachScenario, AfterEachScenario }) => {
  let web: WebApp
  let service: FakeAccountService
  let left: string[]

  BeforeEachScenario(() => {
    left = []
    vi.spyOn(browser, 'leave').mockImplementation((url) => {
      left.push(url)
    })
    service = new FakeAccountService()
    service.addAccount('ana@example.com', 'correct horse')
  })

  AfterEachScenario(() => {
    web?.unmount()
    resetEditorDoubles()
    vi.restoreAllMocks()
  })

  async function signIn() {
    await service.signIn({ email: 'ana@example.com', password: 'correct horse' })
  }

  async function openConsent(name: string, resource: string, redirect: string) {
    service.oauthClients.set('client-1', name)
    web = await mountWebApp({ service, path: `/oauth/consent?${new URLSearchParams(signedRequest(resource, redirect))}` })
    await web.settle()
  }

  const permissions = () => [...find('[data-testid="consent-permissions"]')!.querySelectorAll('li')].map(item => item.textContent!.trim())
  const answerGoesTo = (destination: string) => expect(text('[data-testid="consent-host"]')).toContain(destination)

  Scenario('The consent page says the app gets the whole account', ({ Given, And, Then }) => {
    Given('I am signed in', signIn)
    And('the app "Deyslide app" asks for the API with the answer going to "http://127.0.0.1:49152/callback"', () =>
      openConsent('Deyslide app', API, 'http://127.0.0.1:49152/callback'))
    Then('the consent page names "Deyslide app" and my email', () => {
      expect(text('[data-testid="consent-app"]').replace(/\s+/g, ' ')).toBe('Deyslide app wants to use your Deyslide account, ana@example.com.')
    })
    And('it lists only "Full access to your Deyslide account, including deleting projects and decks and sharing them"', () => {
      expect(permissions()).toEqual(['Full access to your Deyslide account, including deleting projects and decks and sharing them'])
    })
    And('it does not claim the app cannot delete projects or decks', () => {
      expect(find('[data-testid="consent-limits"]')).toBeNull()
      expect(document.body.textContent).not.toContain('cannot delete')
    })
    And('it says the answer goes to "127.0.0.1:49152"', () => answerGoesTo('127.0.0.1:49152'))
  })

  Scenario('The phone app\'s own scheme is named in place of a host', ({ Given, And, Then, When }) => {
    Given('I am signed in', signIn)
    And('the app "Deyslide app" asks for the API with the answer going to "id.bambanggunawan.deyslide:/oauth/callback"', () =>
      openConsent('Deyslide app', API, 'id.bambanggunawan.deyslide:/oauth/callback'))
    Then('it says the answer goes to "the Deyslide app on this device"', () => {
      answerGoesTo('the Deyslide app on this device')
      expect(text('[data-testid="consent-host"]')).not.toContain('this computer')
    })
    When('I press "Allow"', () => web.click('[data-testid="consent-allow"]'))
    Then('the browser goes to "id.bambanggunawan.deyslide:/oauth/callback?code=fake-code"', () => {
      expect(left).toEqual(['id.bambanggunawan.deyslide:/oauth/callback?code=fake-code'])
      expect(service.calls).toContain('allow client-1')
    })
  })

  Scenario('Claude Code still sees the shorter list', ({ Given, And, Then }) => {
    Given('I am signed in', signIn)
    And('the app "Claude Code" asks for the MCP endpoint with the answer going to "http://localhost:33418/callback"', () =>
      openConsent('Claude Code', MCP, 'http://localhost:33418/callback'))
    Then('it lists "See your projects and decks, and those shared with you", "Create projects and decks" and "Change the slides in decks you can edit"', () => {
      expect(permissions()).toEqual(['See your projects and decks, and those shared with you', 'Create projects and decks', 'Change the slides in decks you can edit'])
    })
    And('it says the app cannot delete projects or decks', () => {
      expect(text('[data-testid="consent-limits"]')).toBe('It cannot delete projects or decks, and it reaches only what you can open in Deyslide.')
    })
    And('the list shows a bullet before each item', () => {
      // The style reset takes markers off every list: this puts them back.
      const list = find('[data-testid="consent-permissions"]')!
      expect([list.tagName, list.classList.contains('list-disc')]).toEqual(['UL', true])
    })
  })
})
