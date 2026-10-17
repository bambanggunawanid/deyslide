import type { AppPlatform } from '../apps/web/src/platform/native'
import type { AppUpdates } from '../apps/web/src/platform/updates'
import type { WebApp } from './support/web'
import { describeFeature, loadFeature } from '@amiceli/vitest-cucumber'
import { expect, vi } from 'vitest'
import { AppAccountService } from '../apps/web/src/account/app'
import { storesToSave } from '../apps/web/src/platform/closing'
import { startPlatform } from '../apps/web/src/platform/platform'
import { LATEST_RELEASE_API } from '../apps/web/src/platform/releases'
import { CHECK_EVERY_MS, isNewer, startUpdates, UPDATES_KEY } from '../apps/web/src/platform/updates'
import { LocalStore } from '../apps/web/src/projects/local-store'
import { deckIdOf, FakeDeviceLibrary, projectIdOf } from './support/device-library'
import { find, mountWebApp, text } from './support/web'

interface FakeListener {
  event: string
  handler: (event: { event: string, id: number, payload: unknown }) => void
}

// A stand in for the Deyslide app: its commands, its events and its plugins.
const fake = vi.hoisted(() => ({
  invoke: vi.fn(),
  listeners: [] as FakeListener[],
  check: vi.fn(),
  ask: vi.fn(),
  openUrl: vi.fn(),
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
vi.mock('../apps/web/node_modules/@tauri-apps/plugin-updater/dist-js/index.js', () => ({ check: fake.check }))
vi.mock('../apps/web/node_modules/@tauri-apps/plugin-dialog/dist-js/index.js', () => ({ ask: fake.ask, save: vi.fn(), open: vi.fn() }))
vi.mock('../apps/web/node_modules/@tauri-apps/plugin-opener/dist-js/index.js', () => ({ openUrl: fake.openUrl }))

const feature = await loadFeature('./app-updates.feature')

const RUNNING = '0.2.0'
const apkLink = (version: string) => `https://github.com/bambanggunawanid/deyslide/releases/download/v${version}/Deyslide_${version}_android.apk`

/** What the fake app and GitHub know. */
interface World {
  platform: AppPlatform
  /** Whether the build carries the updater's key. */
  updater: boolean
  /** The newest published release. */
  latest: string
  /** GitHub and the updater's `latest.json` cannot be reached. */
  offline: boolean
  /** The downloaded file does not match its signature. */
  badSignature: boolean
}

describeFeature(feature, ({ Scenario, ScenarioOutline, BeforeEachScenario, AfterEachScenario }) => {
  let world: World
  let library: FakeDeviceLibrary
  let local: LocalStore | undefined
  let web: WebApp | undefined
  let updates: AppUpdates | undefined
  /** What happened, in order: downloads, installs and restarts. */
  let steps: string[]
  /** The deck file "Intro" as it was when the update was installed. */
  let fileAtInstall: string | undefined

  function emit(event: string, payload: unknown = null) {
    for (const listener of fake.listeners.filter(listener => listener.event === event))
      listener.handler({ event, id: 1, payload })
  }

  BeforeEachScenario(() => {
    world = { platform: 'linux', updater: true, latest: RUNNING, offline: false, badSignature: false }
    steps = []
    fileAtInstall = undefined
    fake.listeners.length = 0
    localStorage.clear()
    library = new FakeDeviceLibrary(emit)
    for (const mock of [fake.invoke, fake.check, fake.ask, fake.openUrl])
      mock.mockReset()
    fake.invoke.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      if (library.handles(command))
        return library.invoke(command, args)
      switch (command) {
        case 'app_info':
          return { version: RUNNING, platform: world.platform, serverUrl: 'https://deyslide.bambanggunawan.id', updates: world.updater && !['android', 'ios'].includes(world.platform) }
        case 'auth_account':
          return null
        case 'auth_access_token':
          throw 'You are signed out.'
        case 'app_restart':
          steps.push('restart')
          return undefined
      }
      throw new Error(`The fake app has no command ${command}`)
    })
    // The updater reads latest.json, verifies the file it downloads, then installs it.
    fake.check.mockImplementation(async () => {
      steps.push('check')
      if (world.offline)
        throw 'Could not fetch a valid release JSON from the remote'
      if (!isNewer(world.latest, RUNNING))
        return null
      return {
        version: world.latest,
        currentVersion: RUNNING,
        download: async () => {
          steps.push('download')
          if (world.badSignature)
            throw 'The signature verification failed'
        },
        install: async () => {
          steps.push('install')
          fileAtInstall = library.read('Talks', 'Intro')
        },
        close: async () => {},
      }
    })
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) !== LATEST_RELEASE_API)
        throw new TypeError(`Nothing answers ${String(input)}`)
      steps.push('check')
      if (world.offline)
        throw new TypeError('Failed to fetch')
      const tag = `v${world.latest}`
      const names = [`Deyslide_${world.latest}_x64-setup.exe`, `Deyslide_${world.latest}_android.apk`]
      const release = { tag_name: tag, assets: names.map(name => ({ name, browser_download_url: `https://github.com/bambanggunawanid/deyslide/releases/download/${tag}/${name}` })) }
      return new Response(JSON.stringify(release), { status: 200, headers: { 'content-type': 'application/json' } })
    }))
  })

  AfterEachScenario(() => {
    updates?.stop()
    updates = undefined
    web?.unmount()
    web = undefined
    local?.close()
    local = undefined
    vi.useRealTimers()
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
  })

  /** The app as the Given steps describe it, before it starts. */
  async function inApp(platform: AppPlatform, { updater = true, latest = RUNNING } = {}) {
    vi.stubEnv('VITE_APP', '1')
    world.platform = platform
    world.updater = updater
    world.latest = latest
    await startPlatform()
  }

  /** Starts the pages the way main.ts does: the update checks, then the home page or a deck. */
  async function startApp(path = '/') {
    local ??= await LocalStore.open()
    updates = startUpdates(() => storesToSave(web!.workspace), { ask: fake.ask })
    web = await mountWebApp({
      path,
      service: new AppAccountService(),
      local,
      view: 'markdown',
      provide: updates ? { [UPDATES_KEY as symbol]: updates } : {},
    })
    await web.settle()
  }

  /** Types a slide at the end of the open deck, in the editor double. */
  async function typeSlide(title: string) {
    const editor = await web!.waitFor('[data-testid="markdown-editor"]') as HTMLTextAreaElement
    await vi.waitFor(() => expect(editor.value).toContain('# Intro'))
    editor.value = `${editor.value}\n---\n\n# ${title}\n`
    editor.dispatchEvent(new Event('input'))
    await web!.settle()
  }

  async function says(message: string) {
    await vi.waitFor(() => expect(text('[data-testid="update-message"]')).toBe(message))
  }

  async function offersNothing() {
    await web!.settle()
    await vi.waitFor(() => expect(updates?.status.value ?? 'idle').not.toBe('checking'))
    expect(find('[data-testid="update-notice"]')).toBeNull()
  }

  async function installUpdate() {
    await says('Deyslide 0.3.0 is available')
    await web!.click('[data-testid="update-install"]')
    await vi.waitFor(() => expect(updates!.status.value).not.toBe('installing'))
  }

  async function opensInBrowser(label: string, link: string) {
    const button = await web!.waitFor('[data-testid="update-link"]')
    expect(button.textContent?.trim()).toBe(label)
    await web!.click('[data-testid="update-link"]')
    expect(fake.openUrl).toHaveBeenCalledWith(link)
  }

  Scenario('A newer version is offered', ({ Given, When, Then, And }) => {
    Given('the app on a computer runs version 0.2.0 and the latest release is 0.3.0', () => inApp('linux', { latest: '0.3.0' }))
    When('the app starts', () => startApp())
    Then('it says "Deyslide 0.3.0 is available"', () => says('Deyslide 0.3.0 is available'))
    And('it offers to install it', () => {
      expect(text('[data-testid="update-install"]')).toBe('Install')
      expect(find('[data-testid="update-link"]')).toBeNull()
      expect(steps).toEqual(['check'])
    })
  })

  Scenario('The app is up to date', ({ Given, When, Then }) => {
    Given('the app on a computer runs version 0.2.0 and the latest release is 0.2.0', () => inApp('linux'))
    When('the app starts', () => startApp())
    Then('it offers no update', () => offersNothing())
    When('they choose "Check for updates" in the settings', () => web!.click('[data-testid="check-updates"]'))
    Then('the settings say "Deyslide 0.2.0 is up to date."', async () => {
      await vi.waitFor(() => expect(text('[data-testid="update-status"]')).toBe('Deyslide 0.2.0 is up to date.'))
      expect(steps).toEqual(['check', 'check'])
    })
  })

  Scenario('A check they asked for says when it cannot reach GitHub', ({ Given, When, Then }) => {
    Given('the app on a computer runs version 0.2.0 and the updater cannot reach GitHub', async () => {
      await inApp('linux')
      world.offline = true
    })
    When('the app starts', () => startApp())
    Then('it offers no update', async () => {
      await offersNothing()
      // A check of its own that fails says nothing.
      expect(find('[data-testid="update-check-problem"]')).toBeNull()
    })
    When('they choose "Check for updates" in the settings', () => web!.click('[data-testid="check-updates"]'))
    Then('the settings say "Deyslide could not check for updates. Check your connection and try again."', async () => {
      await vi.waitFor(() => expect(text('[data-testid="update-check-problem"]')).toBe('Deyslide could not check for updates. Check your connection and try again.'))
    })
  })

  Scenario('Installing saves every open deck, then restarts', ({ Given, And, When, Then }) => {
    Given('the app on a computer runs version 0.2.0 and the latest release is 0.3.0', () => inApp('linux', { latest: '0.3.0' }))
    And('they typed a slide "Typed before the update" in the deck "Intro" on this device', async () => {
      library.put('Talks', 'Intro', '# Intro\n')
      await startApp(`/p/${projectIdOf('Talks')}/d/${deckIdOf('Talks', 'Intro')}`)
      await typeSlide('Typed before the update')
      // A device deck waits a moment before it is written.
      expect(library.writes).toEqual([])
    })
    When('they install the update', () => installUpdate())
    Then('the file of the deck "Intro" had the slide "Typed before the update" before the update was installed', () => {
      expect(fileAtInstall).toContain('# Typed before the update')
      expect(fake.ask).not.toHaveBeenCalled()
    })
    And('the app restarts once the update is installed', () => {
      expect(steps).toEqual(['check', 'download', 'install', 'restart'])
    })
  })

  Scenario('An update with a bad signature is refused', ({ Given, And, When, Then }) => {
    Given('the app on a computer runs version 0.2.0 and the latest release is 0.3.0', async () => {
      await inApp('linux', { latest: '0.3.0' })
      await startApp()
    })
    And('the update file does not match its signature', () => {
      world.badSignature = true
    })
    When('they install the update', () => installUpdate())
    Then('the app keeps its version and says "The update to 0.3.0 could not be verified, so it was not installed. You still have Deyslide 0.2.0."', async () => {
      await vi.waitFor(() => expect(text('[data-testid="update-problem"]')).toBe('The update to 0.3.0 could not be verified, so it was not installed. You still have Deyslide 0.2.0.'))
      expect(steps).toEqual(['check', 'download'])
    })
    And('the app does not restart', () => {
      expect(fake.invoke).not.toHaveBeenCalledWith('app_restart', undefined, undefined)
      expect(steps).not.toContain('restart')
      // The offer stays, so they can try again later.
      expect(text('[data-testid="update-install"]')).toBe('Install')
    })
  })

  Scenario('A build without the update key links to the download page', ({ Given, When, Then, And }) => {
    Given('the app on a computer was built without the update key, runs version 0.2.0, and the latest release is 0.3.0', () => inApp('windows', { updater: false, latest: '0.3.0' }))
    When('the app starts', () => startApp())
    Then('it says "Deyslide 0.3.0 is available"', () => says('Deyslide 0.3.0 is available'))
    And('its "Open the download page" button opens "https://deyslide.bambanggunawan.id/download" in the browser', async () => {
      await opensInBrowser('Open the download page', 'https://deyslide.bambanggunawan.id/download')
      expect(fake.check).not.toHaveBeenCalled()
      expect(find('[data-testid="update-install"]')).toBeNull()
    })
  })

  Scenario('Android points to the new APK', ({ Given, When, Then, And }) => {
    Given('the Android app runs 0.2.0 and the latest release is 0.3.0', () => inApp('android', { latest: '0.3.0' }))
    When('the app starts', () => startApp())
    Then('it says "Deyslide 0.3.0 is available"', () => says('Deyslide 0.3.0 is available'))
    And(`its "Download the APK" button opens "${apkLink('0.3.0')}" in the browser`, async () => {
      await opensInBrowser('Download the APK', apkLink('0.3.0'))
      expect(fake.check).not.toHaveBeenCalled()
    })
  })

  Scenario('The automatic check can be turned off', ({ Given, And, When, Then }) => {
    Given('the app on a computer runs version 0.2.0 and the latest release is 0.3.0', () => inApp('linux', { latest: '0.3.0' }))
    And('they turned off the automatic check in the settings', async () => {
      await startApp()
      const toggle = await web!.waitFor('[data-testid="automatic-updates"]') as HTMLInputElement
      expect(toggle.checked).toBe(true)
      toggle.checked = false
      toggle.dispatchEvent(new Event('change'))
      await web!.settle()
      updates!.stop()
      web!.unmount()
      steps = []
    })
    When('the app starts again and runs for a day', async () => {
      vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
      await startApp()
      expect((find('[data-testid="automatic-updates"]') as HTMLInputElement).checked).toBe(false)
      vi.advanceTimersByTime(CHECK_EVERY_MS)
      await web!.settle()
    })
    Then('it never looked for updates', () => {
      expect(steps).toEqual([])
    })
    And('it offers no update', () => offersNothing())
  })

  Scenario('The app looks again each day', ({ Given, When, And, Then }) => {
    Given('the app on a computer runs version 0.2.0 and the latest release is 0.2.0', () => inApp('linux'))
    When('the app starts', async () => {
      vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
      await startApp()
      await offersNothing()
    })
    And('the release 0.3.0 comes out and a day passes', async () => {
      world.latest = '0.3.0'
      vi.advanceTimersByTime(CHECK_EVERY_MS)
      await web!.settle()
    })
    Then('it says "Deyslide 0.3.0 is available"', async () => {
      await says('Deyslide 0.3.0 is available')
      expect(steps).toEqual(['check', 'check'])
    })
  })

  Scenario('iPhones and iPads get new versions from Apple', ({ Given, When, Then, And }) => {
    Given('the iOS app runs 0.2.0 and the latest release is 0.3.0', () => inApp('ios', { latest: '0.3.0' }))
    When('the app starts', () => startApp())
    Then('it never looked for updates', () => {
      expect(updates).toBeUndefined()
      expect(steps).toEqual([])
    })
    And('the home page has no update settings', () => {
      expect(text('h1')).toBe('Your projects')
      expect(find('[data-testid="updates-panel"]')).toBeNull()
      expect(find('[data-testid="update-notice"]')).toBeNull()
    })
  })

  ScenarioOutline('Versions are compared as semantic versions', ({ Then }, variables) => {
    Then('"<candidate>" is newer than "<current>": <newer>', () => {
      expect(isNewer(variables.candidate, variables.current)).toBe(variables.newer === 'yes')
    })
  })
})
