import type { AccountState } from './composables/useAccount'
import type { GuestStorage } from './guest/types'
import { createApp, shallowRef } from 'vue'
import { createWebHistory } from 'vue-router'
import { BetterAuthAccountService } from './account/better-auth'
import App from './App.vue'
import { ACCOUNT_KEY } from './composables/useAccount'
import { GUEST_STORE_KEY } from './composables/useGuestStore'
import { IndexedDbGuestStorage } from './guest/indexeddb-storage'
import { MemoryGuestStorage } from './guest/memory-storage'
import { GuestStore } from './guest/store'
import { createAppRouter } from './router'
import '@unocss/reset/tailwind.css'
import 'virtual:uno.css'

// Private windows in some browsers block IndexedDB. Work still functions
// there, it just lasts until the tab closes.
const storage: GuestStorage = typeof indexedDB === 'undefined' ? new MemoryGuestStorage() : new IndexedDbGuestStorage()
const service = new BetterAuthAccountService()
const [store, options, current] = await Promise.all([GuestStore.open(storage), service.options(), service.current()])
const account: AccountState = { service, options, account: shallowRef(current) }

createApp(App)
  .provide(GUEST_STORE_KEY, store)
  .provide(ACCOUNT_KEY, account)
  .use(createAppRouter(createWebHistory(), () => account.account.value))
  .mount('#app')
