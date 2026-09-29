import type { ShallowRef } from 'vue'
import type { Account } from '../account/types'
import type { GuestStore } from '../guest/store'
import type { CloudStore } from './cloud-store'
import type { ProjectStore } from './types'
import { shallowRef } from 'vue'
import { plural } from '../format'

/**
 * Chooses where projects live: the browser for guests, the account for
 * signed in people. Signing in moves the browser's projects into the account.
 */
export class Workspace {
  readonly store: ShallowRef<ProjectStore>
  /** A one time message about moving browser projects, shown on the home page. */
  readonly notice = shallowRef('')
  private readonly guest: GuestStore
  private readonly openCloud: () => Promise<CloudStore>

  constructor(guest: GuestStore, openCloud: () => Promise<CloudStore>) {
    this.guest = guest
    this.openCloud = openCloud
    this.store = shallowRef<ProjectStore>(guest)
  }

  async useAccount(account: Account | undefined) {
    this.notice.value = ''
    if (!account) {
      this.store.value = this.guest
      return
    }
    let cloud: CloudStore
    try {
      cloud = await this.openCloud()
    }
    catch {
      this.store.value = this.guest
      this.notice.value = 'Your account\'s projects could not be loaded. Reload the page to try again. Until then, new projects stay in this browser.'
      return
    }
    await this.moveBrowserProjects(cloud)
    this.store.value = cloud
  }

  private async moveBrowserProjects(cloud: CloudStore) {
    if (this.guest.listProjects().length === 0)
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
