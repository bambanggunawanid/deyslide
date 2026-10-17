import type { AccountService } from './account/types'
import type { AccountState } from './composables/useAccount'
import type { GuestStore } from './guest/store'
import type { ProjectApi } from './projects/api'
import type { OfflineCache } from './projects/offline-cache'
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
  /** What live editing signs in with. Browsers send their cookie; the apps send an access token. */
  collabToken?: () => Promise<string>
  /** Keeps account decks and project lists on this device, so they open offline. */
  offline?: OfflineCache
}

/**
 * Finds out who is signed in and opens the matching projects. When the
 * server does not answer, the person signed in last on this device is
 * shown with the projects kept for them, until the server answers.
 */
export async function startSession({ service, guest, local, api, collabToken, offline }: SessionDependencies) {
  const [options, answered] = await Promise.all([service.options(), service.current()])
  const remembered = !answered && service.unsure ? await offline?.lastAccount() : undefined
  if (answered)
    await offline?.rememberAccount(answered)
  const workspace = new Workspace({
    guest,
    local,
    openCloud: account => CloudStore.open(api, { token: collabToken, cache: offline, userId: account.id }),
  })
  await workspace.useAccount(answered ?? remembered)
  // Nothing was kept for the remembered person after all: the page starts signed out, and says nothing about it.
  const current = remembered && !workspace.stores.value.cloud ? undefined : answered ?? remembered
  if (remembered && !current)
    workspace.notice.value = ''

  const account = shallowRef(current)
  const state: AccountState = {
    service,
    options,
    account,
    async setAccount(next) {
      await workspace.useAccount(next)
      account.value = next
      if (next)
        await offline?.rememberAccount(next)
    },
    async signOut() {
      const leaving = account.value
      await service.signOut()
      await workspace.useAccount(undefined)
      account.value = undefined
      // Nothing of the account stays on this device.
      if (leaving)
        await offline?.forget(leaving.id)
    },
  }
  return { account: state, workspace }
}
