import type { GuestStorage } from './guest/types'
import { createApp } from 'vue'
import { createWebHistory } from 'vue-router'
import { BetterAuthAccountService } from './account/better-auth'
import App from './App.vue'
import { ACCOUNT_KEY } from './composables/useAccount'
import { WORKSPACE_KEY } from './composables/useProjects'
import { IndexedDbGuestStorage } from './guest/indexeddb-storage'
import { MemoryGuestStorage } from './guest/memory-storage'
import { GuestStore } from './guest/store'
import { HttpProjectApi } from './projects/api'
import { createAppRouter } from './router'
import { startSession } from './session'
import '@unocss/reset/tailwind.css'
import 'virtual:uno.css'

// Private windows in some browsers block IndexedDB. Work still functions
// there, it just lasts until the tab closes.
const storage: GuestStorage = typeof indexedDB === 'undefined' ? new MemoryGuestStorage() : new IndexedDbGuestStorage()
const { account, workspace } = await startSession({
  service: new BetterAuthAccountService(),
  guest: await GuestStore.open(storage),
  api: new HttpProjectApi(),
})

createApp(App)
  .provide(WORKSPACE_KEY, workspace)
  .provide(ACCOUNT_KEY, account)
  .use(createAppRouter(createWebHistory(), () => account.account.value))
  .mount('#app')
