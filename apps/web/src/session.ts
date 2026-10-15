import type { AccountService } from './account/types'
import type { AccountState } from './composables/useAccount'
import type { GuestStore } from './guest/store'
import type { ProjectApi } from './projects/api'
import type { ProjectStore } from './projects/types'
import { shallowRef } from 'vue'
import { CloudStore } from './projects/cloud-store'
import { Workspace } from './projects/workspace'

export interface SessionDependencies {
  service: AccountService
  /** Projects kept in this browser. The apps keep decks on the device instead. */
  guest?: GuestStore
  /** Decks saved as files on this device, in the apps. */
  local?: ProjectStore
  api: ProjectApi
}

/** Finds out who is signed in and opens the matching projects. */
export async function startSession({ service, guest, local, api }: SessionDependencies) {
  const [options, current] = await Promise.all([service.options(), service.current()])
  const workspace = new Workspace({ guest, local, openCloud: () => CloudStore.open(api) })
  await workspace.useAccount(current)

  const account = shallowRef(current)
  const state: AccountState = {
    service,
    options,
    account,
    async setAccount(next) {
      await workspace.useAccount(next)
      account.value = next
    },
  }
  return { account: state, workspace }
}
