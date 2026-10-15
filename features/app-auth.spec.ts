// @vitest-environment node
import type { Project } from '../apps/server/src/projects'
import type { TestBrowser, TestServer } from './support/server'
import { createHash, randomBytes } from 'node:crypto'
import { describeFeature, loadFeature } from '@amiceli/vitest-cucumber'
import { beforeAll, expect, vi } from 'vitest'
import { MCP_ACCESS_TOKEN_SECONDS } from '../apps/server/src/auth'
import { approveConsent, connectMcp, FakeClaudeCodeAuth, followInBrowser } from './support/mcp-client'
import { closeTestServers, createTestServer, DATABASE_WARM_UP_MS, signedInBrowser, TEST_ORIGIN, warmUpDatabase } from './support/server'

const feature = await loadFeature('./app-auth.feature')

beforeAll(warmUpDatabase, DATABASE_WARM_UP_MS)

const API = `${TEST_ORIGIN}/api`
const MCP = `${TEST_ORIGIN}/mcp`
/** The desktop app registers the loopback address once and listens on any port. */
const DESKTOP_REDIRECT = 'http://127.0.0.1/callback'
const ANDROID_REDIRECT = 'id.bambanggunawan.deyslide:/oauth/callback'

interface Tokens {
  access_token: string
  refresh_token?: string
  scope: string
}

interface Answer<T> {
  status: number
  body: T
}

/** What the apps send to register themselves, as in the design of the apps' sign in. */
function appRegistration(redirect: string) {
  return { application_type: 'native', redirect_uris: [redirect], resources: [API] }
}

/** The claims of a JWT, without checking it. */
function claims(token: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString())
}

describeFeature(feature, ({ Background, Scenario, ScenarioOutline, AfterEachScenario }) => {
  let server: TestServer
  let ana: TestBrowser
  let anaId: string
  let clientId: string
  let redirect: string
  let verifier: string
  let consentPage: URL
  let landed: URL
  let tokens: Tokens
  let token: string

  AfterEachScenario(async () => {
    vi.useRealTimers()
    await closeTestServers()
  })

  async function readAnswer<T>(request: Response | Promise<Response>): Promise<Answer<T>> {
    const answer = await request
    const text = await answer.text()
    return { status: answer.status, body: (text ? JSON.parse(text) : undefined) as T }
  }

  /** Dynamic client registration, without a session, as an app does it. */
  function register(metadata: Record<string, unknown>) {
    return readAnswer<{ client_id: string, resources?: string[], error?: string }>(server.app.request(`${TEST_ORIGIN}/api/auth/oauth2/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        client_name: 'Deyslide app',
        token_endpoint_auth_method: 'none',
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        ...metadata,
      }),
    }))
  }

  async function registerApp(redirectUri: string) {
    const registered = await register(appRegistration(redirectUri))
    expect(registered.status).toBe(201)
    clientId = registered.body.client_id
  }

  /**
   * The app starts an authorization with PKCE in Ana's browser, through a
   * link or a posted form, naming `resource` unless it is null. When the
   * browser lands on the consent page, Ana approves. Returns where it lands.
   */
  async function authorize(redirectUri: string, resource: string | null = API, method: 'GET' | 'POST' = 'GET') {
    verifier = randomBytes(32).toString('base64url')
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: redirectUri,
      scope: 'openid profile email offline_access',
      state: 'state-1',
      code_challenge: createHash('sha256').update(verifier).digest('base64url'),
      code_challenge_method: 'S256',
    })
    if (resource !== null)
      params.set('resource', resource)
    const url = new URL(`${TEST_ORIGIN}/api/auth/oauth2/authorize`)
    redirect = redirectUri
    if (method === 'GET') {
      url.search = params.toString()
      consentPage = await followInBrowser(ana, url)
    }
    else {
      const posted = await ana.fetch(url.href, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: params.toString() })
      const location = posted.headers.get('location')
      expect(location, `the posted form got ${posted.status}`).toBeTruthy()
      consentPage = await followInBrowser(ana, new URL(location!, url))
    }
    landed = consentPage.pathname === '/oauth/consent' ? await approveConsent(ana, consentPage) : consentPage
  }

  function tokenRequest(params: Record<string, string>) {
    return readAnswer<Tokens & { error?: string }>(server.app.request(`${TEST_ORIGIN}/api/auth/oauth2/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(params),
    }))
  }

  async function exchangeCode() {
    const code = landed.searchParams.get('code')
    expect(code).toBeTruthy()
    const answer = await tokenRequest({ grant_type: 'authorization_code', code: code!, redirect_uri: redirect, client_id: clientId, code_verifier: verifier })
    expect(answer.status).toBe(200)
    tokens = answer.body
    token = tokens.access_token
  }

  function refresh(refreshToken: string, resource?: string) {
    return tokenRequest({ grant_type: 'refresh_token', refresh_token: refreshToken, client_id: clientId, ...(resource && { resource }) })
  }

  function expectInvalidTarget(answer: Answer<{ error?: string }>) {
    expect(answer.status).toBe(400)
    expect(answer.body.error).toBe('invalid_target')
  }

  function expectConsentFor(resource: string) {
    expect(consentPage.origin + consentPage.pathname).toBe(`${TEST_ORIGIN}/oauth/consent`)
    expect(consentPage.searchParams.getAll('resource')).toEqual([resource])
  }

  function expectApiTokens() {
    const audience = claims(token).aud
    expect(audience).toContain(API)
    expect(audience).not.toContain(MCP)
    expect(claims(token).sub).toBe(anaId)
    expect(tokens.refresh_token).toBeTruthy()
    expect(tokens.scope.split(' ')).toContain('offline_access')
  }

  async function desktopSignIn() {
    await registerApp(DESKTOP_REDIRECT)
    await authorize('http://127.0.0.1:49152/callback')
    await exchangeCode()
  }

  function withToken(path: string, bearer: string, init: { method?: string, headers?: Record<string, string>, body?: string } = {}) {
    return server.app.request(`${TEST_ORIGIN}${path}`, { ...init, headers: { ...init.headers, authorization: `Bearer ${bearer}` } })
  }

  async function projectNames(bearer: string) {
    const answer = await readAnswer<Project[]>(withToken('/api/projects', bearer))
    expect(answer.status).toBe(200)
    return answer.body.map(project => project.name)
  }

  function postMcp(bearer: string) {
    return withToken('/mcp', bearer, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'accept': 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    })
  }

  async function userId(browser: TestBrowser) {
    return (await browser.json<{ user: { id: string } }>('/api/auth/get-session')).body.user.id
  }

  function expectRefused(answer: Response) {
    expect(answer.status).toBe(401)
    expect(answer.headers.get('www-authenticate')).toContain('error="invalid_token"')
  }

  function passTime(seconds: number) {
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + seconds * 1000 })
  }

  Background(({ Given, And }) => {
    Given('the Deyslide API', async () => {
      server = await createTestServer()
    })
    And('Ana is signed in on a browser with the project "Talks"', async () => {
      ana = await signedInBrowser(server, 'ana@example.com', 'Ana')
      anaId = await userId(ana)
      expect((await ana.json('/api/projects', { json: { name: 'Talks' } })).status).toBe(201)
    })
  })

  Scenario('The desktop app signs in and reads the account', ({ Given, When, Then, And, But }) => {
    Given('the desktop app registered itself for the API', async () => {
      await registerApp(DESKTOP_REDIRECT)
    })
    When('the desktop app asks Ana to sign in from port 49152 and they approve it', async () => {
      await authorize('http://127.0.0.1:49152/callback')
      expect(landed.origin + landed.pathname).toBe('http://127.0.0.1:49152/callback')
      expect(landed.searchParams.get('state')).toBe('state-1')
      await exchangeCode()
    })
    Then('the consent page Ana saw named the API as the resource', () => expectConsentFor(API))
    And('the desktop app gets an access token for the API and a refresh token', expectApiTokens)
    And('with that token it lists Ana\'s project "Talks"', async () => {
      expect(await projectNames(token)).toEqual(['Talks'])
    })
    And('it reads Ana\'s name and email from /api/me', async () => {
      const me = await readAnswer(withToken('/api/me', token))
      expect(me).toEqual({ status: 200, body: { id: anaId, name: 'Ana', email: 'ana@example.com' } })
      // The website reads the same thing with its cookie.
      expect((await ana.json('/api/me')).body).toEqual(me.body)
    })
    But('Better Auth\'s own session endpoint does not accept the token', async () => {
      const session = await readAnswer(withToken('/api/auth/get-session', token))
      expect(session.body ?? null).toBeNull()
    })
  })

  Scenario('The Android app signs in through its own scheme', ({ Given, When, Then, And }) => {
    Given('the Android app registered itself for the API', async () => {
      const registered = await register(appRegistration(ANDROID_REDIRECT))
      expect(registered.status).toBe(201)
      expect(registered.body.resources).toEqual([MCP, API])
      clientId = registered.body.client_id
    })
    When('the Android app asks Ana to sign in and they approve it', async () => {
      await authorize(ANDROID_REDIRECT)
    })
    Then('the browser hands the code to "id.bambanggunawan.deyslide:/oauth/callback"', () => {
      expect(`${landed.protocol}${landed.pathname}`).toBe(ANDROID_REDIRECT)
      expect(landed.searchParams.get('code')).toBeTruthy()
      expect(landed.searchParams.get('state')).toBe('state-1')
    })
    And('the Android app trades the code for an access token for the API', async () => {
      await exchangeCode()
      expect(claims(token).aud).toContain(API)
    })
    And('with that token it lists Ana\'s project "Talks"', async () => {
      expect(await projectNames(token)).toEqual(['Talks'])
    })
  })

  Scenario('A token for one endpoint does not open the other', ({ Given, And, Then }) => {
    let mcpToken: string
    Given('the desktop app signed in as Ana', desktopSignIn)
    And('Claude Code signed in as Ana for the MCP endpoint', async () => {
      const claude = new FakeClaudeCodeAuth(async (url) => {
        const page = await followInBrowser(ana, url)
        return page.pathname === '/oauth/consent' ? approveConsent(ana, page) : page
      })
      await connectMcp(server, claude)
      mcpToken = claude.tokens()!.access_token
      expect(claims(mcpToken).aud).toContain(MCP)
    })
    Then('the MCP token is refused by the API', async () => {
      expectRefused(await withToken('/api/projects', mcpToken))
      expectRefused(await withToken('/api/me', mcpToken))
    })
    And('the API token is refused by the MCP endpoint', async () => {
      expectRefused(await postMcp(token))
      // Each token still opens its own endpoint.
      expect((await postMcp(mcpToken)).status).toBe(200)
      expect(await projectNames(token)).toEqual(['Talks'])
    })
  })

  Scenario('Expired and forged tokens are refused', ({ Given, And, When, Then }) => {
    let budiId: string
    let forged: string
    Given('the desktop app signed in as Ana', desktopSignIn)
    And('with that token it lists Ana\'s project "Talks"', async () => {
      expect(await projectNames(token)).toEqual(['Talks'])
    })
    And('Budi has an account too', async () => {
      budiId = await userId(await signedInBrowser(server, 'budi@example.com', 'Budi'))
    })
    When('the token is changed to name Budi', () => {
      const [header, , signature] = token.split('.')
      const payload = Buffer.from(JSON.stringify({ ...claims(token), sub: budiId })).toString('base64url')
      forged = [header, payload, signature].join('.')
    })
    Then('the API refuses the changed token with 401', async () => {
      expectRefused(await withToken('/api/projects', forged))
    })
    When('the token is sent without a signature', () => {
      const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url')
      forged = [header, token.split('.')[1], ''].join('.')
    })
    Then('the API refuses the unsigned token with 401', async () => {
      expectRefused(await withToken('/api/projects', forged))
    })
    When('an hour and a minute pass', () => {
      expect(MCP_ACCESS_TOKEN_SECONDS).toBe(60 * 60)
      passTime(MCP_ACCESS_TOKEN_SECONDS + 60)
    })
    Then('the API refuses the real token with 401', async () => {
      expectRefused(await withToken('/api/projects', token))
    })
  })

  ScenarioOutline('An app that names no resource is asked for the whole account', ({ Given, When, Then, And }, variables) => {
    Given('the desktop app registered itself for the API', async () => {
      await registerApp(DESKTOP_REDIRECT)
    })
    When('the desktop app sends Ana\'s browser to sign in by <method> without naming a resource, and they approve it', async () => {
      await authorize('http://127.0.0.1:49152/callback', null, variables.method as 'GET' | 'POST')
      await exchangeCode()
    })
    Then('the consent page Ana saw named the API as the resource', () => expectConsentFor(API))
    And('the desktop app gets an access token for the API and a refresh token', expectApiTokens)
  })

  Scenario('Approving the MCP endpoint does not open the API', ({ Given, When, Then, And }) => {
    Given('the desktop app registered itself for the API', async () => {
      await registerApp(DESKTOP_REDIRECT)
    })
    When('the desktop app asks Ana to sign in for the MCP endpoint and they approve it', async () => {
      await authorize('http://127.0.0.1:49152/callback', MCP)
    })
    Then('the consent page Ana saw named the MCP endpoint as the resource', () => expectConsentFor(MCP))
    And('the code cannot be traded for a token for the API', async () => {
      const code = landed.searchParams.get('code')!
      expectInvalidTarget(await tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: redirect, client_id: clientId, code_verifier: verifier, resource: API }))
    })
    And('a refresh token from that approval cannot be traded for a token for the API', async () => {
      // Ana already approved the MCP endpoint, so the browser goes straight back to the app.
      await authorize('http://127.0.0.1:49152/callback', MCP)
      expect(consentPage.pathname).toBe('/callback')
      await exchangeCode()
      expect(claims(token).aud).toContain(MCP)
      expect(claims(token).aud).not.toContain(API)
      expectInvalidTarget(await refresh(tokens.refresh_token!, API))
    })
    When('the desktop app asks Ana again without naming a resource', async () => {
      await authorize('http://127.0.0.1:49152/callback', null)
    })
    Then('the consent page shows again, naming the API as the resource', () => expectConsentFor(API))
  })

  Scenario('A client that did not ask for the API at registration cannot get it later', ({ Given, When, Then }) => {
    Given('an app registered itself without naming any resource', async () => {
      const registered = await register({ application_type: 'native', redirect_uris: [ANDROID_REDIRECT] })
      expect(registered.status).toBe(201)
      expect(registered.body.resources).toEqual([MCP])
      clientId = registered.body.client_id
    })
    When('it asks Ana for a token for the API', async () => {
      await authorize(ANDROID_REDIRECT)
    })
    Then('the browser is sent back to the app with the error "invalid_target"', () => {
      expect(`${landed.protocol}${landed.pathname}`).toBe(ANDROID_REDIRECT)
      expect(landed.searchParams.get('error')).toBe('invalid_target')
      expect(landed.searchParams.get('code')).toBeNull()
    })
  })

  ScenarioOutline('Only the Deyslide apps may register for the API', ({ When, Then }, variables) => {
    let registered: Answer<{ error?: string }>
    When('an app registers for the API as a <type> client answered at "<redirect>"', async () => {
      registered = await register({ application_type: variables.type, redirect_uris: [variables.redirect], resources: [API] })
    })
    Then('the registration is refused with "invalid_client_metadata"', () => {
      expect(registered.status).toBe(400)
      expect(registered.body.error).toBe('invalid_client_metadata')
    })
  })

  Scenario('An app that leaves out its type is taken as native', ({ When, Then }) => {
    let registered: Answer<{ application_type?: string, resources?: string[] }>
    When('an app registers for the API answered at "http://127.0.0.1/callback" without naming its type', async () => {
      registered = await register({ redirect_uris: [DESKTOP_REDIRECT], resources: [API] })
    })
    Then('the registration is accepted for the MCP endpoint and the API', () => {
      expect(registered.status).toBe(201)
      expect(registered.body.application_type).toBe('native')
      expect(registered.body.resources).toEqual([MCP, API])
    })
  })

  Scenario('An app cannot move its answer elsewhere after registering', ({ Given, When, Then }) => {
    let changed: Answer<{ error?: string }>
    Given('Ana registered the desktop app for the API while signed in', async () => {
      const registered = await ana.json<{ client_id: string, resources: string[] }>('/api/auth/oauth2/register', {
        json: { client_name: 'Deyslide app', token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], ...appRegistration(DESKTOP_REDIRECT) },
      })
      expect(registered.status).toBe(201)
      expect(registered.body.resources).toEqual([MCP, API])
      clientId = registered.body.client_id
    })
    When('Ana changes the app\'s answer address to "https://evil.example/callback"', async () => {
      changed = await ana.json('/api/auth/oauth2/update-client', {
        json: { client_id: clientId, update: { application_type: 'web', redirect_uris: ['https://evil.example/callback'] } },
      })
    })
    Then('the change is refused with "invalid_client_metadata"', async () => {
      expect(changed.status).toBe(400)
      expect(changed.body.error).toBe('invalid_client_metadata')
      // A change that keeps the apps' address still goes through.
      const kept = await ana.json('/api/auth/oauth2/update-client', { json: { client_id: clientId, update: { client_name: 'Deyslide desktop', redirect_uris: [DESKTOP_REDIRECT] } } })
      expect(kept.status).toBe(200)
    })
  })

  Scenario('The app stays signed in with its refresh token', ({ Given, When, Then, And }) => {
    let refreshed: Answer<Tokens>
    Given('the desktop app signed in as Ana', desktopSignIn)
    When('the app trades its refresh token for new tokens', async () => {
      refreshed = await refresh(tokens.refresh_token!)
      expect(refreshed.status).toBe(200)
    })
    Then('the new access token lists Ana\'s project "Talks"', async () => {
      expect(refreshed.body.access_token).not.toBe(token)
      expect(claims(refreshed.body.access_token).aud).toContain(API)
      expect(await projectNames(refreshed.body.access_token)).toEqual(['Talks'])
    })
    And('the new refresh token works in turn', async () => {
      expect(refreshed.body.refresh_token).toBeTruthy()
      expect(refreshed.body.refresh_token).not.toBe(tokens.refresh_token)
      expect((await refresh(refreshed.body.refresh_token!)).status).toBe(200)
    })
  })

  Scenario('Two refreshes a moment apart keep the app signed in', ({ Given, When, Then, And }) => {
    let first: Answer<Tokens>
    let second: Answer<Tokens>
    Given('the desktop app signed in as Ana', desktopSignIn)
    When('two parts of the app trade the same refresh token a moment apart', async () => {
      first = await refresh(tokens.refresh_token!)
      passTime(2)
      second = await refresh(tokens.refresh_token!)
    })
    Then('both get the same new tokens', () => {
      expect(first.status).toBe(200)
      expect(second.status).toBe(200)
      expect(second.body.access_token).toBe(first.body.access_token)
      expect(second.body.refresh_token).toBe(first.body.refresh_token)
    })
    And('the new refresh token still works', async () => {
      const next = await refresh(first.body.refresh_token!)
      expect(next.status).toBe(200)
      expect(await projectNames(next.body.access_token)).toEqual(['Talks'])
    })
  })

  Scenario('A refresh token sent again much later is refused', ({ Given, And, When, Then }) => {
    let again: Answer<{ error?: string }>
    Given('the desktop app signed in as Ana', desktopSignIn)
    And('the app traded its refresh token for new tokens', async () => {
      expect((await refresh(tokens.refresh_token!)).status).toBe(200)
    })
    When('the old refresh token is sent again a minute later', async () => {
      passTime(60)
      again = await refresh(tokens.refresh_token!)
    })
    Then('the refresh is refused with "invalid_grant"', () => {
      expect(again.status).toBe(400)
      expect(again.body.error).toBe('invalid_grant')
    })
  })
})
