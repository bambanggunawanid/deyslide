/** The two ways to edit a deck: the slide canvas, or its Markdown. */
export type DeckView = 'design' | 'markdown'

/** Where the page remembers the last view someone chose, in this browser. */
export const VIEW_STORAGE_KEY = 'deyslide:deck-view'

export function isDeckView(value: unknown): value is DeckView {
  return value === 'design' || value === 'markdown'
}

/** The view chosen last time, if the browser lets the page remember it. */
export function rememberedView(): DeckView | undefined {
  try {
    const value = localStorage.getItem(VIEW_STORAGE_KEY)
    return isDeckView(value) ? value : undefined
  }
  catch {
    return undefined
  }
}

export function rememberView(view: DeckView) {
  try {
    localStorage.setItem(VIEW_STORAGE_KEY, view)
  }
  catch {
    // Private windows can refuse storage. The view still changes.
  }
}
