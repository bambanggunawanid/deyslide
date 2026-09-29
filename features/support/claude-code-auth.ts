import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js'
import type { OAuthClientInformationMixed, OAuthClientMetadata, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js'

/** Where the fake Claude Code listens for the sign in redirect, as a real one does on localhost. */
export const CALLBACK_URL = 'http://127.0.0.1:33418/callback'

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
