import type { Deck } from '@deyslide/deck-model'
import type { CloseReason } from './rooms.ts'
import { DECK_KEY, deckMarkdown, toMarkdown } from '@deyslide/deck-model'
import * as Y from 'yjs'
import { MARKDOWN_MAX_LENGTH } from '../assistant/draft.ts'

/** A deck document larger than this is refused. Media lives in R2, not in the deck. */
export const DECK_MAX_BYTES = 5 * 1024 * 1024
/** Slides a live deck can hold, since live editing slows down well before thousands. */
export const DECK_MAX_SLIDES = 500
/** Markdown a live deck can hold: twice what one Claude write may send, so people can add to it. */
export const ROOM_MAX_MARKDOWN = MARKDOWN_MAX_LENGTH * 2
/**
 * Encoded state a live deck can reach, against abuse. It sits above what an
 * upload may hold, since a live document keeps some history of deletions.
 */
export const ROOM_MAX_BYTES = DECK_MAX_BYTES * 2

/** How a room closes when its deck grew past a limit. Clients show the reason. */
export const TOO_BIG: CloseReason = { code: 4002, reason: 'This deck is too big to save. Remove some content.' }

/** A change would make the deck too big to save, so it was not made. */
export class DeckTooBigError extends Error {
  constructor() {
    super(TOO_BIG.reason)
  }
}

function slidesOverLimit(count: number) {
  return count > DECK_MAX_SLIDES ? `${count} slides, more than ${DECK_MAX_SLIDES}` : undefined
}

function markdownOverLimit(length: number) {
  return length > ROOM_MAX_MARKDOWN ? `${length} characters of Markdown, more than ${ROOM_MAX_MARKDOWN}` : undefined
}

/**
 * The limit a live deck goes past, or undefined when it fits. Slides are
 * counted first, since reading thousands of them takes a while.
 */
export function overLimit(doc: Y.Doc, state: Uint8Array = Y.encodeStateAsUpdate(doc)): string | undefined {
  const slides = doc.getMap<unknown>(DECK_KEY).get('slides')
  const tooMany = slidesOverLimit(slides instanceof Y.Array ? slides.length : 0)
  if (tooMany)
    return tooMany
  if (state.byteLength > ROOM_MAX_BYTES)
    return `${state.byteLength} bytes, more than ${ROOM_MAX_BYTES}`
  return markdownOverLimit(deckMarkdown(doc).length)
}

/** The limit a new deck goes past, which would keep it from being edited live, or undefined when it fits. */
export function deckOverLimit(deck: Deck): string | undefined {
  return slidesOverLimit(deck.slides.length) ?? markdownOverLimit(toMarkdown(deck, { ids: false }).length)
}
