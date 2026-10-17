import type { ShallowRef } from 'vue'
import type { Account } from '../account/types'
import type { GuestStore } from '../guest/store'
import type { CloudStore } from './cloud-store'
import type { ProjectStore } from './types'
import { shallowRef } from 'vue'
import { plural } from '../format'

/** Ids of projects and decks saved on this device start with this. */
export const LOCAL_ID_PREFIX = 'local-'

/** Lets go of an account's store that is no longer in use. */
async function closeStore(store: ProjectStore | undefined) {
  await (store as Partial<CloudStore> | undefined)?.close?.()
}

/** The stores a workspace can hold. Guests have no cloud; the apps have no guest store. */
export interface WorkspaceStores {
  /** Decks saved as files on this device (the apps). */
  local?: ProjectStore
  /** Projects kept in this browser. */
  guest?: ProjectStore
  /** The signed in person's account. */
  cloud?: ProjectStore
}

export interface WorkspaceOptions {
  guest?: GuestStore
  local?: ProjectStore
  openCloud: (account: Account) => Promise<CloudStore>
}

/**
 * Chooses where projects live: the device, the browser for guests, the
 * account for signed in people. Signing in moves the browser's projects
 * into the account, never the device's.
 */
export class Workspace {
  readonly stores: ShallowRef<WorkspaceStores>
  /** What the home page lists from outside the device: the account when signed in, else the browser. */
  readonly primary: ShallowRef<ProjectStore>
  /** The same as `primary`, while callers move to `primary` and `storeFor`. */
  readonly store: ShallowRef<ProjectStore>
  /** A one time message about moving browser projects, shown on the home page. */
  readonly notice = shallowRef('')
  private readonly guest?: GuestStore
  private readonly local?: ProjectStore
  private readonly openCloud: (account: Account) => Promise<CloudStore>

  constructor({ guest, local, openCloud }: WorkspaceOptions) {
    const first = guest ?? local
    if (!first)
      throw new Error('A workspace needs a browser store or a device store')
    this.guest = guest
    this.local = local
    this.openCloud = openCloud
    this.stores = shallowRef(this.withoutAccount())
    this.primary = shallowRef<ProjectStore>(first)
    this.store = this.primary
  }

  /** The store that holds this project or deck id. */
  storeFor(id: string): ProjectStore {
    const { local, guest, cloud } = this.stores.value
    const found = id.startsWith(LOCAL_ID_PREFIX) ? local : cloud ?? guest
    return found ?? this.primary.value
  }

  async useAccount(account: Account | undefined) {
    this.notice.value = ''
    if (!account) {
      await this.signedOut()
      return
    }
    let cloud: CloudStore
    try {
      cloud = await this.openCloud(account)
    }
    catch {
      await this.signedOut()
      // New projects go where they go signed out: the browser on the website, the device in the apps.
      this.notice.value = this.guest
        ? 'Your account\'s projects could not be loaded. Reload the page to try again. Until then, new projects stay in this browser.'
        : 'Your account\'s projects could not be loaded. Close and open Deyslide to try again. Until then, new projects are saved on this device.'
      return
    }
    await this.moveBrowserProjects(cloud)
    const previous = this.stores.value.cloud
    this.stores.value = { ...this.withoutAccount(), cloud }
    this.primary.value = cloud
    await closeStore(previous)
  }

  private withoutAccount(): WorkspaceStores {
    return { ...(this.local ? { local: this.local } : {}), ...(this.guest ? { guest: this.guest } : {}) }
  }

  private async signedOut() {
    const previous = this.stores.value.cloud
    this.stores.value = this.withoutAccount()
    this.primary.value = (this.guest ?? this.local)!
    // The account's decks stop syncing in this page, and their copies close.
    await closeStore(previous)
  }

  private async moveBrowserProjects(cloud: CloudStore) {
    // Offline, the account's projects come from this device: moving waits for the next sign in.
    if (!this.guest || this.guest.listProjects().length === 0 || cloud.offline.value)
      return
    try {
      const projects = await this.guest.exportProjects()
      await cloud.importProjects(projects)
      await this.guest.clear()
      this.notice.value = `Moved ${plural(projects.length, 'project')} from this browser to your account.`
    }
    catch {
      this.notice.value = 'Your projects in this browser could not be moved to your account yet. They are safe, and moving them will be tried again the next time you sign in.'
    }
  }
}
