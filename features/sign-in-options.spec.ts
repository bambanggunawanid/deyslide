// @vitest-environment node
import type { PublicConfig } from '../apps/server/src/app'
import type { TestServer } from './support/server'
import { describeFeature, loadFeature } from '@amiceli/vitest-cucumber'
import { beforeAll, expect, vi } from 'vitest'
import { readConfig } from '../apps/server/src/config'
import { CloudflareMailer } from '../apps/server/src/mailer'
import { magicLinkEmail } from '../apps/server/src/emails'
import { createTestServer, DATABASE_WARM_UP_MS, TestBrowser, warmUpDatabase } from './support/server'

const feature = await loadFeature('./sign-in-options.feature')

const OAUTH_ENV: Record<string, Record<string, string>> = {
  'no OAuth apps': {},
  'a Google OAuth app': { GOOGLE_CLIENT_ID: 'google-id', GOOGLE_CLIENT_SECRET: 'google-secret' },
  'Google and GitHub apps': {
    GOOGLE_CLIENT_ID: 'google-id',
    GOOGLE_CLIENT_SECRET: 'google-secret',
    GH_OAUTH_CLIENT_ID: 'github-id',
    GH_OAUTH_CLIENT_SECRET: 'github-secret',
  },
}

const onOff = (value: boolean) => value ? 'on' : 'off'

beforeAll(warmUpDatabase, DATABASE_WARM_UP_MS)

describeFeature(feature, ({ Scenario, ScenarioOutline }) => {
  let server: TestServer
  let options: PublicConfig
  let response: Response
  let error: unknown
  let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>
  let mailer: CloudflareMailer

  async function startServer(email: string, oauth: string) {
    server = await createTestServer({ email: email === 'email sending', env: OAUTH_ENV[oauth] })
  }

  function cloudflareAnswers(status: number, body: unknown) {
    fetchMock = vi.fn<typeof fetch>(async () => new Response(JSON.stringify(body), { status }))
  }

  async function send() {
    error = undefined
    try {
      await mailer.send(magicLinkEmail('ana@example.com', 'https://deyslide.test/api/auth/magic-link/verify?token=t'))
    }
    catch (caught) {
      error = caught
    }
  }

  ScenarioOutline('The API reports what is configured', ({ Given, When, Then }, variables) => {
    Given('the Deyslide API with <email> and <oauth>', () => startServer(variables.email, variables.oauth))
    When('the web app asks which sign in options exist', async () => {
      options = await (await new TestBrowser(server).request('/api/config')).json() as PublicConfig
    })
    Then('email is <email offered>, Google is <google offered> and GitHub is <github offered>', () => {
      expect([onOff(options.email), onOff(options.google), onOff(options.github)])
        .toEqual([variables['email offered'], variables['google offered'], variables['github offered']])
    })
  })

  Scenario('Without email sending, password sign up is off', ({ Given, When, Then }) => {
    Given('the Deyslide API with no email sending and no OAuth apps', () => startServer('no email sending', 'no OAuth apps'))
    When('"ana@example.com" signs up with the password "correct horse"', async () => {
      response = await new TestBrowser(server).request('/api/auth/sign-up/email', { json: { email: 'ana@example.com', password: 'correct horse', name: 'ana' } })
    })
    Then('sign up is refused', () => {
      expect(response.status).toBe(400)
    })
  })

  Scenario('Production needs a real secret', ({ When, Then }) => {
    When('the server starts in production without BETTER_AUTH_SECRET', () => {
      error = undefined
      try {
        readConfig({ NODE_ENV: 'production', PUBLIC_URL: 'https://deyslide.bambanggunawan.id' })
      }
      catch (caught) {
        error = caught
      }
    })
    Then('it stops with "BETTER_AUTH_SECRET must be set to at least 32 characters in production"', () => {
      expect((error as Error).message).toBe('BETTER_AUTH_SECRET must be set to at least 32 characters in production')
    })
  })

  Scenario('Emails go through Cloudflare Email Service', ({ Given, When, Then, And }) => {
    Given('a Cloudflare mailer for account "acc123" sending from "noreply@bambanggunawan.id"', () => {
      cloudflareAnswers(200, { success: true, errors: [], messages: [], result: { delivered: ['ana@example.com'], permanent_bounces: [], queued: [] } })
      mailer = new CloudflareMailer({ accountId: 'acc123', token: 'cf-token', from: 'noreply@bambanggunawan.id' }, fetchMock)
    })
    When('it sends "Your Deyslide sign in link" to "ana@example.com"', send)
    Then('it posts to "https://api.cloudflare.com/client/v4/accounts/acc123/email/sending/send" with the API token', () => {
      expect(error).toBeUndefined()
      const [url, init] = fetchMock.mock.calls[0]
      expect(url).toBe('https://api.cloudflare.com/client/v4/accounts/acc123/email/sending/send')
      expect(init?.method).toBe('POST')
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer cf-token')
    })
    And('the body has the sender, the recipient, the subject, a text part and an HTML part', () => {
      const body = JSON.parse(fetchMock.mock.calls[0][1]!.body as string)
      expect(body).toMatchObject({ from: 'noreply@bambanggunawan.id', to: 'ana@example.com', subject: 'Your Deyslide sign in link' })
      expect(body.text).toContain('https://deyslide.test/api/auth/magic-link/verify?token=t')
      expect(body.html).toContain('href="https://deyslide.test/api/auth/magic-link/verify?token=t"')
    })
  })

  Scenario('A refused email is reported', ({ Given, When, Then }) => {
    Given('a Cloudflare mailer whose API answers with error 10001 "Sender domain not verified"', () => {
      cloudflareAnswers(400, { success: false, errors: [{ code: 10001, message: 'Sender domain not verified' }] })
      mailer = new CloudflareMailer({ accountId: 'acc123', token: 'cf-token', from: 'noreply@bambanggunawan.id' }, fetchMock)
    })
    When('it sends "Your Deyslide sign in link" to "ana@example.com"', send)
    Then('sending fails with "Cloudflare Email Service refused the email: 10001 Sender domain not verified"', () => {
      expect((error as Error).message).toBe('Cloudflare Email Service refused the email: 10001 Sender domain not verified')
    })
  })
})
