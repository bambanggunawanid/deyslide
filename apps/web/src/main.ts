import type { GuestStorage } from './guest/types'
import { createApp } from 'vue'
import { createWebHistory } from 'vue-router'
import App from './App.vue'
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
const store = await GuestStore.open(storage)

createApp(App)
  .provide(GUEST_STORE_KEY, store)
  .use(createAppRouter(createWebHistory()))
  .mount('#app')
