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

// Settings --------------------------------------------------------------------
//
// An element's `props` and a slide's `frontmatter` are stored as a Y.Map
// with one entry per top level key, so two people changing different keys
// at once both keep their change. Decks stored before this hold one plain
// object instead: readers accept both shapes, and the first change writes
// the map.
//
// Props entries are the plain values. Their order does not matter, because
// the schema puts them in its own order when an element is read.
//
// Frontmatter keys are written to YAML in their order, but peers can see the
// keys of a Y.Map in different orders. So each frontmatter entry is
// `{ value, order }`, and keys are read sorted by `order`, then by key (two
// people adding a key at once can pick the same number).

/** One stored frontmatter key. */
export interface FrontmatterEntry {
  value: unknown
  order: number
}

export function isFrontmatterEntry(entry: unknown): entry is FrontmatterEntry {
  return isRecord(entry) && typeof entry.order === 'number' && Number.isFinite(entry.order)
}

/** The well formed entries of a frontmatter map, in their order. */
function frontmatterEntries(map: Y.Map<unknown>): [string, FrontmatterEntry][] {
  const entries: [string, FrontmatterEntry][] = []
  for (const [key, entry] of map.entries()) {
    if (isFrontmatterEntry(entry))
      entries.push([key, entry])
  }
  return entries.sort(([a, first], [b, second]) => first.order - second.order || (a < b ? -1 : a > b ? 1 : 0))
}

/**
 * Frontmatter as stored, as one plain value: a frontmatter map's keys in
 * their order (leaving out entries that are not stored the right way), or an
 * older plain value as it is.
 */
export function storedFrontmatter(value: unknown): unknown {
  if (!(value instanceof Y.Map))
    return value
  return Object.fromEntries(frontmatterEntries(value).map(([key, entry]) => [key, entry.value]))
}

export function frontmatterToY(frontmatter: Record<string, unknown>) {
  const map = new Y.Map<unknown>()
  for (const [order, [key, value]] of Object.entries(frontmatter).entries())
    map.set(key, { value, order } satisfies FrontmatterEntry)
  return map
}

/**
 * The order number of each key of `keys`. Keys the map holds keep theirs
 * while they stay in the same order, and new keys fit between their
 * neighbors. When keys changed places, or no number fits, every key is
 * numbered again from 0.
 */
function frontmatterOrders(map: Y.Map<unknown>, keys: string[]): number[] {
  const stored = new Map(frontmatterEntries(map).map(([key, entry]) => [key, entry.order]))
  const orders: (number | undefined)[] = keys.map(key => stored.get(key))
  const renumbered = keys.map((_, index) => index)
  let last = Number.NEGATIVE_INFINITY
  for (const order of orders) {
    if (order === undefined)
      continue
    if (!(order > last))
      return renumbered
    last = order
  }
  for (let index = 0; index < keys.length; index++) {
    if (orders[index] !== undefined)
      continue
    const before = index > 0 ? orders[index - 1] : undefined
    const after = orders.slice(index + 1).find(order => order !== undefined)
    const order = before === undefined
      ? (after === undefined ? 0 : after - 1)
      : (after === undefined ? before + 1 : (before + after) / 2)
    if ((before !== undefined && !(order > before)) || (after !== undefined && !(order < after)))
      return renumbered
    orders[index] = order
  }
  return orders as number[]
}

/**
 * Makes a slide map hold `frontmatter`. A frontmatter map changes only the
 * keys whose value or place differs and deletes the keys that are gone; an
 * older plain value becomes a frontmatter map. Runs inside the caller's
 * transaction.
 */
export function writeFrontmatter(slide: Y.Map<unknown>, frontmatter: Record<string, unknown>) {
  const map = slide.get('frontmatter')
  if (!(map instanceof Y.Map)) {
    if (!isRecord(map) || !sameJson(map, frontmatter))
      slide.set('frontmatter', frontmatterToY(frontmatter))
    return
  }
  const keys = Object.keys(frontmatter)
  for (const key of [...map.keys()]) {
    if (!Object.hasOwn(frontmatter, key) || !isFrontmatterEntry(map.get(key)))
      map.delete(key)
  }
  const orders = frontmatterOrders(map, keys)
  for (const [index, key] of keys.entries()) {
    const entry = map.get(key)
    const value = frontmatter[key]
    if (!isFrontmatterEntry(entry) || entry.order !== orders[index] || !sameJson(entry.value, value))
      map.set(key, { value, order: orders[index] } satisfies FrontmatterEntry)
  }
}

export function propsToY(props: Record<string, unknown>) {
  const map = new Y.Map<unknown>()
  for (const [key, value] of Object.entries(props))
    map.set(key, value)
  return map
}

/**
 * Makes an element map hold `props`. A props map changes only the keys whose
 * value differs and deletes the keys that are gone; an older plain value
 * becomes a props map. Runs inside the caller's transaction.
 */
export function writeProps(element: Y.Map<unknown>, props: Record<string, unknown>) {
  const map = element.get('props')
  if (!(map instanceof Y.Map)) {
    if (!sameJson(map, props))
      element.set('props', propsToY(props))
    return
  }
  for (const key of [...map.keys()]) {
    if (!Object.hasOwn(props, key))
      map.delete(key)
  }
  for (const [key, value] of Object.entries(props)) {
    if (!map.has(key) || !sameJson(map.get(key), value))
      map.set(key, value)
  }
}

/** A copy of a shared value, or the value itself when it is plain. */
function cloneValue(value: unknown) {
  return value instanceof Y.AbstractType ? value.clone() : value
}

/**
 * A copy of an element map, to insert elsewhere: Yjs cannot move a shared
 * type. Older plain props are copied as a props map, like any other write.
 */
export function cloneElement(map: Y.Map<unknown>): Y.Map<unknown> {
  const copy = new Y.Map<unknown>()
  for (const [key, value] of map.entries()) {
    const plainProps = key === 'props' && !(value instanceof Y.Map) && isRecord(value)
    copy.set(key, plainProps ? propsToY(value) : cloneValue(value))
  }
  return copy
}

/**
 * A copy of a slide map and its elements, to insert elsewhere. Older plain
 * frontmatter and props are copied as maps, like any other write.
 */
export function cloneSlide(map: Y.Map<unknown>): Y.Map<unknown> {
  const copy = new Y.Map<unknown>()
  for (const [key, value] of map.entries()) {
    if (key === 'frontmatter' && !(value instanceof Y.Map) && isRecord(value)) {
      copy.set(key, frontmatterToY(value))
    }
    else if (key === 'elements' && value instanceof Y.Array) {
      const elements = new Y.Array<unknown>()
      elements.push(value.toArray().map(element => element instanceof Y.Map ? cloneElement(element) : cloneValue(element)))
      copy.set(key, elements)
    }
    else {
      copy.set(key, cloneValue(value))
    }
  }
  return copy
}

export function elementToY(element: DeckElement) {
  const map = new Y.Map<unknown>()
  for (const [key, value] of Object.entries(element)) {
    if (key === 'pos')
      map.set(key, positionToY(value as Position))
    else if (key === 'markdown')
      map.set(key, new Y.Text(value as string))
    else if (key === 'props')
      map.set(key, propsToY(value as Record<string, unknown>))
    else
      map.set(key, value)
  }
  return map
}

export function slideToY(slide: Slide) {
  const map = new Y.Map<unknown>()
  map.set('id', slide.id)
  map.set('frontmatter', frontmatterToY(slide.frontmatter))
  map.set('notes', new Y.Text(slide.notes ?? ''))
  const elements = new Y.Array<Y.Map<unknown>>()
  elements.push(slide.elements.map(elementToY))
  map.set('elements', elements)
  return map
}

/**
 * An element map as plain values, without checking it. A props map reads as
 * its keys and values, like an older plain props value.
 */
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
    frontmatter: readFrontmatter(storedFrontmatter(frontmatter)),
    elements: elements.flatMap(entry => entry.element ? [entry.element] : []),
  }
  const text = notes instanceof Y.Text ? notes.toString() : ''
  if (text)
    slide.notes = text
  return { map: value, slide, elements }
}
