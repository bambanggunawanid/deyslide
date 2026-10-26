import type { Update } from '@tauri-apps/plugin-updater'
import type { InjectionKey } from 'vue'
import type { FlushingStore, SaveBeforeClosingOptions } from './closing'
import { ref, shallowRef } from 'vue'
import { saveEverything } from './closing'
import { appRestart } from './native'
import { appVersion, installsUpdates, isAndroidApp, isApp, isIOSApp, openExternal } from './platform'
import { latestRelease, RELEASES_PAGE } from './releases'

/**
 * New versions of the app. A release build on a computer installs them
 * itself through Tauri's updater, which reads `latest.json` from the latest
 * GitHub Release and checks each file's signature. A computer build without
 * the updater's key links to the download page instead, and Android, whose
 * apps cannot replace themselves, links to the new APK. iPhones and iPads
 * get new versions through Apple, so the app there never checks.
 */

export const UPDATES_KEY: InjectionKey<AppUpdates> = Symbol('updates')

/** Where the automatic check is turned off, on this device. */
export const AUTOMATIC_CHECK_KEY = 'deyslide:check-for-updates'

/** How often a running app looks again. */
export const CHECK_EVERY_MS = 24 * 60 * 60 * 1000

/** The website's page with every installer. */
export const DOWNLOAD_PAGE = 'https://deyslide.bambanggunawan.id/download'

/** A newer version, and how this device gets it. */
export interface NewVersion {
  version: string
  /** The app installs it itself, or a link opens in the browser. */
  how: 'install' | 'link'
  /** With a link: the new APK on Android, the download page on a computer. */
  link?: string
  /** What the link says. */
  linkLabel?: string
}

/**
 * Where the update stands. `installed` means the new version is on the
 * device but some changes could not be saved, so the app waits to restart.
 */
export type UpdateStatus = 'idle' | 'checking' | 'current' | 'available' | 'installing' | 'restarting' | 'installed'

/** The parts of a semantic version that order it: numbers, then pre-release identifiers. */
function versionParts(version: string) {
  const [core = '', pre] = version.trim().replace(/^v/, '').split('+')[0]!.split(/-(.*)/s)
  return { core: core.split('.').map(part => Number.parseInt(part, 10) || 0), pre: pre ? pre.split('.') : [] }
}

/** Whether `candidate` comes after `current`, by the rules of semantic versioning. */
export function isNewer(candidate: string, current: string) {
  const a = versionParts(candidate)
  const b = versionParts(current)
  for (let index = 0; index < 3; index++) {
    const difference = (a.core[index] ?? 0) - (b.core[index] ?? 0)
    if (difference !== 0)
      return difference > 0
  }
  // A release comes after its own pre-releases.
  if (!a.pre.length || !b.pre.length)
    return !a.pre.length && b.pre.length > 0
  for (let index = 0; index < Math.max(a.pre.length, b.pre.length); index++) {
    const left = a.pre[index]
    const right = b.pre[index]
    if (left === undefined || right === undefined)
      return right === undefined
    if (left === right)
      continue
    const numbers = /^\d+$/.test(left) && /^\d+$/.test(right)
    if (numbers)
      return Number(left) > Number(right)
    // Numbers sort before words.
    if (/^\d+$/.test(left) || /^\d+$/.test(right))
      return /^\d+$/.test(right)
    return left > right
  }
  return false
}

function readAutomatic() {
  try {
    return localStorage.getItem(AUTOMATIC_CHECK_KEY) !== 'off'
  }
  catch {
    return true
  }
}

function writeAutomatic(on: boolean) {
  try {
    if (on)
      localStorage.removeItem(AUTOMATIC_CHECK_KEY)
    else
      localStorage.setItem(AUTOMATIC_CHECK_KEY, 'off')
  }
  catch {
    // The choice then lasts until the app closes.
  }
}

/**
 * Whether an updater error is about the file's signature rather than getting
 * the file. Besides minisign's own errors, a `.sig` that is not valid base64
 * fails with the base64 decoder's bare message, such as "Invalid symbol 33,
 * offset 4." or "Invalid padding".
 */
export function isSignatureError(error: unknown) {
  const message = typeof error === 'string' ? error : error instanceof Error ? error.message : ''
  return /signature|minisign|public key|base64|signed for|invalid (?:symbol|input length|last symbol|padding)/i.test(message)
}

export interface AppUpdatesOptions {
  /** The running version, such as `0.2.0`. */
  version: string
  /** Where the app runs. iOS has no checks, so it is not one of them. */
  device: 'computer' | 'android'
  /** Whether the app installs updates itself (a release build on a computer). */
  installs: boolean
  /** The stores whose open decks are saved before the app restarts. */
  stores: () => FlushingStore[]
  /** How saving before the restart asks to go on without some changes. */
  saving?: SaveBeforeClosingOptions
}

export class AppUpdates {
  readonly version: string
  readonly status = shallowRef<UpdateStatus>('idle')
  /** The newer version found, if any. */
  readonly found = shallowRef<NewVersion>()
  /** Why the last check asked for in the settings did not work. */
  readonly checkProblem = ref('')
  /** Why the last install did not work. */
  readonly installProblem = ref('')
  /** Whether the app looks on its own: when it starts and once a day. */
  readonly automatic = ref(readAutomatic())
  /** The person put the offer away until the next check finds it again. */
  readonly dismissed = ref(false)

  private readonly options: AppUpdatesOptions
  /** The updater's handle on the version found, on a computer that installs updates. */
  private update?: Update
  private timer?: ReturnType<typeof setInterval>

  constructor(options: AppUpdatesOptions) {
    this.options = options
    this.version = options.version
  }

  /** Looks when the app starts and once a day after, while the automatic check is on. */
  start() {
    if (this.automatic.value)
      void this.check()
    this.timer = setInterval(() => {
      if (this.automatic.value)
        void this.check()
    }, CHECK_EVERY_MS)
    return () => this.stop()
  }

  stop() {
    clearInterval(this.timer)
    this.timer = undefined
  }

  setAutomatic(on: boolean) {
    this.automatic.value = on
    writeAutomatic(on)
  }

  /**
   * Asks for the latest version. `asked` is true when the person chose
   * "Check for updates": only then does a failure show, since an automatic
   * check that finds no connection has nothing useful to say.
   */
  async check({ asked = false } = {}) {
    if (['checking', 'installing', 'restarting', 'installed'].includes(this.status.value))
      return
    this.status.value = 'checking'
    this.checkProblem.value = ''
    try {
      const found = await this.look()
      this.found.value = found
      this.status.value = found ? 'available' : 'current'
      if (found)
        this.dismissed.value = false
    }
    catch {
      this.status.value = this.found.value ? 'available' : 'idle'
      if (asked)
        this.checkProblem.value = 'Deyslide could not check for updates. Check your connection and try again.'
    }
  }

  private async look(): Promise<NewVersion | undefined> {
    if (this.options.installs) {
      const { check } = await import('@tauri-apps/plugin-updater')
      const update = await check()
      void this.update?.close().catch(() => {})
      this.update = update ?? undefined
      return update ? { version: update.version.replace(/^v/, ''), how: 'install' } : undefined
    }
    const latest = await latestRelease()
    if (!latest.version)
      throw new Error('GitHub did not answer.')
    const version = latest.version.replace(/^v/, '')
    if (!isNewer(version, this.version))
      return undefined
    if (this.options.device === 'android')
      return { version, how: 'link', link: latest.files.android ?? RELEASES_PAGE, linkLabel: 'Download the APK' }
    return { version, how: 'link', link: DOWNLOAD_PAGE, linkLabel: 'Open the download page' }
  }

  /** Opens the new APK or the download page in the browser. */
  async openLink() {
    const link = this.found.value?.link
    if (link)
      await openExternal(link)
  }

  /**
   * Downloads the update and checks its signature, saves every open deck,
   * installs it, saves again and starts the app again. A file that does not
   * match its signature is never installed.
   */
  async install() {
    const update = this.update
    const found = this.found.value
    if (!update || !found || this.status.value !== 'available')
      return
    this.status.value = 'installing'
    this.installProblem.value = ''
    try {
      await update.download()
    }
    catch (error) {
      this.status.value = 'available'
      this.installProblem.value = isSignatureError(error)
        ? `The update to ${found.version} could not be verified, so it was not installed. You still have Deyslide ${this.version}.`
        : 'The update could not be downloaded. Check your connection and try again.'
      return
    }
    // Installing on Windows ends the app at once, so the decks are saved before.
    if (!(await saveEverything(this.options.stores(), 'restart', this.options.saving))) {
      this.status.value = 'available'
      this.installProblem.value = 'Nothing was installed, so your changes stay open. Install again once they are saved.'
      return
    }
    try {
      await update.install()
    }
    catch {
      this.status.value = 'available'
      this.installProblem.value = `Deyslide ${found.version} could not be installed. Try again, or get it from the download page.`
      return
    }
    // The decks stay open while macOS unpacks the new app or Linux asks for
    // a password, so whatever changed in the meantime is saved before the restart.
    await this.restart()
  }

  /**
   * Saves every open deck, then starts the installed version. When some
   * changes cannot be saved and the person keeps them, the app stays open
   * and offers to restart later.
   */
  async restart() {
    const found = this.found.value
    if (!found || (this.status.value !== 'installing' && this.status.value !== 'installed'))
      return
    this.status.value = 'restarting'
    this.installProblem.value = ''
    if (!(await saveEverything(this.options.stores(), 'restart', this.options.saving))) {
      this.status.value = 'installed'
      return
    }
    try {
      await appRestart()
    }
    catch {
      this.status.value = 'installed'
      this.installProblem.value = `Deyslide could not restart. Close it and open it again to use ${found.version}.`
    }
  }
}

/**
 * Starts the checks in the app's main window: on a computer and on
 * Android. Nothing on the website, and nothing on iOS.
 */
export function startUpdates(stores: () => FlushingStore[], saving?: SaveBeforeClosingOptions) {
  const version = appVersion()
  if (!isApp() || isIOSApp() || !version)
    return undefined
  const updates = new AppUpdates({
    version,
    device: isAndroidApp() ? 'android' : 'computer',
    installs: installsUpdates(),
    stores,
    saving,
  })
  updates.start()
  return updates
}
