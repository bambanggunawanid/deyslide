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
  signIn: (input: { email: string, password: string }) => Promise<Account>
  sendMagicLink: (email: string) => Promise<void>
  /** Leaves the page for the provider's sign in screen. */
  signInWith: (provider: SocialProvider) => Promise<void>
  requestPasswordReset: (email: string) => Promise<void>
  resetPassword: (input: { token: string, password: string }) => Promise<void>
  signOut: () => Promise<void>
}
