import type { Deck } from '@deyslide/deck-model'
import { fromMarkdown } from '@deyslide/deck-model'
import demoMarkdown from '../../../deck/slides.md?raw'

/** The demo deck from `apps/deck/slides.md`, the same one served at /demo/. */
export function demoDeck(): Deck {
  return fromMarkdown(demoMarkdown)
}
