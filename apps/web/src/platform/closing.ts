import type { LocalStore } from '../projects/local-store'
import { onCloseRequested } from './native'

// Device decks are written to their files a moment after each change. When
// the app goes out of sight or its window closes, what still waits is
// written first, so the last change before closing is kept.

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

async function askWithDialog(message: string) {
  const { ask } = await import('@tauri-apps/plugin-dialog')
  return ask(message, { title: 'Close without your changes?', kind: 'warning', okLabel: 'Close without them', cancelLabel: 'Keep open' })
}

export interface SaveBeforeClosingOptions {
  /** Asks whether to close anyway. The app's own dialog unless a test passes another. */
  ask?: (message: string) => Promise<boolean>
  /** How long closing waits for the writes. */
  waitMs?: number
}

/**
 * Writes the device decks' last changes before the window closes. When some
 * cannot be written (a file on disk has an error, say), or writing takes
 * too long, the person is asked whether to close without them.
 */
export function saveBeforeClosing(store: LocalStore, { ask = askWithDialog, waitMs = CLOSE_WAIT_MS }: SaveBeforeClosingOptions = {}) {
  return onCloseRequested(async () => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const late = new Promise<undefined>((resolve) => {
      timer = setTimeout(() => resolve(undefined), waitMs)
    })
    const unsaved = await Promise.race([store.flushAll(), late])
    clearTimeout(timer)
    if (unsaved?.length === 0)
      return true
    return ask(closingQuestion(unsaved))
  })
}

/** Writes waiting changes when the app goes out of sight, such as Android sending it to the background. */
export function saveWhenHidden(store: LocalStore) {
  const onChange = () => {
    if (document.visibilityState === 'hidden')
      void store.flushAll()
  }
  document.addEventListener('visibilitychange', onChange)
  return () => document.removeEventListener('visibilitychange', onChange)
}
