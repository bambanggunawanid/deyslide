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

  async signIn({ email, password }: { email: string, password: string, next?: string }) {
    const stored = this.accounts.get(email)
    if (!stored || stored.password !== password)
      throw new AccountError('The email or password is wrong.')
    if (!stored.confirmed)
      throw new AccountError('Confirm your email first. We sent you a new confirmation link.')
    this.signedIn = { id: stored.id, name: stored.name, email: stored.email }
    return this.signedIn
  }

  async sendMagicLink(email: string, next = '/') {
    this.calls.push(next === '/' ? `magic link ${email}` : `magic link ${email} then ${next}`)
  }

  async signInWith(provider: SocialProvider, next = '/') {
    this.calls.push(next === '/' ? `social ${provider}` : `social ${provider} then ${next}`)
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

  /** Apps that asked for access, by client id. */
  readonly oauthClients = new Map<string, string>()

  async oauthClientName(clientId: string) {
    return this.oauthClients.get(clientId)
  }

  async answerConsent(signedQuery: string, accept: boolean) {
    this.calls.push(`${accept ? 'allow' : 'deny'} ${new URLSearchParams(signedQuery).get('client_id')}`)
    const redirect = new URLSearchParams(signedQuery).get('redirect_uri')!
    return accept ? `${redirect}?code=fake-code` : `${redirect}?error=access_denied`
  }
}
