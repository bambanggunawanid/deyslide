import type { Account, AccountService, SignInOptions, SocialProvider } from '../../apps/web/src/account/types'
import { AccountError } from '../../apps/web/src/account/types'

interface StoredAccount extends Account {
  password: string
  confirmed: boolean
}

/** An in-memory stand in for the API, for page scenarios. The API has its own scenarios. */
export class FakeAccountService implements AccountService {
  private readonly accounts = new Map<string, StoredAccount>()
  signedIn: Account | undefined
  readonly calls: string[] = []

  constructor(private readonly available: SignInOptions = { email: true, google: true, github: true }) {}

  addAccount(email: string, password: string, name = email.split('@')[0]) {
    this.accounts.set(email, { id: `user-${this.accounts.size + 1}`, name, email, password, confirmed: true })
  }

  async options() {
    return this.available
  }

  async current() {
    return this.signedIn
  }

  async signUp({ name, email, password }: { name: string, email: string, password: string }) {
    this.calls.push(`sign up ${email}`)
    if (this.accounts.has(email))
      throw new AccountError('An account with this email already exists. Sign in instead.')
    this.accounts.set(email, { id: `user-${this.accounts.size + 1}`, name, email, password, confirmed: false })
  }

  async signIn({ email, password }: { email: string, password: string }) {
    const stored = this.accounts.get(email)
    if (!stored || stored.password !== password)
      throw new AccountError('The email or password is wrong.')
    if (!stored.confirmed)
      throw new AccountError('Confirm your email first. We sent you a new confirmation link.')
    this.signedIn = { id: stored.id, name: stored.name, email: stored.email }
    return this.signedIn
  }

  async sendMagicLink(email: string) {
    this.calls.push(`magic link ${email}`)
  }

  async signInWith(provider: SocialProvider) {
    this.calls.push(`social ${provider}`)
  }

  async requestPasswordReset(email: string) {
    this.calls.push(`reset ${email}`)
  }

  async resetPassword({ token }: { token: string, password: string }) {
    this.calls.push(`new password with ${token}`)
  }

  async signOut() {
    this.signedIn = undefined
  }
}
