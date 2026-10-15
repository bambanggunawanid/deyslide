import type { GuestStorage } from './guest/types'
import { createApp } from 'vue'
import { followAppAccount } from './account/app'
import { createAccountService } from './account/service'
import App from './App.vue'
import { HttpAssistantApi } from './assistant/api'
import { ACCOUNT_KEY } from './composables/useAccount'
import { ASSISTANT_KEY } from './composables/useAssistant'
import { WORKSPACE_KEY } from './composables/useProjects'
import { IndexedDbGuestStorage } from './guest/indexeddb-storage'
import { MemoryGuestStorage } from './guest/memory-storage'
import { GuestStore } from './guest/store'
import { apiFetch, collabToken, collabUrl, isApp, routerHistory, startPlatform } from './platform/platform'
import { HttpProjectApi } from './projects/api'
import { createAppRouter } from './router'
import { startSession } from './session'
import '@unocss/reset/tailwind.css'
import 'virtual:uno.css'

// Inside the Deyslide app: which system it runs on and which server it uses.
await startPlatform()

// Private windows in some browsers block IndexedDB. Work still functions
// there, it just lasts until the tab closes.
const storage: GuestStorage = typeof indexedDB === 'undefined' ? new MemoryGuestStorage() : new IndexedDbGuestStorage()
const { account, workspace } = await startSession({
  service: await createAccountService(),
  guest: await GuestStore.open(storage),
  api: new HttpProjectApi(apiFetch, { collabUrl }),
  collabToken,
})
const router = createAppRouter(routerHistory(), () => account.account.value)
// The app signs in and out outside the page: in the browser, or when the server ends a sign in.
if (isApp())
  await followAppAccount(account, router)

createApp(App)
  .provide(WORKSPACE_KEY, workspace)
  .provide(ACCOUNT_KEY, account)
  .provide(ASSISTANT_KEY, new HttpAssistantApi())
  .use(router)
  .mount('#app')
