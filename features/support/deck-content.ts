import { readFileSync } from 'node:fs'
import { deckToYDoc, fromMarkdown } from '../../packages/deck-model/src'
import * as Y from 'yjs'

const demoMarkdown = readFileSync(new URL('../../apps/deck/slides.md', import.meta.url), 'utf8')

/** The demo deck as the encoded Yjs update the API stores, in base64. */
export function demoDeckState(): string {
  const update = Y.encodeStateAsUpdate(deckToYDoc(fromMarkdown(demoMarkdown)))
  return Buffer.from(update).toString('base64')
}

/** A one slide deck, as the API stores it, in base64. */
export function blankDeckState(title: string): string {
  const deck = fromMarkdown(`---\ntitle: ${title}\n---\n\n# ${title}\n`)
  return Buffer.from(Y.encodeStateAsUpdate(deckToYDoc(deck))).toString('base64')
}

/** How many slides an encoded deck holds, read back through the model. */
export function slidesIn(state: Uint8Array): number {
  const doc = new Y.Doc()
  Y.applyUpdate(doc, state)
  const slides = doc.getMap('deck').get('slides') as Y.Array<unknown>
  return slides.length
}
