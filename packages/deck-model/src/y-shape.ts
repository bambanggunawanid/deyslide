import type { z } from 'zod'
import type { DeckElement, Position, Slide } from './schema.ts'
import * as Y from 'yjs'
import { ElementSchema, isFrontmatterValue } from './schema.ts'

/** The root map. The shape below it is described in `ydoc.ts`. */
export const DECK_KEY = 'deck'

export const POSITION_KEYS = ['x', 'y', 'w', 'h', 'rotate'] as const

/** Thrown when a document has no deck in it yet, for example before its first sync. */
export class DeckNotLoadedError extends Error {
  constructor() {
    super('The deck is not loaded yet')
    this.name = 'DeckNotLoadedError'
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Stored frontmatter as a valid deck holds it: anything that is not a plain
 * map reads as empty, and keys whose values YAML cannot write are left out.
 */
export function readFrontmatter(value: unknown): Record<string, unknown> {
  if (!isRecord(value))
    return {}
  if (isFrontmatterValue(value))
    return value
  // A map made by JSON or YAML, not an instance of a class.
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null)
    return {}
  return Object.fromEntries(Object.entries(value).filter(([, item]) => isFrontmatterValue(item, 1)))
}

/** Equal JSON values, with object keys in the same order (the order YAML is written in). */
export function sameJson(a: unknown, b: unknown): boolean {
  if (Object.is(a, b))
    return true
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length
      && a.every((item, index) => sameJson(item, b[index]))
  }
  if (!isRecord(a) || !isRecord(b))
    return false
  const keys = Object.keys(a)
  const other = Object.keys(b)
  return keys.length === other.length
    && keys.every((key, index) => key === other[index] && sameJson(a[key], b[key]))
}

export function zodMessage(error: z.ZodError) {
  const [issue] = error.issues
  return issue ? `${issue.path.join('.') || 'value'}: ${issue.message}` : error.message
}

/** The slides array, or undefined while the document holds no deck. */
export function slidesOf(doc: Y.Doc): Y.Array<unknown> | undefined {
  const slides = doc.getMap<unknown>(DECK_KEY).get('slides')
  return slides instanceof Y.Array ? slides : undefined
}

/**
 * Whether the document has received a deck, even a broken one: its root has
 * a version or a slides entry. A document before its first sync has neither.
 */
export function hasDeck(doc: Y.Doc): boolean {
  const root = doc.getMap<unknown>(DECK_KEY)
  return root.has('slides') || root.has('version')
}

export function loadedSlides(doc: Y.Doc): Y.Array<unknown> {
  const slides = slidesOf(doc)
  if (!slides)
    throw new DeckNotLoadedError()
  return slides
}

export function positionToY(pos: Position) {
  const map = new Y.Map<number | null>()
  for (const key of POSITION_KEYS)
    map.set(key, pos[key])
  return map
}

export function elementToY(element: DeckElement) {
  const map = new Y.Map<unknown>()
  for (const [key, value] of Object.entries(element)) {
    if (key === 'pos')
      map.set(key, positionToY(value as Position))
    else if (key === 'markdown')
      map.set(key, new Y.Text(value as string))
    else
      map.set(key, value)
  }
  return map
}

export function slideToY(slide: Slide) {
  const map = new Y.Map<unknown>()
  map.set('id', slide.id)
  map.set('frontmatter', slide.frontmatter)
  map.set('notes', new Y.Text(slide.notes ?? ''))
  const elements = new Y.Array<Y.Map<unknown>>()
  elements.push(slide.elements.map(elementToY))
  map.set('elements', elements)
  return map
}

/** An element map as plain values, without checking it. */
export function elementValues(map: Y.Map<unknown>): Record<string, unknown> {
  const element: Record<string, unknown> = {}
  for (const [key, value] of map.entries()) {
    if (value instanceof Y.Map)
      element[key] = value.toJSON()
    else if (value instanceof Y.Text)
      element[key] = value.toString()
    else
      element[key] = value
  }
  return element
}

/** The element a map holds, or undefined when it does not pass the schema. */
export function readElement(value: unknown): DeckElement | undefined {
  if (!(value instanceof Y.Map))
    return undefined
  const result = ElementSchema.safeParse(elementValues(value))
  return result.success ? result.data : undefined
}

/** A slide read leniently, with the maps behind it. */
export interface SlideEntry {
  map: Y.Map<unknown>
  /** The slide without the elements that fail the schema. */
  slide: Slide
  /** Every entry of the elements array, in order, with the element when it is valid. */
  elements: { map: unknown, element?: DeckElement }[]
}

/**
 * Reads a slide map, skipping elements that fail the schema. Missing or
 * broken frontmatter, notes and elements read as empty. Returns undefined
 * for something that is not a slide map with an id.
 */
export function readSlideEntry(value: unknown): SlideEntry | undefined {
  if (!(value instanceof Y.Map))
    return undefined
  const id = value.get('id')
  if (typeof id !== 'string' || !id)
    return undefined
  const frontmatter = value.get('frontmatter')
  const notes = value.get('notes')
  const array = value.get('elements')
  const elements = array instanceof Y.Array
    ? array.toArray().map(map => ({ map, element: readElement(map) }))
    : []
  const slide: Slide = {
    id,
    frontmatter: readFrontmatter(frontmatter),
    elements: elements.flatMap(entry => entry.element ? [entry.element] : []),
  }
  const text = notes instanceof Y.Text ? notes.toString() : ''
  if (text)
    slide.notes = text
  return { map: value, slide, elements }
}
