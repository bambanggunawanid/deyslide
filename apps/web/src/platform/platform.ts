import { createWebHashHistory, createWebHistory } from 'vue-router'
import { appInfo, authAccessToken, saveFile as saveToPath } from './native'

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
