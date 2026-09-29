import type { InjectionKey, ShallowRef } from 'vue'
import type { Account, AccountService, SignInOptions } from '../account/types'
import { inject } from 'vue'

export interface AccountState {
  service: AccountService
  options: SignInOptions
  /** The signed in account, or undefined for a guest. Change it with `setAccount`. */
  account: ShallowRef<Account | undefined>
  /** Updates the account and waits until the projects follow it. */
  setAccount: (account: Account | undefined) => Promise<void>
}

export const ACCOUNT_KEY: InjectionKey<AccountState> = Symbol('account')

export function useAccount(): AccountState {
  const state = inject(ACCOUNT_KEY)
  if (!state)
    throw new Error('The account state is not provided')
  return state
}
