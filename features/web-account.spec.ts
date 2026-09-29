import type { WebApp } from './support/web'
import { describeFeature, loadFeature } from '@amiceli/vitest-cucumber'
import { expect, vi } from 'vitest'
import { FakeAccountService } from './support/account'
import { find, mountWebApp, pageText, text } from './support/web'

const feature = await loadFeature('./web-account.feature')

describeFeature(feature, ({ Scenario, AfterEachScenario }) => {
  let web: WebApp
  let service: FakeAccountService

  AfterEachScenario(() => web?.unmount())

  const open = async (path: string) => {
    service ??= new FakeAccountService()
    web = await mountWebApp({ path, service })
  }
  const fresh = () => {
    service = new FakeAccountService()
  }

  async function signInWith(email: string, password: string) {
    await web.fill('[data-testid="email"]', email)
    await web.fill('[data-testid="password"]', password)
    await web.submit('[data-testid="password-form"]')
  }

  async function expectHome() {
    await vi.waitFor(() => expect(web.router.currentRoute.value.name).toBe('home'))
  }

  Scenario('A guest is invited to sign up', ({ Given, Then, And }) => {
    Given('a guest opens the web app', async () => {
      fresh()
      await open('/')
    })
    Then('the header has a "Sign in" link', () => {
      expect(text('[data-testid="sign-in-link"]')).toBe('Sign in')
    })
    And('the banner has a "Sign up" link', () => {
      expect(text('[data-testid="sign-up-link"]')).toBe('Sign up')
    })
  })

  Scenario('Only configured sign in options are shown', ({ Given, When, Then, But }) => {
    Given('a server that offers email and GitHub but not Google', () => {
      service = new FakeAccountService({ email: true, google: false, github: true })
    })
    When('a guest opens "/sign-in"', async () => {
      await open('/sign-in')
      await web.waitFor('[data-testid="password-form"]')
    })
    Then('they see "Continue with GitHub" and the email form', () => {
      expect(text('[data-provider="github"]')).toBe('Continue with GitHub')
      expect(find('[data-testid="password-form"]')).not.toBeNull()
    })
    But('they do not see "Continue with Google"', () => {
      expect(find('[data-provider="google"]')).toBeNull()
    })
  })

  Scenario('Sign in with a password', ({ Given, And, When, Then }) => {
    Given('a confirmed account for "ana@example.com" with the password "correct horse"', () => {
      fresh()
      service.addAccount('ana@example.com', 'correct horse')
    })
    And('a guest opens "/sign-in"', () => open('/sign-in'))
    When('they sign in as "ana@example.com" with the password "correct horse"', () => signInWith('ana@example.com', 'correct horse'))
    Then('they are on the home page', expectHome)
    And('the header shows the account menu for "ana"', () => {
      expect(text('[data-testid="account-menu"]')).toBe('ana')
    })
  })

  Scenario('A wrong password shows a message', ({ Given, And, When, Then }) => {
    Given('a confirmed account for "ana@example.com" with the password "correct horse"', () => {
      fresh()
      service.addAccount('ana@example.com', 'correct horse')
    })
    And('a guest opens "/sign-in"', () => open('/sign-in'))
    When('they sign in as "ana@example.com" with the password "wrong horse"', () => signInWith('ana@example.com', 'wrong horse'))
    Then('the form says "The email or password is wrong."', () => {
      expect(text('[data-testid="password-form"] [role="alert"]')).toBe('The email or password is wrong.')
      expect(web.router.currentRoute.value.name).toBe('sign-in')
    })
  })

  Scenario('Ask for a magic link', ({ Given, When, Then }) => {
    Given('a guest opens "/sign-in"', async () => {
      fresh()
      await open('/sign-in')
    })
    When('they ask for a sign in link for "budi@example.com"', async () => {
      await web.click('[data-testid="use-magic-link"]')
      await web.fill('[data-testid="email"]', 'budi@example.com')
      await web.submit('[data-testid="magic-link-form"]')
    })
    Then('the page says to check "budi@example.com"', async () => {
      expect((await web.waitFor('[data-testid="link-sent"]')).textContent).toContain('Check budi@example.com')
      expect(service.calls).toContain('magic link budi@example.com')
    })
  })

  Scenario('Sign up asks to confirm the email', ({ Given, When, Then }) => {
    Given('a guest opens "/sign-up"', async () => {
      fresh()
      await open('/sign-up')
    })
    When('they sign up as "Citra" with "citra@example.com" and the password "correct horse"', async () => {
      await web.fill('[data-testid="name"]', 'Citra')
      await web.fill('[data-testid="email"]', 'citra@example.com')
      await web.fill('[data-testid="password"]', 'correct horse')
      await web.submit('[data-testid="sign-up-form"]')
    })
    Then('the page says to check "citra@example.com"', async () => {
      expect((await web.waitFor('[data-testid="confirm-sent"]')).textContent).toContain('Check citra@example.com')
      expect(service.calls).toContain('sign up citra@example.com')
    })
  })

  Scenario('Sign out', ({ Given, When, Then }) => {
    Given('"ana@example.com" is signed in', async () => {
      fresh()
      service.addAccount('ana@example.com', 'correct horse')
      await service.signIn({ email: 'ana@example.com', password: 'correct horse' })
      await open('/')
    })
    When('they sign out from the account menu', async () => {
      const trigger = await web.waitFor('[data-testid="account-menu"]')
      // Keyboard users open the menu with Enter, the same path a click takes.
      trigger.focus()
      trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
      await web.settle()
      await web.click('[data-testid="sign-out"]')
    })
    Then('the header has a "Sign in" link', async () => {
      await vi.waitFor(() => expect(text('[data-testid="sign-in-link"]')).toBe('Sign in'))
      expect(service.signedIn).toBeUndefined()
      expect(pageText()).toContain('Your work is saved in this browser only')
    })
  })

  Scenario('A signed in person skips the sign in page', ({ Given, When, Then }) => {
    Given('"ana@example.com" is signed in', async () => {
      fresh()
      service.addAccount('ana@example.com', 'correct horse')
      await service.signIn({ email: 'ana@example.com', password: 'correct horse' })
    })
    When('they open "/sign-in"', () => open('/sign-in'))
    Then('they are on the home page', expectHome)
  })
})
