import type { Account, AccountService, SignInOptions, SocialProvider } from './types'
import { createAuthClient } from 'better-auth/client'
import { magicLinkClient } from 'better-auth/client/plugins'
import { AccountError, NO_SIGN_IN_OPTIONS } from './types'

const MESSAGES: Record<string, string> = {
  INVALID_EMAIL_OR_PASSWORD: 'The email or password is wrong.',
  EMAIL_NOT_VERIFIED: 'Confirm your email first. We sent you a new confirmation link.',
  USER_ALREADY_EXISTS: 'An account with this email already exists. Sign in instead.',
  USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL: 'An account with this email already exists. Sign in instead.',
  PASSWORD_TOO_SHORT: 'Use a password with at least 8 characters.',
  INVALID_EMAIL: 'Enter a valid email address.',
  INVALID_TOKEN: 'This link expired or was already used. Ask for a new one.',
}

interface ClientError {
  code?: string
  message?: string
  status: number
}

function fail(error: ClientError): never {
  if (error.status === 429)
    throw new AccountError('Too many attempts. Wait a minute and try again.')
  throw new AccountError((error.code && MESSAGES[error.code]) || error.message || 'Something went wrong. Try again.')
}

function toAccount(user: { id: string, name: string, email: string }): Account {
  return { id: user.id, name: user.name, email: user.email }
}

/** Talks to Better Auth on the Deyslide API under /api/auth. */
export class BetterAuthAccountService implements AccountService {
  private readonly client = createAuthClient({ plugins: [magicLinkClient()] })

  async options(): Promise<SignInOptions> {
    try {
      const response = await fetch('/api/config')
      return response.ok ? await response.json() as SignInOptions : NO_SIGN_IN_OPTIONS
    }
    catch {
      return NO_SIGN_IN_OPTIONS
    }
  }

  async current() {
    try {
      const { data } = await this.client.getSession()
      return data?.user ? toAccount(data.user) : undefined
    }
    catch {
      return undefined
    }
  }

  async signUp({ name, email, password }: { name: string, email: string, password: string }) {
    const { error } = await this.client.signUp.email({ name, email, password, callbackURL: '/' })
    if (error)
      fail(error)
  }

  async signIn({ email, password, next = '/' }: { email: string, password: string, next?: string }) {
    // Better Auth's client follows the callback URL itself after signing in.
    const { data, error } = await this.client.signIn.email({ email, password, callbackURL: next })
    if (error)
      fail(error)
    return toAccount(data.user)
  }

  async sendMagicLink(email: string, next = '/') {
    const { error } = await this.client.signIn.magicLink({ email, callbackURL: next, errorCallbackURL: '/sign-in?error=link' })
    if (error)
      fail(error)
  }

  async signInWith(provider: SocialProvider, next = '/') {
    const { error } = await this.client.signIn.social({ provider, callbackURL: next, errorCallbackURL: '/sign-in?error=social' })
    if (error)
      fail(error)
  }

  async requestPasswordReset(email: string) {
    const { error } = await this.client.requestPasswordReset({ email, redirectTo: '/reset-password' })
    if (error)
      fail(error)
  }

  async resetPassword({ token, password }: { token: string, password: string }) {
    const { error } = await this.client.resetPassword({ newPassword: password, token })
    if (error)
      fail(error)
  }

  async signOut() {
    const { error } = await this.client.signOut()
    if (error)
      fail(error)
  }

  async oauthClientName(clientId: string) {
    try {
      const response = await fetch(`/api/auth/oauth2/public-client?client_id=${encodeURIComponent(clientId)}`, { credentials: 'same-origin' })
      return response.ok ? (await response.json() as { client_name?: string }).client_name : undefined
    }
    catch {
      return undefined
    }
  }

  async answerConsent(signedQuery: string, accept: boolean) {
    let response: Response
    try {
      response = await fetch('/api/auth/oauth2/consent', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ accept, oauth_query: signedQuery }),
      })
    }
    catch {
      throw new AccountError('Deyslide is unreachable. Check your connection and try again.')
    }
    const data = await response.json().catch(() => ({})) as { url?: string, redirect_uri?: string, error_description?: string }
    const next = data.url ?? data.redirect_uri
    if (!response.ok || !next)
      throw new AccountError(response.status === 401 ? 'You are signed out. Sign in and start again from the app.' : 'This request expired or is not valid. Start again from the app.')
    return next
  }
}
