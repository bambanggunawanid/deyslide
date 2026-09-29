import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js'
import type { OAuthClientInformationMixed, OAuthClientMetadata, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js'
import type { TestBrowser, TestServer } from './server'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js'
import { TEST_ORIGIN } from './server'

/** Where the fake Claude Code listens for the sign in redirect, as a real one does on localhost. */
export const CALLBACK_URL = 'http://127.0.0.1:33418/callback'

/** Sends a request to the in-memory API, as if over the network. */
export function serverFetch(server: TestServer): typeof fetch {
  return ((input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init)
    return server.app.request(request.url, {
      method: request.method,
      headers: request.headers,
      body: request.method === 'GET' || request.method === 'HEAD' ? undefined : request.body,
      // Node needs this to send a streamed body.
      ...(request.body ? { duplex: 'half' } : {}),
      redirect: 'manual',
    } as RequestInit)
  }) as typeof fetch
}

/**
 * Plays the part of Claude Code's OAuth client, with the MCP SDK doing the
 * discovery, registration, PKCE and token exchange the way Claude Code does.
 * `approve` stands in for the person: it opens the authorization URL in a
 * browser and returns the URL the browser ends up on.
 */
export class FakeClaudeCodeAuth implements OAuthClientProvider {
  private client?: OAuthClientInformationMixed
  private saved?: OAuthTokens
  private verifier = ''
  /** The last authorization URL the client sent the person to. */
  authorizationUrl?: URL
  /** The code from the redirect back to the client. */
  code?: string

  constructor(private readonly approve: (url: URL) => Promise<URL>) {}

  get redirectUrl() {
    return CALLBACK_URL
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: 'Claude Code (test)',
      redirect_uris: [CALLBACK_URL],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    }
  }

  clientInformation() {
    return this.client
  }

  saveClientInformation(client: OAuthClientInformationMixed) {
    this.client = client
  }

  tokens() {
    return this.saved
  }

  saveTokens(tokens: OAuthTokens) {
    this.saved = tokens
  }

  async redirectToAuthorization(url: URL) {
    this.authorizationUrl = url
    const landed = await this.approve(url)
    this.code = landed.searchParams.get('code') ?? undefined
  }

  saveCodeVerifier(verifier: string) {
    this.verifier = verifier
  }

  codeVerifier() {
    return this.verifier
  }
}

/**
 * The person's side of signing in: follows redirects inside Deyslide until
 * the browser is sent to a page. Returns that page's URL.
 */
export async function followInBrowser(browser: TestBrowser, url: URL): Promise<URL> {
  let current = url
  for (let hop = 0; hop < 10; hop++) {
    if (!current.href.startsWith(TEST_ORIGIN) || !current.pathname.startsWith('/api/'))
      return current
    const response = await browser.request(current.href)
    const location = response.headers.get('location')
    if (!location)
      throw new Error(`Expected a redirect from ${current.pathname}, got ${response.status}: ${await response.text()}`)
    current = new URL(location, current)
  }
  throw new Error('Too many redirects')
}

/** Approves the consent page the browser landed on, and returns where Deyslide sends it next. */
export async function approveConsent(browser: TestBrowser, consentPage: URL, accept = true): Promise<URL> {
  const result = await browser.json<{ url?: string, redirect_uri?: string }>('/api/auth/oauth2/consent', {
    json: { accept, oauth_query: consentPage.search.slice(1) },
  })
  const next = result.body?.url ?? result.body?.redirect_uri
  if (!next)
    throw new Error(`Consent failed with ${result.status}: ${JSON.stringify(result.body)}`)
  return new URL(next)
}

/** Connects an MCP client to the in-memory API, signing in through the browser when asked. */
export async function connectMcp(server: TestServer, auth: FakeClaudeCodeAuth) {
  const url = new URL('/mcp', TEST_ORIGIN)
  const fetch = serverFetch(server)
  let transport = new StreamableHTTPClientTransport(url, { authProvider: auth, fetch })
  let client = new Client({ name: 'claude-code-test', version: '1.0.0' })
  try {
    await client.connect(transport)
    return client
  }
  catch (error) {
    if (!(error instanceof UnauthorizedError) || !auth.code)
      throw error
  }
  // Back from the browser: trade the code for tokens, then connect again.
  await transport.finishAuth(auth.code)
  transport = new StreamableHTTPClientTransport(url, { authProvider: auth, fetch })
  client = new Client({ name: 'claude-code-test', version: '1.0.0' })
  await client.connect(transport)
  return client
}
