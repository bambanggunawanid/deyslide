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

  async signIn({ email, password }: { email: string, password: string }) {
    const { data, error } = await this.client.signIn.email({ email, password, callbackURL: '/' })
    if (error)
      fail(error)
    return toAccount(data.user)
  }

  async sendMagicLink(email: string) {
    const { error } = await this.client.signIn.magicLink({ email, callbackURL: '/', errorCallbackURL: '/sign-in?error=link' })
    if (error)
      fail(error)
  }

  async signInWith(provider: SocialProvider) {
    const { error } = await this.client.signIn.social({ provider, callbackURL: '/', errorCallbackURL: '/sign-in?error=social' })
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
}
