// @vitest-environment node
import type { Email } from '../apps/server/src/mailer'
import type { TestServer } from './support/server'
import { describeFeature, loadFeature } from '@amiceli/vitest-cucumber'
import { beforeAll, expect } from 'vitest'
import { createTestServer, DATABASE_WARM_UP_MS, MemoryMailer, TestBrowser, warmUpDatabase } from './support/server'

const feature = await loadFeature('./auth.feature')

beforeAll(warmUpDatabase, DATABASE_WARM_UP_MS)

describeFeature(feature, ({ Background, Scenario }) => {
  let server: TestServer
  let browser: TestBrowser
  let email: Email
  let response: Response

  const mailer = () => server.mailer!
  const nameOf = (address: string) => address.split('@')[0]

  async function signUp(address: string, password: string) {
    response = await browser.request('/api/auth/sign-up/email', { json: { email: address, password, name: nameOf(address) } })
    expect(response.status).toBe(200)
  }

  async function signIn(address: string, password: string) {
    response = await browser.request('/api/auth/sign-in/email', { json: { email: address, password } })
  }

  async function confirmedAccount(address: string, password: string) {
    await signUp(address, password)
    await new TestBrowser(server).request(MemoryMailer.link(mailer().last(address)))
  }

  async function errorCode(result: Response) {
    return (await result.json() as { code?: string }).code
  }

  Background(({ Given }) => {
    Given('the Deyslide API with email sending', async () => {
      server = await createTestServer()
      browser = new TestBrowser(server)
    })
  })

  Scenario('Sign up with email and password', ({ When, Then, And }) => {
    When('"ana@example.com" signs up with the password "correct horse"', () => signUp('ana@example.com', 'correct horse'))
    Then('a "Confirm your Deyslide email" email is sent to "ana@example.com"', () => {
      email = mailer().last('ana@example.com')
      expect(email.subject).toBe('Confirm your Deyslide email')
    })
    And('"ana@example.com" is not signed in yet', async () => {
      expect(await browser.signedInEmail()).toBeUndefined()
    })
    When('they open the link in that email', async () => {
      response = await browser.request(MemoryMailer.link(email))
      expect(response.status).toBe(302)
    })
    Then('they are signed in as "ana@example.com"', async () => {
      expect(await browser.signedInEmail()).toBe('ana@example.com')
    })
  })

  Scenario('Sign in before confirming the email', ({ Given, When, Then, And }) => {
    Given('"ana@example.com" signed up with the password "correct horse"', () => signUp('ana@example.com', 'correct horse'))
    When('they sign in with the password "correct horse"', () => signIn('ana@example.com', 'correct horse'))
    Then('sign in is refused because the email is not confirmed', async () => {
      expect(response.status).toBe(403)
      expect(await errorCode(response)).toBe('EMAIL_NOT_VERIFIED')
      expect(await browser.signedInEmail()).toBeUndefined()
    })
    And('a new "Confirm your Deyslide email" email is sent to "ana@example.com"', () => {
      const sent = mailer().sent.filter(item => item.to === 'ana@example.com' && item.subject === 'Confirm your Deyslide email')
      expect(sent).toHaveLength(2)
    })
  })

  Scenario('Sign in with a password', ({ Given, When, Then }) => {
    Given('a confirmed account for "ana@example.com" with the password "correct horse"', () => confirmedAccount('ana@example.com', 'correct horse'))
    When('they sign in with the password "correct horse"', () => signIn('ana@example.com', 'correct horse'))
    Then('they are signed in as "ana@example.com"', async () => {
      expect(response.status).toBe(200)
      expect(await browser.signedInEmail()).toBe('ana@example.com')
    })
  })

  Scenario('A wrong password is refused', ({ Given, When, Then }) => {
    Given('a confirmed account for "ana@example.com" with the password "correct horse"', () => confirmedAccount('ana@example.com', 'correct horse'))
    When('they sign in with the password "wrong horse"', () => signIn('ana@example.com', 'wrong horse'))
    Then('sign in is refused as invalid', async () => {
      expect(response.status).toBe(401)
      expect(await errorCode(response)).toBe('INVALID_EMAIL_OR_PASSWORD')
      expect(await browser.signedInEmail()).toBeUndefined()
    })
  })

  Scenario('Sign in with a magic link', ({ When, Then }) => {
    When('"budi@example.com" asks for a magic link', async () => {
      response = await browser.request('/api/auth/sign-in/magic-link', { json: { email: 'budi@example.com', callbackURL: '/' } })
      expect(response.status).toBe(200)
    })
    Then('a "Your Deyslide sign in link" email is sent to "budi@example.com"', () => {
      email = mailer().last('budi@example.com')
      expect(email.subject).toBe('Your Deyslide sign in link')
    })
    When('they open the link in that email', async () => {
      response = await browser.request(MemoryMailer.link(email))
      expect(response.status).toBe(302)
    })
    Then('they are signed in as "budi@example.com"', async () => {
      expect(await browser.signedInEmail()).toBe('budi@example.com')
    })
  })

  Scenario('Reset a forgotten password', ({ Given, When, Then, And }) => {
    Given('a confirmed account for "ana@example.com" with the password "correct horse"', () => confirmedAccount('ana@example.com', 'correct horse'))
    When('they ask to reset the password', async () => {
      response = await browser.request('/api/auth/request-password-reset', { json: { email: 'ana@example.com', redirectTo: '/reset-password' } })
      expect(response.status).toBe(200)
    })
    Then('a "Reset your Deyslide password" email is sent to "ana@example.com"', () => {
      email = mailer().last('ana@example.com')
      expect(email.subject).toBe('Reset your Deyslide password')
    })
    When('they choose the new password "battery staple" from that email', async () => {
      // The link lands on the web app's reset page with the token in the query.
      const landing = await browser.request(MemoryMailer.link(email))
      const token = new URL(landing.headers.get('location')!, 'http://x').searchParams.get('token')
      response = await browser.request('/api/auth/reset-password', { json: { newPassword: 'battery staple', token } })
      expect(response.status).toBe(200)
    })
    And('they sign in with the password "battery staple"', () => signIn('ana@example.com', 'battery staple'))
    Then('they are signed in as "ana@example.com"', async () => {
      expect(await browser.signedInEmail()).toBe('ana@example.com')
    })
  })

  Scenario('Sign out', ({ Given, And, When, Then }) => {
    Given('a confirmed account for "ana@example.com" with the password "correct horse"', () => confirmedAccount('ana@example.com', 'correct horse'))
    And('they sign in with the password "correct horse"', () => signIn('ana@example.com', 'correct horse'))
    When('they sign out', async () => {
      expect(await browser.signedInEmail()).toBe('ana@example.com')
      response = await browser.request('/api/auth/sign-out', { json: {} })
      expect(response.status).toBe(200)
    })
    Then('nobody is signed in', async () => {
      expect(await browser.signedInEmail()).toBeUndefined()
    })
  })
})
