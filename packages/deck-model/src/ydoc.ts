import type { Deck, DeckElement, Position, Slide } from './schema.ts'
import * as Y from 'yjs'
import { DECK_VERSION, DeckSchema } from './schema.ts'

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
export const DECK_KEY = 'deck'

const TEXT_FIELDS = new Set(['markdown'])

function positionToY(pos: Position) {
  const map = new Y.Map<number | null>()
  for (const [key, value] of Object.entries(pos))
    map.set(key, value)
  return map
}

function elementToY(element: DeckElement) {
  const map = new Y.Map<unknown>()
  for (const [key, value] of Object.entries(element)) {
    if (key === 'pos')
      map.set(key, positionToY(value as Position))
    else if (TEXT_FIELDS.has(key))
      map.set(key, new Y.Text(value as string))
    else
      map.set(key, value)
  }
  return map
}

function slideToY(slide: Slide) {
  const map = new Y.Map<unknown>()
  map.set('id', slide.id)
  map.set('frontmatter', slide.frontmatter)
  map.set('notes', new Y.Text(slide.notes ?? ''))
  const elements = new Y.Array<Y.Map<unknown>>()
  elements.push(slide.elements.map(elementToY))
  map.set('elements', elements)
  return map
}

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

function yToElement(map: Y.Map<unknown>): DeckElement {
  const element: Record<string, unknown> = {}
  for (const [key, value] of map.entries()) {
    if (value instanceof Y.Map)
      element[key] = value.toJSON()
    else if (value instanceof Y.Text)
      element[key] = value.toString()
    else
      element[key] = value
  }
  return element as DeckElement
}

function yToSlide(map: Y.Map<unknown>): Slide {
  const notes = (map.get('notes') as Y.Text).toString()
  const slide: Slide = {
    id: map.get('id') as string,
    frontmatter: map.get('frontmatter') as Record<string, unknown>,
    elements: (map.get('elements') as Y.Array<Y.Map<unknown>>).map(yToElement),
  }
  if (notes)
    slide.notes = notes
  return slide
}

/** Reads the live document back into a validated deck. */
export function yDocToDeck(doc: Y.Doc): Deck {
  const root = doc.getMap<unknown>(DECK_KEY)
  const slides = root.get('slides') as Y.Array<Y.Map<unknown>> | undefined
  return DeckSchema.parse({
    version: root.get('version') ?? DECK_VERSION,
    slides: slides ? slides.map(yToSlide) : [],
  })
}

export function findSlide(doc: Y.Doc, slideId: string): Y.Map<unknown> | undefined {
  const slides = doc.getMap<unknown>(DECK_KEY).get('slides') as Y.Array<Y.Map<unknown>> | undefined
  return slides?.toArray().find(slide => slide.get('id') === slideId)
}

export function findElement(doc: Y.Doc, slideId: string, elementId: string): Y.Map<unknown> | undefined {
  const elements = findSlide(doc, slideId)?.get('elements') as Y.Array<Y.Map<unknown>> | undefined
  return elements?.toArray().find(element => element.get('id') === elementId)
}

/** Moves an element. Only the fields given change, so concurrent edits to other fields survive. */
export function moveElement(doc: Y.Doc, slideId: string, elementId: string, change: Partial<Position>) {
  const pos = findElement(doc, slideId, elementId)?.get('pos') as Y.Map<number | null> | undefined
  if (!pos)
    throw new Error(`No positioned element "${elementId}" on slide "${slideId}"`)
  doc.transact(() => {
    for (const [key, value] of Object.entries(change)) {
      if (value !== undefined)
        pos.set(key, value)
    }
  })
}

/** The shared text of a text or raw element, for editors to bind to. */
export function elementText(doc: Y.Doc, slideId: string, elementId: string): Y.Text {
  const text = findElement(doc, slideId, elementId)?.get('markdown')
  if (!(text instanceof Y.Text))
    throw new Error(`Element "${elementId}" on slide "${slideId}" has no text`)
  return text
}
