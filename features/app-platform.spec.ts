import type { AppAccount, AppPlatform } from '../apps/web/src/platform/native'
import type { WebApp } from './support/web'
import { resolve } from 'node:path'
import { describeFeature, loadFeature } from '@amiceli/vitest-cucumber'
import { expect, vi } from 'vitest'
import { AppAccountService, followAppAccount } from '../apps/web/src/account/app'
import { BetterAuthAccountService } from '../apps/web/src/account/better-auth'
import { createAccountService } from '../apps/web/src/account/service'
import { HttpAssistantApi } from '../apps/web/src/assistant/api'
import { GuestStore } from '../apps/web/src/guest/store'
import { MemoryGuestStorage } from '../apps/web/src/guest/memory-storage'
import { apiBase, apiFetch, collabToken, collabUrl, isApp, openExternal, routerHistory, saveFile, startPlatform } from '../apps/web/src/platform/platform'
import { LATEST_RELEASE_API, RELEASES_PAGE } from '../apps/web/src/platform/releases'
import { HttpProjectApi } from '../apps/web/src/projects/api'
import { CloudStore } from '../apps/web/src/projects/cloud-store'
import { FakeProjectApi } from './support/project-api'
import { find, findAll, mountWebApp, pageText, text } from './support/web'

interface FakeListener {
  event: string
  handler: (event: { event: string, id: number, payload: unknown }) => void
}

// A stand in for the Deyslide app: its commands, its events and its plugins.
const fake = vi.hoisted(() => ({
  invoke: vi.fn(),
  listeners: [] as FakeListener[],
  httpFetch: vi.fn(),
  save: vi.fn(),
  writeFile: vi.fn(),
  openUrl: vi.fn(),
  createAuthClient: vi.fn(() => ({})),
}))

vi.mock('@tauri-apps/api/core', () => ({ invoke: fake.invoke }))

vi.mock('@tauri-apps/api/event', () => ({
  listen: async (event: string, handler: FakeListener['handler']) => {
    const listener = { event, handler }
    fake.listeners.push(listener)
    return () => {
      fake.listeners.splice(fake.listeners.indexOf(listener), 1)
    }
  },
}))

// The plugins are dependencies of apps/web only, so they are mocked by the
// file the pages load, which a bare name here would not reach.
vi.mock('../apps/web/node_modules/@tauri-apps/plugin-http/dist-js/index.js', () => ({ fetch: fake.httpFetch }))
vi.mock('../apps/web/node_modules/@tauri-apps/plugin-dialog/dist-js/index.js', () => ({ save: fake.save }))
vi.mock('../apps/web/node_modules/@tauri-apps/plugin-fs/dist-js/index.js', () => ({ writeFile: fake.writeFile }))
vi.mock('../apps/web/node_modules/@tauri-apps/plugin-opener/dist-js/index.js', () => ({ openUrl: fake.openUrl }))
vi.mock('better-auth/client', () => ({ createAuthClient: fake.createAuthClient }))

const feature = await loadFeature('./app-platform.feature')

const SERVER = 'https://deyslide.bambanggunawan.id'
const ANA: AppAccount = { id: 'user-ana', name: 'Ana', email: 'ana@example.com' }
const PDF_BYTES = new Uint8Array([37, 80, 68, 70, 45])
const RELEASE_FILES = [
  'Deyslide_0.2.0_x64-setup.exe',
  'Deyslide_0.2.0_x64_en-US.msi',
  'Deyslide_0.2.0_universal.dmg',
  'Deyslide_0.2.0_amd64.AppImage',
  'Deyslide_0.2.0_amd64.deb',
  'Deyslide_0.2.0_android.apk',
]
const fileLink = (name: string) => `https://github.com/bambanggunawanid/deyslide/releases/download/v0.2.0/${name}`

const happyDom = () => (window as unknown as { happyDOM: { setURL: (url: string) => void } }).happyDOM
const startUrl = window.location.href

/** What the fake app knows. */
interface AppState {
  /** Undefined when `app_info` fails. */
  platform?: AppPlatform
  serverUrl: string
  token?: string
  account: AppAccount | null
  /** Who the browser signs in as on a computer. Nobody: the person closed the browser tab. */
  signsInAs?: AppAccount
  /** How the app's server answers when the app holds a sign in. */
  server: 'up' | 'unreachable' | 'silent'
  /** Runs right after the page asks for the account, before it hears the answer. */
  afterAccountRead?: () => void
}

describeFeature(feature, ({ Scenario, ScenarioOutline, BeforeEachScenario, AfterEachScenario }) => {
  let app: AppState
  let github: 'up' | 'down'
  let releaseFiles: string[]
  let mainStarts = 0
  let browserFetch: ReturnType<typeof vi.fn>
  let web: WebApp | undefined
  let stopFollowing: (() => void) | undefined
  let saved: boolean | undefined

  function emit(event: string) {
    for (const listener of fake.listeners.filter(listener => listener.event === event))
      listener.handler({ event, id: 1, payload: null })
  }

  BeforeEachScenario(() => {
    app = { serverUrl: SERVER, account: null, server: 'up' }
    github = 'down'
    releaseFiles = RELEASE_FILES
    saved = undefined
    fake.listeners.length = 0
    for (const mock of [fake.httpFetch, fake.save, fake.writeFile, fake.openUrl, fake.createAuthClient])
      mock.mockClear()
    fake.invoke.mockReset()
    fake.invoke.mockImplementation(async (command: string) => {
      switch (command) {
        case 'app_info':
          if (!app.platform)
            throw new Error('app_info is not available')
          return { version: '0.2.0', platform: app.platform, serverUrl: app.serverUrl }
        case 'auth_access_token':
          if (!app.token)
            throw 'You are signed out.'
          return app.token
        case 'auth_account': {
          // Signed out needs no server; a sign in is checked with it.
          if (app.token && app.server === 'unreachable')
            throw `Deyslide could not reach ${app.serverUrl}. Check your connection.`
          if (app.token && app.server === 'silent')
            return new Promise(() => {})
          const answer = app.account
          app.afterAccountRead?.()
          app.afterAccountRead = undefined
          return answer
        }
        case 'auth_sign_in':
          // Android returns as soon as the browser opens; a computer once the browser is done.
          if (app.platform === 'android')
            return undefined
          if (!app.signsInAs)
            return new Promise(() => {})
          app.account = app.signsInAs
          app.token = 'token-1'
          emit('account-changed')
          return undefined
        case 'auth_sign_out':
          app.account = null
          app.token = undefined
          emit('account-changed')
          return undefined
        case 'save_file':
          return undefined
      }
      throw new Error(`The fake app has no command ${command}`)
    })
    // Lists are empty, everything else answers an empty object.
    fake.httpFetch.mockImplementation(async (url: string) => {
      const list = url.endsWith('/api/projects') || url.endsWith('/api/shared')
      return new Response(list ? '[]' : '{}', { status: 200, headers: { 'content-type': 'application/json' } })
    })
    browserFetch = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) !== LATEST_RELEASE_API)
        return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
      if (github === 'down')
        throw new TypeError('Failed to fetch')
      const release = { tag_name: 'v0.2.0', assets: releaseFiles.map(name => ({ name, browser_download_url: fileLink(name) })) }
      return new Response(JSON.stringify(release), { status: 200, headers: { 'content-type': 'application/json' } })
    })
    vi.stubGlobal('fetch', browserFetch)
  })

  AfterEachScenario(async () => {
    stopFollowing?.()
    stopFollowing = undefined
    web?.unmount()
    web = undefined
    // The pages main.ts started, as the app shows them.
    const root = document.querySelector('#app') as (HTMLElement & { __vue_app__?: { unmount: () => void } }) | null
    root?.__vue_app__?.unmount()
    root?.remove()
    const { clearMocks } = await import('@tauri-apps/api/mocks')
    clearMocks()
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    happyDom().setURL(startUrl)
  })

  async function inApp(platform: AppPlatform | undefined, serverUrl = SERVER) {
    vi.stubEnv('VITE_APP', '1')
    app.platform = platform
    app.serverUrl = serverUrl
    await startPlatform()
  }

  async function signedIn(account: AppAccount) {
    app.account = account
    app.token = 'token-1'
  }

  /** Opens a page the way main.ts would, with the app's account service in the app. */
  async function open(path: string, { wait, api, guest }: { wait?: number, api?: FakeProjectApi, guest?: GuestStore } = {}) {
    // Deck pages open in the Markdown view, where these scenarios type.
    web = await mountWebApp({ path, service: isApp() ? new AppAccountService({ wait }) : undefined, api, guest, view: 'markdown' })
    if (isApp())
      stopFollowing = await followAppAccount(web.account, web.router)
  }

  /** Runs the web app's own entry, main.ts, on a fresh `#app` element. */
  async function startPages() {
    const root = document.createElement('div')
    root.id = 'app'
    document.body.append(root)
    // A new query string makes the entry run again, with the modules it imports shared.
    const entry = `${resolve(import.meta.dirname, '../apps/web/src/main.ts')}?start=${++mainStarts}`
    await import(/* @vite-ignore */ entry)
  }

  /** Types a slide at the end of the open deck, in the editor double. */
  async function typeSlide(title: string) {
    const editor = await web!.waitFor('[data-testid="markdown-editor"]') as HTMLTextAreaElement
    await vi.waitFor(() => expect(editor.value).toContain('# Intro'))
    editor.value = `${editor.value}\n---\n\n# ${title}\n`
    editor.dispatchEvent(new Event('input'))
    await web!.settle()
  }

  /** The Markdown of a deck in the account, by its name. */
  async function accountDeck(api: FakeProjectApi, name: string) {
    const deck = api.projects.flatMap(project => project.decks).find(item => item.name === name)
    expect(deck, `no deck ${name} in the account`).toBeDefined()
    return (await CloudStore.open(api)).deckMarkdown(deck!.id)
  }

  /** The last request the page made, through the http plugin or the browser. */
  function lastRequest() {
    const calls = fake.httpFetch.mock.calls.length ? fake.httpFetch.mock.calls : browserFetch.mock.calls
    const [input, init] = calls.at(-1) as [string, RequestInit | undefined]
    return { url: input, init, headers: new Headers(init?.headers) }
  }

  /** Where the scenarios run, by the words they use. */
  const PLACES: Record<string, () => Promise<void>> = {
    'the website': async () => {},
    'the app on a computer, signed out': () => inApp('linux'),
    [`the app on a computer, using the server "${SERVER}"`]: () => inApp('linux'),
  }

  Scenario('The website calls the API on its own origin', ({ Given, When, Then, And }) => {
    Given('the website', () => {
      expect(isApp()).toBe(false)
    })
    When('a page asks the API for "/api/projects"', async () => {
      await apiFetch('/api/projects')
    })
    Then('the browser fetches "/api/projects" with the session cookie', () => {
      expect(fake.httpFetch).not.toHaveBeenCalled()
      expect(lastRequest().url).toBe('/api/projects')
      expect(lastRequest().init?.credentials).toBe('same-origin')
    })
    And('the request has no access token', () => {
      expect(lastRequest().headers.has('authorization')).toBe(false)
    })
  })

  Scenario('The app calls its server with an access token', ({ Given, And, When, Then }) => {
    Given(`the app on a computer, using the server "${SERVER}"`, () => inApp('linux'))
    And('the app is signed in with the access token "token-1"', () => signedIn(ANA))
    When('a page asks the API for "/api/projects"', async () => {
      await apiFetch('/api/projects')
    })
    Then(`the http plugin fetches "${SERVER}/api/projects"`, () => {
      expect(browserFetch).not.toHaveBeenCalled()
      expect(lastRequest().url).toBe(`${SERVER}/api/projects`)
    })
    And('the request carries "Bearer token-1"', () => {
      expect(lastRequest().headers.get('authorization')).toBe('Bearer token-1')
    })
  })

  Scenario('The app calls its server without a token when nobody is signed in', ({ Given, And, When, Then }) => {
    Given(`the app on a computer, using the server "${SERVER}"`, () => inApp('linux'))
    And('nobody is signed in to the app', () => {
      app.account = null
      app.token = undefined
    })
    When('a page asks the API for "/api/config"', async () => {
      await apiFetch('/api/config')
    })
    Then(`the http plugin fetches "${SERVER}/api/config"`, () => {
      expect(lastRequest().url).toBe(`${SERVER}/api/config`)
    })
    And('the request has no access token', () => {
      expect(lastRequest().headers.has('authorization')).toBe(false)
    })
  })

  Scenario('The app sends a whole request to its server', ({ Given, And, When, Then }) => {
    Given(`the app on a computer, using the server "${SERVER}"`, () => inApp('linux'))
    And('the app is signed in with the access token "token-1"', () => signedIn(ANA))
    When('a page sends a request to "/api/projects" that creates the project "Talks"', async () => {
      await apiFetch(new Request('/api/projects', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Talks' }),
      }))
    })
    Then(`the http plugin fetches "${SERVER}/api/projects"`, () => {
      expect(browserFetch).not.toHaveBeenCalled()
      expect(lastRequest().url).toBe(`${SERVER}/api/projects`)
    })
    And('the request is a "POST" of the JSON {"name":"Talks"}', () => {
      const { init, headers } = lastRequest()
      expect(init?.method).toBe('POST')
      expect(headers.get('content-type')).toBe('application/json')
      expect(new TextDecoder().decode(init?.body as ArrayBuffer)).toBe('{"name":"Talks"}')
    })
    And('the request carries "Bearer token-1"', () => {
      expect(lastRequest().headers.get('authorization')).toBe('Bearer token-1')
    })
  })

  Scenario('The app frees an answer that has no body', ({ Given, When, Then }) => {
    const commands: { command: string, args: unknown }[] = []
    let response: Response | undefined
    Given('the app\'s http plugin', async () => {
      // The real plugin, over a fake of the app's side of its commands.
      const { mockIPC } = await import('@tauri-apps/api/mocks')
      mockIPC((command, args) => {
        commands.push({ command, args })
        switch (command) {
          case 'plugin:http|fetch':
            return 7
          case 'plugin:http|fetch_send':
            return { status: 204, statusText: 'No Content', url: `${SERVER}/api/decks/d1`, headers: [], rid: 8 }
          case 'plugin:http|fetch_cancel_body':
            return null
        }
        throw new Error(`The fake app has no command ${command}`)
      })
    })
    When('the server answers a request with "204 No Content"', async () => {
      const plugin = await vi.importActual<{ fetch: typeof fetch }>('../apps/web/node_modules/@tauri-apps/plugin-http/dist-js/index.js')
      response = await plugin.fetch(`${SERVER}/api/decks/d1`, { method: 'DELETE' })
    })
    Then('the plugin frees that answer in the app at once', async () => {
      expect(response?.status).toBe(204)
      expect(response?.body).toBeNull()
      await vi.waitFor(() => expect(commands).toContainEqual({ command: 'plugin:http|fetch_cancel_body', args: { rid: 8 } }))
    })
  })

  Scenario('The app uses the server its settings name', ({ Given, Then, And }) => {
    Given('the app on a computer, using the server "http://127.0.0.1:3001/"', () => inApp('linux', 'http://127.0.0.1:3001/'))
    Then('API paths start with "http://127.0.0.1:3001"', async () => {
      expect(apiBase()).toBe('http://127.0.0.1:3001')
      await apiFetch('/api/me')
      expect(lastRequest().url).toBe('http://127.0.0.1:3001/api/me')
    })
    And('live editing connects to "ws://127.0.0.1:3001/api/collab"', () => {
      expect(collabUrl()).toBe('ws://127.0.0.1:3001/api/collab')
    })
  })

  Scenario('The app falls back to the server it was built for', ({ Given, Then, And }) => {
    Given('the app cannot say which server it uses', () => inApp(undefined, 'http://nowhere.test'))
    Then(`API paths start with "${SERVER}"`, () => {
      expect(apiBase()).toBe(SERVER)
    })
    And('live editing connects to "wss://deyslide.bambanggunawan.id/api/collab"', () => {
      expect(collabUrl()).toBe('wss://deyslide.bambanggunawan.id/api/collab')
    })
  })

  const CALLS: Record<string, () => Promise<unknown>> = {
    'lists the projects': () => new HttpProjectApi().list(),
    'lists who can open the project "p1"': () => new HttpProjectApi().members({ type: 'project', id: 'p1' }),
    'asks whether the assistant is on': () => new HttpAssistantApi().enabled(),
    'asks how much of the assistant is left': () => new HttpAssistantApi().allowance(),
  }

  ScenarioOutline('Project, sharing and assistant calls go through the app\'s server', ({ Given, And, When, Then }, variables) => {
    Given(`the app on a computer, using the server "${SERVER}"`, () => inApp('linux'))
    And('the app is signed in with the access token "token-1"', () => signedIn(ANA))
    When('a page <call>', async () => {
      const call = CALLS[variables.call]
      expect(call, `no call written for ${variables.call}`).toBeDefined()
      await call!()
    })
    Then(`the http plugin fetches "${SERVER}<path>"`, () => {
      expect(browserFetch).not.toHaveBeenCalled()
      expect(lastRequest().url).toBe(`${SERVER}${variables.path}`)
    })
    And('the request carries "Bearer token-1"', () => {
      expect(lastRequest().headers.get('authorization')).toBe('Bearer token-1')
    })
  })

  Scenario('Live editing on the website signs in with the session cookie', ({ Given, Then, And }) => {
    Given(`the website at "${SERVER}"`, () => {
      happyDom().setURL(`${SERVER}/p/1/d/2`)
    })
    Then('live editing connects to "wss://deyslide.bambanggunawan.id/api/collab"', () => {
      expect(collabUrl()).toBe('wss://deyslide.bambanggunawan.id/api/collab')
    })
    And('live editing signs in with "cookie"', async () => {
      expect(await collabToken()).toBe('cookie')
      expect(fake.invoke).not.toHaveBeenCalled()
    })
  })

  Scenario('Live editing in the app signs in with an access token', ({ Given, And, Then }) => {
    Given(`the app on a computer, using the server "${SERVER}"`, () => inApp('linux'))
    And('the app is signed in with the access token "token-1"', () => signedIn(ANA))
    Then('live editing signs in with "token-1"', async () => {
      expect(await collabToken()).toBe('token-1')
    })
  })

  Scenario('The website downloads a saved file', ({ Given, When, Then, And }) => {
    let blob: Blob | undefined
    let clicked: HTMLAnchorElement | undefined
    Given('the website', () => {
      vi.spyOn(URL, 'createObjectURL').mockImplementation((made) => {
        blob = made as Blob
        return 'blob:deyslide/1'
      })
      vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
      vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
        clicked = this
      })
    })
    When('a page saves "Sorting.pdf" of type "application/pdf"', async () => {
      saved = await saveFile('Sorting.pdf', PDF_BYTES, 'application/pdf')
    })
    Then('the browser downloads "Sorting.pdf" with those bytes and that type', async () => {
      expect(clicked?.download).toBe('Sorting.pdf')
      expect(clicked?.href).toBe('blob:deyslide/1')
      expect(blob?.type).toBe('application/pdf')
      expect(new Uint8Array(await blob!.arrayBuffer())).toEqual(PDF_BYTES)
      expect(fake.invoke).not.toHaveBeenCalled()
    })
    And('the page hears that the file was saved', () => {
      expect(saved).toBe(true)
    })
  })

  Scenario('The app on a computer asks where to save', ({ Given, And, When, Then }) => {
    Given(`the app on a computer, using the server "${SERVER}"`, () => inApp('linux'))
    And('the person picks "/home/ana/Talks/Sorting.pdf" in the save dialog', () => {
      fake.save.mockResolvedValue('/home/ana/Talks/Sorting.pdf')
    })
    When('a page saves "Sorting.pdf" of type "application/pdf"', async () => {
      saved = await saveFile('Sorting.pdf', PDF_BYTES, 'application/pdf')
    })
    Then('the save dialog suggested "Sorting.pdf" among PDF files', () => {
      expect(fake.save).toHaveBeenCalledWith({ defaultPath: 'Sorting.pdf', filters: [{ name: 'PDF', extensions: ['pdf'] }] })
    })
    And('the app gets the command "save_file" for "/home/ana/Talks/Sorting.pdf" with those bytes', () => {
      expect(fake.invoke).toHaveBeenCalledWith('save_file', PDF_BYTES, { headers: { 'x-deyslide-path': encodeURIComponent('/home/ana/Talks/Sorting.pdf') } })
      expect(fake.writeFile).not.toHaveBeenCalled()
    })
    And('the page hears that the file was saved', () => {
      expect(saved).toBe(true)
    })
  })

  Scenario('The app on Android writes to the document the person picked', ({ Given, And, When, Then }) => {
    const picked = 'content://com.android.externalstorage.documents/document/primary%3ADownload%2FSorting.pdf'
    Given('the app on Android', () => inApp('android'))
    And(`the person picks "${picked}" in the save dialog`, () => {
      fake.save.mockResolvedValue(picked)
    })
    When('a page saves "Sorting.pdf" of type "application/pdf"', async () => {
      saved = await saveFile('Sorting.pdf', PDF_BYTES, 'application/pdf')
    })
    Then('the save dialog suggested "Sorting.pdf" among files of type "application/pdf"', () => {
      expect(fake.save).toHaveBeenCalledWith({ defaultPath: 'Sorting.pdf', filters: [{ name: 'Sorting.pdf', extensions: ['application/pdf'] }] })
    })
    And(`the fs plugin writes those bytes to "${picked}"`, () => {
      expect(fake.writeFile).toHaveBeenCalledWith(picked, PDF_BYTES)
    })
    And('the app gets no "save_file" command', () => {
      expect(fake.invoke.mock.calls.map(([command]) => command)).not.toContain('save_file')
    })
    And('the page hears that the file was saved', () => {
      expect(saved).toBe(true)
    })
  })

  Scenario('Cancelling the save dialog saves nothing', ({ Given, And, When, Then }) => {
    Given(`the app on a computer, using the server "${SERVER}"`, () => inApp('linux'))
    And('the person cancels the save dialog', () => {
      fake.save.mockResolvedValue(null)
    })
    When('a page saves "Sorting.pdf" of type "application/pdf"', async () => {
      saved = await saveFile('Sorting.pdf', PDF_BYTES, 'application/pdf')
    })
    Then('nothing is written', () => {
      expect(fake.save).toHaveBeenCalledTimes(1)
      expect(fake.invoke.mock.calls.map(([command]) => command)).not.toContain('save_file')
      expect(fake.writeFile).not.toHaveBeenCalled()
    })
    And('the page hears that the file was not saved', () => {
      expect(saved).toBe(false)
    })
  })

  ScenarioOutline('Links leave for the browser', ({ Given, When, Then }, variables) => {
    const link = 'https://github.com/bambanggunawanid/deyslide'
    let opened: ReturnType<typeof vi.spyOn>
    Given('<where>', async () => {
      opened = vi.spyOn(window, 'open').mockImplementation(() => null)
      await PLACES[variables.where]!()
    })
    When(`a page opens "${link}" outside Deyslide`, async () => {
      await openExternal(link)
    })
    Then('<what opens it>', () => {
      if (variables['what opens it'] === 'a new browser tab opens it') {
        expect(opened).toHaveBeenCalledWith(link, '_blank', 'noopener')
        expect(fake.openUrl).not.toHaveBeenCalled()
      }
      else {
        expect(fake.openUrl).toHaveBeenCalledWith(link)
        expect(opened).not.toHaveBeenCalled()
      }
    })
  })

  Scenario('The app starts on its home page', ({ Given, When, Then, And }) => {
    Given('the app on a computer, signed out', () => inApp('linux'))
    When('the app\'s pages start', () => startPages())
    Then('the page shows "Your projects"', async () => {
      await vi.waitFor(() => expect(pageText()).toContain('Your projects'))
    })
    And('the page address ends in "#/"', () => {
      expect(window.location.hash).toBe('#/')
    })
    And('no Better Auth client was created', () => {
      expect(fake.createAuthClient).not.toHaveBeenCalled()
    })
  })

  Scenario('A sign in that finishes while the app starts is shown', ({ Given, And, When, Then }) => {
    Given('the app on Android, signed out', () => inApp('android'))
    And('the browser hands a sign in as "Ana" back to the app right after the page first asks for the account', () => {
      // An Android cold start from the sign in link: the app finishes it while the page starts.
      app.afterAccountRead = () => {
        app.account = ANA
        app.token = 'token-1'
        emit('account-changed')
      }
    })
    When('the app\'s pages start', () => startPages())
    Then('the header shows the account menu for "Ana"', async () => {
      await vi.waitFor(() => expect(text('[data-testid="account-menu"]')).toBe('Ana'))
    })
  })

  ScenarioOutline('The address keeps the page in a way each place can reload', ({ Given, Then }, variables) => {
    Given('<where>', () => PLACES[variables.where]!())
    Then('the address of the project "p1" is "<address>"', () => {
      const history = routerHistory()
      expect(history.createHref('/p/p1')).toBe(variables.address)
      history.destroy()
    })
  })

  Scenario('The app never creates the Better Auth client', ({ Given, When, Then, And }) => {
    let service: unknown
    Given(`the app on a computer, using the server "${SERVER}"`, () => inApp('linux'))
    When('the page starts its account service', async () => {
      service = await createAccountService()
    })
    Then('it is the app\'s account service', () => {
      expect(service).toBeInstanceOf(AppAccountService)
    })
    And('no Better Auth client was created', () => {
      expect(fake.createAuthClient).not.toHaveBeenCalled()
    })
  })

  Scenario('The website signs in with Better Auth', ({ Given, When, Then, And }) => {
    let service: unknown
    Given('the website', () => {
      expect(isApp()).toBe(false)
    })
    When('the page starts its account service', async () => {
      service = await createAccountService()
    })
    Then('it is the Better Auth account service', () => {
      expect(service).toBeInstanceOf(BetterAuthAccountService)
    })
    And('one Better Auth client was created', () => {
      expect(fake.createAuthClient).toHaveBeenCalledTimes(1)
    })
  })

  Scenario('The app\'s sign in page offers only the browser', ({ Given, When, Then }) => {
    Given('the app on a computer, signed out', () => inApp('linux'))
    When('they open "/sign-in"', () => open('/sign-in'))
    Then('the page offers only "Sign in with your browser"', async () => {
      await web!.waitFor('[data-testid="sign-in-browser"]')
      expect(findAll('main button').map(button => button.textContent?.trim())).toEqual(['Sign in with your browser'])
      expect(findAll('main input')).toEqual([])
      expect(findAll('main a[href="/sign-up"]')).toEqual([])
    })
  })

  Scenario('Signing in on a computer', ({ Given, And, When, Then }) => {
    Given('the app on a computer, signed out', () => inApp('linux'))
    And('they open "/sign-in"', () => open('/sign-in'))
    When('they choose "Sign in with your browser" and sign in as "Ana" there', async () => {
      app.signsInAs = ANA
      await web!.click('[data-testid="sign-in-browser"]')
    })
    Then('the app got the command "auth_sign_in"', () => {
      expect(fake.invoke.mock.calls.map(([command]) => command)).toContain('auth_sign_in')
    })
    And('they are on the home page', async () => {
      await vi.waitFor(() => expect(web!.router.currentRoute.value.name).toBe('home'))
    })
    And('the header shows the account menu for "Ana"', async () => {
      await vi.waitFor(() => expect(text('[data-testid="account-menu"]')).toBe('Ana'))
    })
  })

  Scenario('Signing in on Android finishes when they come back', ({ Given, And, When, Then }) => {
    Given('the app on Android, signed out', () => inApp('android'))
    And('they open "/sign-in"', () => open('/sign-in'))
    When('they choose "Sign in with your browser"', async () => {
      app.signsInAs = ANA
      await web!.click('[data-testid="sign-in-browser"]')
    })
    Then('the page asks them to finish in the browser', async () => {
      await vi.waitFor(() => expect(text('[data-testid="sign-in-waiting"]')).toBe('Finish in your browser. Deyslide signs you in when you come back.'))
      expect(web!.router.currentRoute.value.name).toBe('sign-in')
      expect(find('[data-testid="sign-in-browser"]')?.hasAttribute('disabled')).toBe(false)
    })
    When('they come back to the app signed in as "Ana"', async () => {
      await signedIn(ANA)
      emit('account-changed')
      await web!.settle()
    })
    Then('they are on the home page', async () => {
      await vi.waitFor(() => expect(web!.router.currentRoute.value.name).toBe('home'))
    })
    And('the header shows the account menu for "Ana"', async () => {
      await vi.waitFor(() => expect(text('[data-testid="account-menu"]')).toBe('Ana'))
    })
  })

  Scenario('On a computer they can start the sign in again', ({ Given, And, When, Then }) => {
    Given('the app on a computer, signed out', () => inApp('linux'))
    And('they open "/sign-in"', () => open('/sign-in'))
    When('they choose "Sign in with your browser" and close the browser tab', async () => {
      app.signsInAs = undefined
      await web!.click('[data-testid="sign-in-browser"]')
    })
    Then('the page asks them to finish in the browser', async () => {
      await vi.waitFor(() => expect(text('[data-testid="sign-in-waiting"]')).toBe('Finish in your browser. Deyslide signs you in when you come back.'))
      expect(find('[data-testid="sign-in-browser"]')?.hasAttribute('disabled')).toBe(false)
    })
    When('they choose "Open the browser again" and sign in as "Ana" there', async () => {
      expect(text('[data-testid="sign-in-browser"]')).toBe('Open the browser again')
      app.signsInAs = ANA
      await web!.click('[data-testid="sign-in-browser"]')
    })
    Then('the app got the command "auth_sign_in" 2 times', () => {
      expect(fake.invoke.mock.calls.filter(([command]) => command === 'auth_sign_in')).toHaveLength(2)
    })
    And('they are on the home page', async () => {
      await vi.waitFor(() => expect(web!.router.currentRoute.value.name).toBe('home'))
      expect(text('[data-testid="account-menu"]')).toBe('Ana')
    })
  })

  Scenario('A sign in on Android that does not finish says so', ({ Given, And, When, Then }) => {
    Given('the app on Android, signed out', () => inApp('android'))
    And('they open "/sign-in"', () => open('/sign-in'))
    When('they choose "Sign in with your browser"', async () => {
      await web!.click('[data-testid="sign-in-browser"]')
      await web!.waitFor('[data-testid="sign-in-waiting"]')
    })
    And('they come back to the app without signing in', async () => {
      // The browser refused or failed: the app ends the sign in and says the account changed.
      emit('account-changed')
      await web!.settle()
    })
    Then('the page says "Signing in did not finish. Try again."', async () => {
      await vi.waitFor(() => expect(text('main [role="alert"]')).toBe('Signing in did not finish. Try again.'))
      expect(find('[data-testid="sign-in-waiting"]')).toBeNull()
      expect(web!.router.currentRoute.value.name).toBe('sign-in')
    })
    And('the button reads "Sign in with your browser" again', () => {
      expect(text('[data-testid="sign-in-browser"]')).toBe('Sign in with your browser')
    })
  })

  Scenario('Signing out in the app', ({ Given, When, Then, And }) => {
    Given('the app on a computer, signed in as "Ana"', async () => {
      await inApp('linux')
      await signedIn(ANA)
      await open('/')
      await web!.waitFor('[data-testid="account-menu"]')
    })
    When('they sign out from the account menu', async () => {
      const trigger = await web!.waitFor('[data-testid="account-menu"]')
      trigger.focus()
      trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
      await web!.settle()
      await web!.click('[data-testid="sign-out"]')
    })
    Then('the app got the command "auth_sign_out"', () => {
      expect(fake.invoke.mock.calls.map(([command]) => command)).toContain('auth_sign_out')
    })
    And('the header has a "Sign in" link', async () => {
      await vi.waitFor(() => expect(text('[data-testid="sign-in-link"]')).toBe('Sign in'))
    })
  })

  Scenario('The app signs them out when the server ends the sign in', ({ Given, When, Then }) => {
    Given('the app on a computer, signed in as "Ana"', async () => {
      await inApp('linux')
      await signedIn(ANA)
      await open('/')
      await web!.waitFor('[data-testid="account-menu"]')
    })
    When('the app says the account changed and nobody is signed in anymore', async () => {
      app.account = null
      app.token = undefined
      emit('account-changed')
      await web!.settle()
    })
    Then('the header has a "Sign in" link', async () => {
      await vi.waitFor(() => expect(text('[data-testid="sign-in-link"]')).toBe('Sign in'))
      expect(find('[data-testid="account-menu"]')).toBeNull()
    })
  })

  Scenario('A sign in that finishes while a deck is open keeps what was typed', ({ Given, And, When, Then }) => {
    const api = new FakeProjectApi()
    Given('the app on a computer, signed out, with the deck "Intro" in the project "Talks"', async () => {
      await inApp('linux')
      const guest = await GuestStore.open(new MemoryGuestStorage())
      const project = await guest.createProject('Talks')
      const deck = await guest.createDeck(project.id, 'Intro', 'blank')
      await open(`/p/${project.id}/d/${deck.id}`, { api, guest })
    })
    And('they open the deck "Intro" and type a slide "Typed while signing in"', () => typeSlide('Typed while signing in'))
    When('the browser sign in as "Ana" finishes before the deck saves', async () => {
      await signedIn(ANA)
      emit('account-changed')
      await vi.waitFor(() => expect(web!.account.account.value?.id).toBe(ANA.id))
      await web!.settle()
    })
    Then('they are on the home page', () => {
      expect(web!.router.currentRoute.value.name).toBe('home')
    })
    And('the deck "Intro" in Ana\'s account has the slide "Typed while signing in"', async () => {
      expect(await accountDeck(api, 'Intro')).toContain('# Typed while signing in')
    })
  })

  Scenario('Signing out from an open deck saves what was typed first', ({ Given, And, When, Then }) => {
    const api = new FakeProjectApi()
    Given('the app on a computer, signed in as "Ana", with the deck "Intro" in the project "Talks"', async () => {
      await inApp('linux')
      await signedIn(ANA)
      const cloud = await CloudStore.open(api)
      const project = await cloud.createProject('Talks')
      const deck = await cloud.createDeck(project.id, 'Intro', 'blank')
      await open(`/p/${project.id}/d/${deck.id}`, { api })
    })
    And('they open the deck "Intro" and type a slide "Typed before signing out"', () => typeSlide('Typed before signing out'))
    When('they sign out from the account menu before the deck saves', async () => {
      const trigger = await web!.waitFor('[data-testid="account-menu"]')
      trigger.focus()
      trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
      await web!.settle()
      await web!.click('[data-testid="sign-out"]')
    })
    Then('the header has a "Sign in" link', async () => {
      await vi.waitFor(() => expect(text('[data-testid="sign-in-link"]')).toBe('Sign in'))
    })
    And('the deck "Intro" in Ana\'s account has the slide "Typed before signing out"', async () => {
      expect(await accountDeck(api, 'Intro')).toContain('# Typed before signing out')
    })
  })

  Scenario('The app starts without waiting long for a server that does not answer', ({ Given, When, Then, And }) => {
    Given('the app on a computer, signed in as "Ana", with a server that does not answer', async () => {
      await inApp('linux')
      await signedIn(ANA)
      app.server = 'silent'
    })
    When('they open "/"', () => open('/', { wait: 50 }))
    Then('the page shows "Your projects"', async () => {
      await vi.waitFor(() => expect(pageText()).toContain('Your projects'))
    })
    And('the header has a "Sign in" link', () => {
      expect(text('[data-testid="sign-in-link"]')).toBe('Sign in')
    })
  })

  Scenario('The app shows the account once its server answers again', ({ Given, And, When, Then }) => {
    Given('the app on a computer, signed in as "Ana", with a server it cannot reach', async () => {
      await inApp('linux')
      await signedIn(ANA)
      app.server = 'unreachable'
    })
    And('they open "/"', () => open('/'))
    And('the header has a "Sign in" link', async () => {
      await web!.settle()
      expect(text('[data-testid="sign-in-link"]')).toBe('Sign in')
    })
    When('the server answers again and they come back to the window', async () => {
      app.server = 'up'
      window.dispatchEvent(new Event('focus'))
      await web!.settle()
    })
    Then('the header shows the account menu for "Ana"', async () => {
      await vi.waitFor(() => expect(text('[data-testid="account-menu"]')).toBe('Ana'))
    })
  })

  Scenario('Without an answer from its server the app keeps the account it shows', ({ Given, When, Then }) => {
    Given('the app on a computer, signed in as "Ana"', async () => {
      await inApp('linux')
      await signedIn(ANA)
      await open('/')
      await web!.waitFor('[data-testid="account-menu"]')
    })
    When('the server cannot be reached and the app says the account changed', async () => {
      app.server = 'unreachable'
      emit('account-changed')
      await web!.settle()
      await vi.waitFor(() => expect(fake.invoke.mock.calls.filter(([command]) => command === 'auth_account').length).toBeGreaterThanOrEqual(3))
      await web!.settle()
    })
    Then('the header shows the account menu for "Ana"', () => {
      expect(text('[data-testid="account-menu"]')).toBe('Ana')
      expect(find('[data-testid="sign-in-link"]')).toBeNull()
    })
  })

  ScenarioOutline('The header offers the app on the website only', ({ Given, When, Then }, variables) => {
    Given('<where>', () => PLACES[variables.where]!())
    When('they open "/"', () => open('/'))
    Then('the header <shows> the "Get the app" and "Watch the demo" links', () => {
      if (variables.shows === 'has') {
        expect(text('[data-testid="get-the-app"]')).toBe('Get the app')
        expect(find('[data-testid="get-the-app"]')?.getAttribute('href')).toBe('/download')
        expect(text('[data-testid="demo-link"]')).toBe('Watch the demo')
      }
      else {
        expect(find('[data-testid="get-the-app"]')).toBeNull()
        expect(find('[data-testid="demo-link"]')).toBeNull()
        expect(text('[data-testid="sign-in-link"]')).toBe('Sign in')
      }
    })
  })

  ScenarioOutline('The guest banner says where work is kept', ({ Given, When, Then, And }, variables) => {
    Given('<where>', () => PLACES[variables.where]!())
    When('they open "/"', () => open('/'))
    Then('the banner says the work is saved <kept> only', () => {
      expect(text('[data-testid="guest-banner"]')).toContain(`Your work is saved ${variables.kept} only.`)
    })
    And('its "<button>" button leads to "<link>"', () => {
      expect(text('[data-testid="sign-up-link"]')).toBe(variables.button)
      expect(find('[data-testid="sign-up-link"]')?.getAttribute('href')).toBe(variables.link)
    })
  })

  ScenarioOutline('The download page links the latest release\'s files', ({ Given, When, Then, And }, variables) => {
    Given('GitHub lists the release "v0.2.0" with the files the release workflow makes', () => {
      github = 'up'
    })
    When('they open "/download"', () => open('/download'))
    Then('the "<button>" link leads to "<file>"', async () => {
      await vi.waitFor(() => expect(find(`[data-testid="${variables.button}"]`)?.getAttribute('href')).toBe(fileLink(variables.file!)))
    })
    And('the page says "Latest version: v0.2.0"', () => {
      expect(text('[data-testid="download-version"]')).toBe('Latest version: v0.2.0')
    })
  })

  Scenario('The download page skips an APK without a signature', ({ Given, When, Then }) => {
    Given('GitHub lists the release "v0.2.0" with "Deyslide_0.2.0_android-unsigned.apk" before "Deyslide_0.2.0_android.apk"', () => {
      github = 'up'
      releaseFiles = ['Deyslide_0.2.0_android-unsigned.apk', 'Deyslide_0.2.0_android.apk']
    })
    When('they open "/download"', () => open('/download'))
    Then('the "download-android" link leads to "Deyslide_0.2.0_android.apk"', async () => {
      await vi.waitFor(() => expect(find('[data-testid="download-android"]')?.getAttribute('href')).toBe(fileLink('Deyslide_0.2.0_android.apk')))
    })
  })

  Scenario('Without GitHub the buttons lead to the releases page', ({ Given, When, Then, And }) => {
    Given('GitHub cannot be reached', () => {
      github = 'down'
    })
    When('they open "/download"', async () => {
      await open('/download')
      await vi.waitFor(() => expect(browserFetch).toHaveBeenCalledWith(LATEST_RELEASE_API, expect.anything()))
      await web!.settle()
    })
    Then(`the Windows, macOS, Linux and Android buttons lead to "${RELEASES_PAGE}"`, () => {
      for (const platform of ['windows', 'macos', 'linux', 'android'])
        expect(find(`[data-testid="download-${platform}"]`)?.getAttribute('href')).toBe(RELEASES_PAGE)
    })
    And('there are no other download links', () => {
      expect(find('[data-testid="download-windows-msi"]')).toBeNull()
      expect(find('[data-testid="download-linux-deb"]')).toBeNull()
      expect(find('[data-testid="download-version"]')).toBeNull()
    })
  })

  Scenario('The download page explains the first start on a Mac and Claude Code', ({ Given, When, Then, And }) => {
    Given(`the website at "${SERVER}"`, () => {
      happyDom().setURL(`${SERVER}/download`)
    })
    When('they open "/download"', () => open('/download'))
    Then('the page explains "Open Anyway" in "Privacy & Security"', async () => {
      const steps = (await web!.waitFor('[data-testid="install-macos"]')).textContent ?? ''
      expect(steps).toContain('Privacy & Security')
      expect(steps).toContain('Open Anyway')
    })
    And('it shows the command the app gives for Claude Code on this computer', () => {
      expect(text('[data-testid="local-command"]')).toBe('claude mcp add --scope user deyslide-local -- "<path to Deyslide>" mcp')
      expect(text('[data-testid="claude-code-setup"]')).toContain('Connect Claude Code')
    })
    And('it shows the command "claude mcp add --scope user --transport http deyslide https://deyslide.bambanggunawan.id/mcp"', () => {
      expect(text('[data-testid="hosted-command"]')).toBe('claude mcp add --scope user --transport http deyslide https://deyslide.bambanggunawan.id/mcp')
    })
  })
})
