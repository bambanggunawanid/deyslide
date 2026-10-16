import type { AccountService } from './types'
import { isApp } from '../platform/platform'
import { AppAccountService } from './app'

/**
 * The account service for where the page runs. Better Auth loads only on
 * the website: in the app its client would take the app's own origin for
 * the server and stop the page from starting.
 */
export async function createAccountService(): Promise<AccountService> {
  if (isApp())
    return new AppAccountService()
  const { BetterAuthAccountService } = await import('./better-auth')
  return new BetterAuthAccountService()
}
