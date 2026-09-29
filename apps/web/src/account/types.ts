export interface Account {
  id: string
  name: string
  email: string
}

/** Which sign in options the server has credentials for. */
export interface SignInOptions {
  email: boolean
  google: boolean
  github: boolean
}

export type SocialProvider = 'google' | 'github'

export const NO_SIGN_IN_OPTIONS: SignInOptions = { email: false, google: false, github: false }

/** A failure to show to the person, already in plain words. */
export class AccountError extends Error {}

export interface AccountService {
  options: () => Promise<SignInOptions>
  current: () => Promise<Account | undefined>
  /** Creates the account and sends the confirmation email. */
  signUp: (input: { name: string, email: string, password: string }) => Promise<void>
  /** `next` is where the browser goes after signing in, when not the home page. */
  signIn: (input: { email: string, password: string, next?: string }) => Promise<Account>
  /** `next` is where the link leads after signing in. */
  sendMagicLink: (email: string, next?: string) => Promise<void>
  /** Leaves the page for the provider's sign in screen. `next` is where it leads after signing in. */
  signInWith: (provider: SocialProvider, next?: string) => Promise<void>
  requestPasswordReset: (email: string) => Promise<void>
  resetPassword: (input: { token: string, password: string }) => Promise<void>
  signOut: () => Promise<void>
  /** The name an app asking for access gave itself, for the consent page. */
  oauthClientName: (clientId: string) => Promise<string | undefined>
  /** Answers an app's request for access. Returns where to send the browser: back to the app. */
  answerConsent: (signedQuery: string, accept: boolean) => Promise<string>
}
