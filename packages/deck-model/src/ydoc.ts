import type { Deck, DeckElement, Slide } from './schema.ts'
import * as Y from 'yjs'
import { DECK_VERSION, DeckSchema } from './schema.ts'
import { DECK_KEY, elementValues, isFrontmatterEntry, readFrontmatter, slidesOf, slideToY, storedFrontmatter } from './y-shape.ts'

/**
 * Shape of the live document:
 *
 *   deck: Y.Map
 *     version: number
 *     slides: Y.Array<Y.Map>
 *       id, notes: Y.Text
 *       frontmatter: Y.Map                  one entry per key, so two people
 *                                           changing different keys both win
 *         <key>: Y.Map (value, order)       two fields, so moving a key
 *                                           never writes its value
 *       elements: Y.Array<Y.Map>
 *         id, type
 *         pos: Y.Map (x, y, w, h, rotate)   one key per field, so two people
 *                                           moving different axes both win
 *         props: Y.Map                      one entry per setting, for the
 *                                           same reason
 *         markdown: Y.Text                  text and raw elements, so
 *                                           concurrent typing merges
 *         every other field as plain JSON
 *
 * Decks stored before frontmatter and props were split hold each of them as
 * one plain JSON value. Readers accept both. The server converts a cloud
 * deck when its room loads (`upgradeDeckDoc`); anywhere else, the first
 * change to one of them writes the map (see `y-shape.ts`). The shape number
 * is `LIVE_SHAPE`.
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
  const frontmatter = map.get('frontmatter')
  if (frontmatter instanceof Y.Map && [...frontmatter.values()].some(entry => !isFrontmatterEntry(entry)))
    throw new Error(`The frontmatter of slide "${String(map.get('id'))}" is not stored the right way`)
  const slide: Slide = {
    id: map.get('id') as string,
    frontmatter: storedFrontmatter(frontmatter) as Record<string, unknown>,
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

/**
 * A slide map's frontmatter as views show it, in either stored shape. Values
 * YAML cannot write are left out.
 */
export function slideFrontmatter(slide: Y.Map<unknown>): Record<string, unknown> {
  return readFrontmatter(storedFrontmatter(slide.get('frontmatter')))
}

/** The shared text of a text or raw element, for editors to bind to. */
export function elementText(doc: Y.Doc, slideId: string, elementId: string): Y.Text {
  const text = findElement(doc, slideId, elementId)?.get('markdown')
  if (!(text instanceof Y.Text))
    throw new Error(`Element "${elementId}" on slide "${slideId}" has no text`)
  return text
}
