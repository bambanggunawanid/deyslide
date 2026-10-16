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
import { MAIN_WINDOW, windowLabel } from './platform/native'
import { apiFetch, collabToken, collabUrl, isApp, isDesktopApp, routerHistory, startPlatform } from './platform/platform'
import { EXPORT_KEY, HttpExportApi } from './present/exports'
import { HttpProjectApi } from './projects/api'
import { createAppRouter } from './router'
import { startSession } from './session'
import '@unocss/reset/tailwind.css'
import 'virtual:uno.css'

// Inside the Deyslide app: which system it runs on and which server it uses.
await startPlatform()

// The app keeps decks as files on the device, which signing in never moves.
const device = isApp() ? await import('./projects/local-store') : undefined
const local = await device?.LocalStore.open()

// The website keeps a guest's projects in the browser. Private windows in
// some browsers block IndexedDB. Work still functions there, it just lasts
// until the tab closes.
function browserStorage(): GuestStorage {
  return typeof indexedDB === 'undefined' ? new MemoryGuestStorage() : new IndexedDbGuestStorage()
}

const { account, workspace } = await startSession({
  service: await createAccountService(),
  guest: local ? undefined : await GuestStore.open(browserStorage()),
  local,
  api: new HttpProjectApi(apiFetch, { collabUrl }),
  collabToken,
})
const router = createAppRouter(routerHistory(), () => account.account.value)
// Renaming a device project or deck changes its id: the page follows it.
if (device && local)
  device.followMoves(local, router)
// The app signs in and out outside the page: in the browser, or when the server ends a sign in.
if (isApp())
  await followAppAccount(account, router)

createApp(App)
  .provide(WORKSPACE_KEY, workspace)
  .provide(ACCOUNT_KEY, account)
  .provide(ASSISTANT_KEY, new HttpAssistantApi())
  .provide(EXPORT_KEY, new HttpExportApi())
  .use(router)
  .mount('#app')

/** The main window of the app on a computer. Audience windows only show slides. */
const mainWindow = isDesktopApp() && await windowLabel().then(label => label === MAIN_WINDOW, () => false)

// Device decks are written a moment after each change: leaving the app or
// closing the window it edits them in writes what still waits first.
async function saveOnLeaving() {
  if (!local)
    return
  const { saveBeforeClosing, saveWhenHidden } = await import('./platform/closing')
  saveWhenHidden(local)
  if (mainWindow)
    await saveBeforeClosing(local)
}
await saveOnLeaving().catch((error) => {
  console.error('Deyslide cannot save changes before closing:', error)
})

// Claude Code asks the app on a computer for slide images, which the main window draws.
async function drawForClaudeCode() {
  if (!mainWindow)
    return
  const { startRenderBridge } = await import('./platform/render-bridge')
  await startRenderBridge()
}
await drawForClaudeCode().catch((error) => {
  console.error('Deyslide cannot draw slides for Claude Code:', error)
})
