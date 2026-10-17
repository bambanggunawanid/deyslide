import type { Router } from 'vue-router'
import type { AccountState } from '../composables/useAccount'
import type { AppAccount } from '../platform/native'
import type { Account, AccountService, SignInOptions } from './types'
import { authAccount, authSignIn, authSignOut, onAccountChanged } from '../platform/native'
import { isMobileApp } from '../platform/platform'
import { AccountError, NO_SIGN_IN_OPTIONS } from './types'

/** The app has no sign in pages: the website does that part, in the browser. */
const USE_THE_BROWSER = 'In the app, use Sign in with your browser.'

/**
 * How long the page waits to hear who is signed in. Asking needs the
 * server, and a server that does not answer must not keep the window blank.
 */
const ACCOUNT_WAIT_MS = 5000

/** How often the page asks again while the server has not said who is signed in. */
const RECHECK_MS = 30_000

/** The app's commands fail with a message already written for people. */
function failure(error: unknown, otherwise: string) {
  return new AccountError(typeof error === 'string' && error ? error : otherwise)
}

function toAccount(account: AppAccount | null): Account | undefined {
  return account ? { id: account.id, name: account.name, email: account.email } : undefined
}

/** Rejects when `promise` takes longer than `ms`. */
function within<T>(promise: Promise<T>, ms: number) {
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('No answer in time')), ms)
  })
  return Promise.race([promise, late]).finally(() => clearTimeout(timer))
}

/** Resolves at the next `account-changed`, until `stop` is called. */
async function nextAccountChange() {
  let changed!: () => void
  const promise = new Promise<void>(resolve => (changed = resolve))
  const stop = await onAccountChanged(() => changed())
  return { changed: promise, stop }
}

/**
 * The account inside the Deyslide app, through the app's commands. The
 * person signs in on the website in the system browser; the app keeps the
 * tokens and tells every page when the account changes (`account-changed`,
 * see {@link followAppAccount}). The Better Auth client is never created
 * here: it needs the page and the server to share an origin.
 */
export class AppAccountService implements AccountService {
  /**
   * True when the last look at the account got no answer: the app holds a
   * sign in, but its server could not be reached or was too slow. The page
   * then starts without the account, and {@link followAppAccount} asks
   * again later. Being signed out is a clear answer, never this.
   */
  unsure = false
  private asking: Promise<AppAccount | null> | undefined
  private readonly wait: number

  constructor({ wait = ACCOUNT_WAIT_MS }: { wait?: number } = {}) {
    this.wait = wait
  }

  async options(): Promise<SignInOptions> {
    return { ...NO_SIGN_IN_OPTIONS, browser: true }
  }

  async current() {
    // One question at a time: a slow server is asked once, not once per caller.
    this.asking ??= authAccount().finally(() => {
      this.asking = undefined
    })
    try {
      const account = await within(this.asking, this.wait)
      this.unsure = false
      return toAccount(account)
    }
    catch {
      this.unsure = true
      return undefined
    }
  }

  /**
   * Resolves once the sign in ends. On a computer the command returns
   * then. On a phone it returns as soon as the browser opens; the browser
   * later hands the sign in back to the app, which says the account changed.
   */
  async signInWithBrowser() {
    const returned = isMobileApp() ? await nextAccountChange() : undefined
    try {
      await authSignIn()
      await returned?.changed
    }
    catch (error) {
      throw failure(error, 'Signing in did not work. Try again.')
    }
    finally {
      returned?.stop()
    }
    const account = await this.current()
    if (!account && !this.unsure)
      throw new AccountError('Signing in did not finish. Try again.')
    return account
  }

  /** There is no password sign in here, so this goes through the browser too. */
  async signIn() {
    const account = await this.signInWithBrowser()
    if (!account)
      throw new AccountError('The server did not answer. Deyslide shows your account once it does.')
    return account
  }

  async signOut() {
    try {
      await authSignOut()
    }
    catch (error) {
      throw failure(error, 'Signing out did not work. Try again.')
    }
  }

  async signUp(): Promise<void> {
    throw new AccountError(USE_THE_BROWSER)
  }

  async sendMagicLink(): Promise<void> {
    throw new AccountError(USE_THE_BROWSER)
  }

  async signInWith(): Promise<void> {
    throw new AccountError(USE_THE_BROWSER)
  }

  async requestPasswordReset(): Promise<void> {
    throw new AccountError(USE_THE_BROWSER)
  }

  async resetPassword(): Promise<void> {
    throw new AccountError(USE_THE_BROWSER)
  }

  async oauthClientName() {
    return undefined
  }

  async answerConsent(): Promise<string> {
    throw new AccountError(USE_THE_BROWSER)
  }
}

/**
 * Keeps the page's account in step with the app, which signs in and out
 * outside the page: in the browser, or when the server ends a sign in.
 *
 * - It asks once as soon as it listens, because the app sends nothing to a
 *   page that is not listening yet (an Android sign in can finish while the
 *   page starts).
 * - Before the account changes, the page goes home, so an open deck saves
 *   its typing to the projects it came from.
 * - Updates run one at a time. The account already shown stays as it is
 *   (its projects are not loaded twice), and so does any account while the
 *   server gives no answer. It then asks again when the window comes back,
 *   when the network returns, and every half minute.
 *
 * Resolves with a function that stops following.
 */
export async function followAppAccount(state: AccountState, router: Router, { recheckEvery = RECHECK_MS } = {}) {
  const unsure = () => state.service instanceof AppAccountService && state.service.unsure
  let updating = Promise.resolve()

  async function update() {
    const next = await state.service.current()
    if (unsure() || next?.id === state.account.value?.id)
      return
    await router.push({ name: 'home' })
    await state.setAccount(next)
  }

  function queue() {
    // A failed update keeps the account shown; the next change tries again.
    updating = updating.then(update).catch(() => {})
  }

  function recheck() {
    if (unsure())
      queue()
  }

  const stopListening = await onAccountChanged(queue)
  queue()
  window.addEventListener('focus', recheck)
  window.addEventListener('online', recheck)
  const timer = setInterval(recheck, recheckEvery)
  return () => {
    stopListening()
    window.removeEventListener('focus', recheck)
    window.removeEventListener('online', recheck)
    clearInterval(timer)
  }
}
