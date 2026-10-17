import type { GuestStorage } from './guest/types'
import { createApp } from 'vue'
import { followAppAccount } from './account/app'
import { followRememberedAccount } from './account/remembered'
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
import { startUpdates, UPDATES_KEY } from './platform/updates'
import { EXPORT_KEY, HttpExportApi } from './present/exports'
import { HttpProjectApi } from './projects/api'
import { OfflineCache } from './projects/offline-cache'
import { IndexedDbOfflineStorage, MemoryOfflineStorage } from './projects/offline-storage'
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

// Account decks and project lists kept on this device (the website and the
// apps alike), so they open and change offline. Signing out deletes them.
const offline = new OfflineCache(typeof indexedDB === 'undefined' ? new MemoryOfflineStorage() : new IndexedDbOfflineStorage())

const { account, workspace } = await startSession({
  service: await createAccountService(),
  guest: local ? undefined : await GuestStore.open(browserStorage()),
  local,
  api: new HttpProjectApi(apiFetch, { collabUrl }),
  collabToken,
  offline,
})
const router = createAppRouter(routerHistory(), () => account.account.value)
// Renaming a device project or deck changes its id: the page follows it.
if (device && local)
  device.followMoves(local, router)
// The app signs in and out outside the page: in the browser, or when the server ends a sign in.
if (isApp())
  await followAppAccount(account, router)
// The website shows the person signed in last while the server does not answer, and asks again later.
else
  followRememberedAccount(account, router)

/** The main window of the app on a computer. Audience windows only show slides. */
const mainWindow = isDesktopApp() && await windowLabel().then(label => label === MAIN_WINDOW, () => false)

// New versions: checked in the app's one window on a phone, or its main
// window on a computer. Installing one saves every open deck first.
async function offerUpdates() {
  if (!local || (isDesktopApp() && !mainWindow))
    return undefined
  const { storesToSave } = await import('./platform/closing')
  return startUpdates(() => storesToSave(workspace))
}
const updates = await offerUpdates().catch((error) => {
  console.error('Deyslide cannot check for updates:', error)
  return undefined
})

const vue = createApp(App)
  .provide(WORKSPACE_KEY, workspace)
  .provide(ACCOUNT_KEY, account)
  .provide(ASSISTANT_KEY, new HttpAssistantApi())
  .provide(EXPORT_KEY, new HttpExportApi())
if (updates)
  vue.provide(UPDATES_KEY, updates)
vue.use(router).mount('#app')

// Device decks are written a moment after each change, and account decks
// wait for the server to confirm theirs: leaving the app or closing the
// window it edits them in saves what still waits first.
async function saveOnLeaving() {
  if (!local)
    return
  const { saveBeforeClosing, saveWhenHidden, storesToSave } = await import('./platform/closing')
  const stores = () => storesToSave(workspace)
  saveWhenHidden(stores)
  if (mainWindow)
    await saveBeforeClosing(stores)
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
