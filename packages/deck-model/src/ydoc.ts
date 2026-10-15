import type { Deck, DeckElement, Slide } from './schema.ts'
import * as Y from 'yjs'
import { DECK_VERSION, DeckSchema } from './schema.ts'
import { DECK_KEY, elementValues, slidesOf, slideToY } from './y-shape.ts'

/**
 * Shape of the live document:
 *
 *   deck: Y.Map
 *     version: number
 *     slides: Y.Array<Y.Map>
 *       id, frontmatter (plain JSON), notes: Y.Text
 *       elements: Y.Array<Y.Map>
 *         id, type
 *         pos: Y.Map (x, y, w, h, rotate)   one key per field, so two people
 *                                           moving different axes both win
 *         markdown: Y.Text                  text and raw elements, so
 *                                           concurrent typing merges
 *         every other field as plain JSON
 */
export { DECK_KEY, DeckNotLoadedError } from './y-shape.ts'

/** Fills `doc` with the deck. The doc should be empty. */
export function deckToYDoc(deck: Deck, doc: Y.Doc = new Y.Doc()): Y.Doc {
  const valid = DeckSchema.parse(deck)
  doc.transact(() => {
    const root = doc.getMap<unknown>(DECK_KEY)
    root.set('version', valid.version)
    const slides = new Y.Array<Y.Map<unknown>>()
    slides.push(valid.slides.map(slideToY))
    root.set('slides', slides)
  })
  return doc
}

function yToSlide(map: Y.Map<unknown>): Slide {
  const notes = (map.get('notes') as Y.Text).toString()
  const slide: Slide = {
    id: map.get('id') as string,
    frontmatter: map.get('frontmatter') as Record<string, unknown>,
    elements: (map.get('elements') as Y.Array<Y.Map<unknown>>).map(element => elementValues(element) as DeckElement),
  }
  if (notes)
    slide.notes = notes
  return slide
}

/**
 * Reads the live document back into a validated deck. It throws when
 * anything in it is not valid; views use the lenient `readDeckDoc`.
 */
export function yDocToDeck(doc: Y.Doc): Deck {
  const root = doc.getMap<unknown>(DECK_KEY)
  const slides = root.get('slides') as Y.Array<Y.Map<unknown>> | undefined
  return DeckSchema.parse({
    version: root.get('version') ?? DECK_VERSION,
    slides: slides ? slides.map(yToSlide) : [],
  })
}

export function findSlide(doc: Y.Doc, slideId: string): Y.Map<unknown> | undefined {
  return slidesOf(doc)?.toArray().find((slide): slide is Y.Map<unknown> => slide instanceof Y.Map && slide.get('id') === slideId)
}

export function findElement(doc: Y.Doc, slideId: string, elementId: string): Y.Map<unknown> | undefined {
  const elements = findSlide(doc, slideId)?.get('elements')
  if (!(elements instanceof Y.Array))
    return undefined
  return elements.toArray().find((element): element is Y.Map<unknown> => element instanceof Y.Map && element.get('id') === elementId)
}

/** The shared text of a text or raw element, for editors to bind to. */
export function elementText(doc: Y.Doc, slideId: string, elementId: string): Y.Text {
  const text = findElement(doc, slideId, elementId)?.get('markdown')
  if (!(text instanceof Y.Text))
    throw new Error(`Element "${elementId}" on slide "${slideId}" has no text`)
  return text
}
