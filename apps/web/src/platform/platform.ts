import { createWebHashHistory, createWebHistory } from 'vue-router'
import { appInfo, authAccessToken, emitPresentSync, onPresentSync, presentOpen, saveFile as saveToPath } from './native'

/**
 * What differs between the website and the Deyslide app, which shows the
 * same pages built with `vite build --mode app`. On the website the API is
 * the page's own origin and the session cookie signs requests. Inside the
 * app the pages are bundled files, so the API is the server named in its
 * settings, reached through the http plugin with an access token. Pages
 * ask here rather than checking where they run.
 */

/** The server the app talks to when it cannot say which one its settings name. */
const DEFAULT_SERVER_URL = import.meta.env.VITE_SERVER_URL || 'https://deyslide.bambanggunawan.id'

interface AppDetails {
  android: boolean
  /** Without a trailing slash. */
  serverUrl: string
}

let details: AppDetails | undefined

/** True inside the Deyslide app. */
export function isApp() {
  return import.meta.env.VITE_APP === '1'
}

function guessedDetails(): AppDetails {
  return { android: /android/i.test(navigator.userAgent), serverUrl: DEFAULT_SERVER_URL }
}

function app() {
  return details ?? guessedDetails()
}

/**
 * Asks the app which system it runs on and which server it uses. Call it
 * once before anything else. A browser has nothing to ask.
 */
export async function startPlatform() {
  if (!isApp())
    return
  try {
    const info = await appInfo()
    details = { android: info.platform === 'android', serverUrl: info.serverUrl.replace(/\/+$/, '') }
  }
  catch {
    details = guessedDetails()
  }
}

/** True inside the app on Windows, macOS or Linux. */
export function isDesktopApp() {
  return isApp() && !app().android
}

/** True inside the app on Android. */
export function isAndroidApp() {
  return isApp() && app().android
}

/** What API paths start with: nothing on the website (the same origin), the server in the app. */
export function apiBase() {
  return isApp() ? app().serverUrl : ''
}

/**
 * The router's history. The app loads its pages from bundled files, so the
 * route lives in the URL's hash: a reload must not ask for a route as a file.
 */
export function routerHistory() {
  return isApp() ? createWebHashHistory() : createWebHistory()
}

/** The app's access token, or undefined when nobody is signed in. */
async function accessToken() {
  try {
    return await authAccessToken()
  }
  catch {
    return undefined
  }
}

/**
 * Where a request goes in the app. Paths, also those a `Request` resolved
 * against the page's own address, go to the server; other URLs stay.
 */
function onServer(url: string) {
  const target = new URL(url, window.location.href)
  const page = window.location
  return target.protocol === page.protocol && target.host === page.host
    ? `${apiBase()}${target.pathname}${target.search}`
    : target.href
}

/**
 * `fetch` for the Deyslide API, given a path such as `/api/projects`. The
 * website sends the session cookie. The app sends the request to its server
 * through the http plugin, with an access token when someone is signed in.
 * Bodies are small JSON: media files go straight to storage with the
 * page's own `fetch`.
 */
export async function apiFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  if (!isApp())
    return fetch(input, { credentials: 'same-origin', ...init })
  const [{ fetch: appFetch }, token] = await Promise.all([import('@tauri-apps/plugin-http'), accessToken()])
  let url: string
  let options: RequestInit
  if (input instanceof Request) {
    // A Request carries its method, headers and body; `init` overrides them, as with fetch.
    const request = new Request(input, init)
    url = request.url
    options = {
      method: request.method,
      headers: request.headers,
      body: request.method === 'GET' || request.method === 'HEAD' ? undefined : await request.arrayBuffer(),
      signal: request.signal,
    }
  }
  else {
    url = input instanceof URL ? input.href : input
    options = { ...init }
  }
  const headers = new Headers(options.headers)
  if (token)
    headers.set('authorization', `Bearer ${token}`)
  return appFetch(onServer(url), { ...options, headers })
}

/** The live editing WebSocket: `wss://` for an https server, `ws://` for http. */
export function collabUrl() {
  const origin = isApp() ? apiBase() : window.location.origin
  return `${origin.replace(/^http/, 'ws')}/api/collab`
}

/**
 * What live editing signs in with: on the website the literal `cookie`,
 * which tells the server to read the session cookie, in the app an access
 * token (asked for on every connection, so it is always fresh).
 */
export async function collabToken(): Promise<string> {
  return isApp() ? authAccessToken() : 'cookie'
}

/** Opens a link in the system browser, or a new tab on the website. */
export async function openExternal(url: string) {
  if (!isApp()) {
    window.open(url, '_blank', 'noopener')
    return
  }
  const { openUrl } = await import('@tauri-apps/plugin-opener')
  await openUrl(url)
}

function download(name: string, bytes: Uint8Array, mime: string) {
  const url = URL.createObjectURL(new Blob([bytes.slice()], { type: mime }))
  const link = document.createElement('a')
  link.href = url
  link.download = name
  link.click()
  // The browser has the file by the next task.
  setTimeout(() => URL.revokeObjectURL(url))
}

/**
 * Saves a file the page made, such as an exported PDF. The website
 * downloads it; the app asks the person where to put it. Resolves with
 * false when they cancel.
 */
export async function saveFile(name: string, bytes: Uint8Array, mime: string): Promise<boolean> {
  if (!isApp()) {
    download(name, bytes, mime)
    return true
  }
  const { save } = await import('@tauri-apps/plugin-dialog')
  const android = isAndroidApp()
  const extension = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1) : ''
  // Android's picker filters by media type, a computer's by extension.
  const filters = android
    ? [{ name, extensions: [mime] }]
    : extension ? [{ name: extension.toUpperCase(), extensions: [extension] }] : []
  const path = await save({ defaultPath: name, filters })
  if (!path)
    return false
  if (android) {
    // The picker answers with a content URI, which the fs plugin writes through Android.
    const { writeFile } = await import('@tauri-apps/plugin-fs')
    await writeFile(path, bytes)
  }
  else {
    await saveToPath(path, bytes)
  }
  return true
}

/**
 * How a deck's presenter and audience windows keep in step: what one
 * window posts, the deck's other windows hear. Either window can drive.
 */
export interface PresentChannel<T = unknown> {
  /** Tells the deck's other windows. */
  post: (message: T) => void
  /** Hears the deck's other windows, never this one. Returns a function that stops listening. */
  listen: (handler: (message: T) => void) => () => void
  /** False on Android, where the presenter has no second window. */
  readonly canOpenAudience: boolean
  /**
   * Opens the audience window, or brings it forward when it is open.
   * Resolves with false when there is none: on Android, or when the
   * browser blocked the window.
   */
  openAudience: (target: { projectId: string, deckId: string, url: string }) => Promise<boolean>
  close: () => void
}

/** The name of a deck's audience window in the browser, and of its BroadcastChannel. */
export function presentName(deckId: string) {
  return `deyslide-present:${deckId}`
}

/** Audience windows this page opened, by deck, to bring forward rather than load again. */
const audiences = new Map<string, Window>()

/** Whether a window shows the page at `url`, its query aside. A window that cannot be read does not. */
function showsPage(open: Window, url: string) {
  try {
    const wanted = new URL(url, window.location.href)
    return open.location.origin === wanted.origin && open.location.pathname === wanted.pathname
  }
  catch {
    return false
  }
}

function browserChannel<T>(deckId: string): PresentChannel<T> {
  const channel = typeof BroadcastChannel === 'undefined' ? undefined : new BroadcastChannel(presentName(deckId))
  return {
    post: message => channel?.postMessage(message),
    listen(handler) {
      const hear = (event: MessageEvent<T>) => handler(event.data)
      channel?.addEventListener('message', hear)
      return () => channel?.removeEventListener('message', hear)
    },
    canOpenAudience: true,
    async openAudience({ deckId: id, url }) {
      let open = audiences.get(id)
      if (!open || open.closed) {
        // An empty address finds the deck's audience window when one is open,
        // as after this page reloads, without loading it again: it keeps its
        // place and stays full screen. Otherwise it opens a blank one.
        open = window.open('', presentName(id), 'popup,width=1280,height=720') ?? undefined
        if (!open)
          return false
        audiences.set(id, open)
      }
      // A new window, or one that went to another page (Escape in it once opened the editor), shows the talk.
      if (!showsPage(open, url))
        open.location.href = url
      open.focus()
      return true
    },
    close: () => channel?.close(),
  }
}

function appChannel<T>(deckId: string): PresentChannel<T> {
  const stops = new Set<() => void>()
  return {
    post: message => void emitPresentSync({ deckId, message }),
    listen(handler) {
      let stopped = false
      let unlisten: (() => void) | undefined
      void onPresentSync<T>((event) => {
        if (event.deckId === deckId)
          handler(event.message)
      }).then((stop) => {
        if (stopped)
          stop()
        else
          unlisten = stop
      })
      const stop = () => {
        stopped = true
        unlisten?.()
        stops.delete(stop)
      }
      stops.add(stop)
      return stop
    },
    canOpenAudience: true,
    async openAudience({ projectId, deckId: id }) {
      await presentOpen(projectId, id)
      return true
    },
    close() {
      for (const stop of [...stops])
        stop()
    },
  }
}

/** Android has one window: the presenter view is all there is, and nothing travels. */
function singleWindowChannel<T>(): PresentChannel<T> {
  return {
    post: () => {},
    listen: () => () => {},
    canOpenAudience: false,
    openAudience: async () => false,
    close: () => {},
  }
}

/**
 * The channel between a deck's presenter and audience windows: in the
 * browser `window.open` and a BroadcastChannel; in the app on a computer
 * the `present_open` command and `present-sync` events; on Android a
 * single window.
 */
export function presentChannel<T = unknown>(deckId: string): PresentChannel<T> {
  if (isAndroidApp())
    return singleWindowChannel()
  return isDesktopApp() ? appChannel(deckId) : browserChannel(deckId)
}

/** Whether this window is a deck's audience window, opened by its presenter view. */
export async function isAudienceWindow(deckId: string): Promise<boolean> {
  if (isAndroidApp())
    return false
  if (isDesktopApp()) {
    const { getCurrentWebviewWindow } = await import('@tauri-apps/api/webviewWindow')
    return getCurrentWebviewWindow().label.startsWith('present-')
  }
  return window.name === presentName(deckId)
}

/**
 * Leaving the talk in a deck's audience window: the browser closes the
 * window the presenter view opened, and the app keeps the window on the
 * talk (people close it from its title bar), rather than open the editor
 * in it. Resolves with false in any other window, which goes to the editor.
 */
export async function leaveAudienceWindow(deckId: string): Promise<boolean> {
  if (!(await isAudienceWindow(deckId)))
    return false
  if (!isApp())
    window.close()
  return true
}

/** True while the page (the website) or the window (the app) fills the screen. */
export async function isFullscreen(): Promise<boolean> {
  if (isDesktopApp()) {
    const { getCurrentWindow } = await import('@tauri-apps/api/window')
    return getCurrentWindow().isFullscreen()
  }
  return Boolean(document.fullscreenElement)
}

/** Fills the screen, or stops filling it. The app sets its window full screen, the website the page. */
export async function setFullscreen(on: boolean) {
  if (isDesktopApp()) {
    const { getCurrentWindow } = await import('@tauri-apps/api/window')
    await getCurrentWindow().setFullscreen(on)
    return
  }
  if (on && !document.fullscreenElement)
    await document.documentElement.requestFullscreen?.()
  else if (!on && document.fullscreenElement)
    await document.exitFullscreen?.()
}
