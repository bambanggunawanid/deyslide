import type { Workspace } from '../projects/workspace'
import { onCloseRequested } from './native'

// Device decks are written to their files a moment after each change, and
// account decks reach the server once it confirms them. When the app goes
// out of sight or its window closes, what still waits is sent on first, so
// the last change before closing is kept.

/** A store that can send on its waiting changes, and say which decks still have some. */
export interface FlushingStore {
  flushAll: () => Promise<string[]>
}

/** The workspace's stores that hold changes until they are saved: the device's, and the account's while signed in. */
export function storesToSave(workspace: Workspace): FlushingStore[] {
  return Object.values(workspace.stores.value).filter((store): store is FlushingStore => typeof store?.flushAll === 'function')
}

/** Every store's waiting changes, sent on together. Resolves with the decks still not saved. */
async function flushStores(stores: FlushingStore[]) {
  return (await Promise.all(stores.map(store => store.flushAll()))).flat()
}

/** How long closing waits for the last changes to reach their files. */
const CLOSE_WAIT_MS = 5000

const names = new Intl.ListFormat('en', { type: 'conjunction' })

/** What the question before closing says, for the decks whose changes are not saved, or while saving takes too long. */
export function closingQuestion(decks: string[] | undefined) {
  if (!decks)
    return 'Your last changes are still being saved.'
  return decks.length === 1
    ? `Your last changes to ${decks[0]} could not be saved yet. The deck's page says why.`
    : `Your last changes to ${names.format(decks)} could not be saved yet. Each deck's page says why.`
}

/** What the app is about to do once the decks are saved. */
export type Leaving = 'close' | 'restart'

const QUESTIONS: Record<Leaving, { title: string, okLabel: string }> = {
  close: { title: 'Close without your changes?', okLabel: 'Close without them' },
  restart: { title: 'Restart without your changes?', okLabel: 'Restart without them' },
}

async function askWithDialog(message: string, leaving: Leaving) {
  const { ask } = await import('@tauri-apps/plugin-dialog')
  return ask(message, { ...QUESTIONS[leaving], kind: 'warning', cancelLabel: 'Keep open' })
}

export interface SaveBeforeClosingOptions {
  /** Asks whether to go on anyway. The app's own dialog unless a test passes another. */
  ask?: (message: string, leaving: Leaving) => Promise<boolean>
  /** How long closing waits for the writes. */
  waitMs?: number
}

/**
 * Saves the decks' last changes before the app goes away: device decks to
 * their files, account decks to the server. Resolves true when everything
 * was saved or the person chose to go on without it. When some changes
 * cannot be saved (a file on disk has an error, or the server is out of
 * reach), or saving takes too long, the person is asked.
 */
export async function saveEverything(stores: FlushingStore[], leaving: Leaving, { ask = askWithDialog, waitMs = CLOSE_WAIT_MS }: SaveBeforeClosingOptions = {}) {
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), waitMs)
  })
  const unsaved = await Promise.race([flushStores(stores), late])
  clearTimeout(timer)
  if (unsaved?.length === 0)
    return true
  return ask(closingQuestion(unsaved), leaving)
}

/**
 * Saves every open deck before the window closes (see {@link saveEverything}).
 * `stores` names the stores at that moment, since signing in and out
 * changes them.
 */
export function saveBeforeClosing(stores: () => FlushingStore[], options: SaveBeforeClosingOptions = {}) {
  return onCloseRequested(() => saveEverything(stores(), 'close', options))
}

/** Sends waiting changes on when the app goes out of sight, such as Android sending it to the background. */
export function saveWhenHidden(stores: () => FlushingStore[]) {
  const onChange = () => {
    if (document.visibilityState === 'hidden')
      void flushStores(stores()).catch(() => {})
  }
  document.addEventListener('visibilitychange', onChange)
  return () => document.removeEventListener('visibilitychange', onChange)
}
