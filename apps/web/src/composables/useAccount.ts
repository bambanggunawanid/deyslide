import type { InjectionKey, ShallowRef } from 'vue'
import type { Account, AccountService, SignInOptions } from '../account/types'
import { inject } from 'vue'

export interface AccountState {
  service: AccountService
  options: SignInOptions
  /** The signed in account, or undefined for a guest. */
  account: ShallowRef<Account | undefined>
}

export const ACCOUNT_KEY: InjectionKey<AccountState> = Symbol('account')

export function useAccount(): AccountState {
  const state = inject(ACCOUNT_KEY)
  if (!state)
    throw new Error('The account state is not provided')
  return state
}
