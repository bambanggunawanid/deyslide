import type { z } from 'zod'
import type { CodeStep, DeckElement, Position, Slide, TextElement } from './schema.ts'
import * as Y from 'yjs'
import { newId } from './ids.ts'
import { SLIDE_ID_KEY } from './markdown.ts'
import { ElementSchema, SlideSchema } from './schema.ts'
import { applyTextDiff } from './text-diff.ts'
import {
  cloneElement,
  cloneSlide,
  elementToY,
  elementValues,
  isRecord,
  loadedSlides,
  POSITION_KEYS,
  positionToY,
  readElement,
  readSlideEntry,
  sameJson,
  slideToY,
  storedFrontmatter,
  writeFrontmatter,
  writeProps,
  zodMessage,
} from './y-shape.ts'

// Structural edits to the live document, for the canvas and other views.
// Each one checks its input first, so a bad call throws a clear error and
// changes nothing, and then runs in one transaction with the given origin.
// All of them throw `DeckNotLoadedError` while the document holds no deck.

function valid<T>(schema: z.ZodType<T>, input: unknown, what: string): T {
  const result = schema.safeParse(input)
  if (!result.success)
    throw new Error(`The ${what} is not valid: ${zodMessage(result.error)}`)
  return result.data
}

function checkIndex(index: number, length: number, what: string) {
  if (!Number.isInteger(index) || index < 0 || index > length)
    throw new Error(`The ${what} position must be a whole number from 0 to ${length}`)
}

function checkFrontmatter(frontmatter: Record<string, unknown>) {
  if (SLIDE_ID_KEY in frontmatter)
    throw new Error(`The frontmatter key "${SLIDE_ID_KEY}" is kept for the slide id`)
}

function checkUniqueElementIds(elements: DeckElement[]) {
  const ids = new Set<string>()
  for (const element of elements) {
    if (ids.has(element.id))
      throw new Error(`Two elements have the id "${element.id}"`)
    ids.add(element.id)
  }
}

function locateSlide(doc: Y.Doc, slideId: string) {
  const slides = loadedSlides(doc)
  const index = slides.toArray().findIndex(slide => slide instanceof Y.Map && slide.get('id') === slideId)
  if (index < 0)
    throw new Error(`No slide "${slideId}"`)
  return { slides, index, map: slides.get(index) as Y.Map<unknown> }
}

function slideElements(map: Y.Map<unknown>, slideId: string) {
  const elements = map.get('elements')
  if (!(elements instanceof Y.Array))
    throw new Error(`Slide "${slideId}" has no elements list`)
  return elements as Y.Array<unknown>
}

function locateElement(doc: Y.Doc, slideId: string, elementId: string) {
  const slide = locateSlide(doc, slideId)
  const elements = slideElements(slide.map, slideId)
  const index = elements.toArray().findIndex(element => element instanceof Y.Map && element.get('id') === elementId)
  if (index < 0)
    throw new Error(`No element "${elementId}" on slide "${slideId}"`)
  return { elements, index, map: elements.get(index) as Y.Map<unknown> }
}

/**
 * Checks position fields and keeps sizes from going negative. A height of
 * null means auto height.
 */
function clampPosition(change: Partial<Position>): Partial<Position> {
  const result: Partial<Position> = {}
  for (const [key, value] of Object.entries(change)) {
    if (value === undefined)
      continue
    if (!(POSITION_KEYS as readonly string[]).includes(key))
      throw new Error(`"${key}" is not a position field`)
    if (key === 'h' && value === null) {
      result.h = null
      continue
    }
    if (typeof value !== 'number' || !Number.isFinite(value))
      throw new Error(`The position field "${key}" must be a finite number`)
    result[key as keyof Position] = key === 'w' || key === 'h' ? Math.max(0, value) : value
  }
  return result
}

export function insertSlide(doc: Y.Doc, index: number, slide: Slide, origin?: unknown) {
  const slides = loadedSlides(doc)
  const next = valid(SlideSchema, slide, 'slide')
  checkFrontmatter(next.frontmatter)
  checkUniqueElementIds(next.elements)
  checkIndex(index, slides.length, 'slide')
  if (slides.toArray().some(value => value instanceof Y.Map && value.get('id') === next.id))
    throw new Error(`A slide with the id "${next.id}" already exists`)
  doc.transact(() => slides.insert(index, [slideToY(next)]), origin)
}

/** Deletes a slide. A deck keeps at least one slide. */
export function deleteSlide(doc: Y.Doc, slideId: string, origin?: unknown) {
  const { slides, index } = locateSlide(doc, slideId)
  if (slides.length <= 1)
    throw new Error('A deck needs at least one slide')
  doc.transact(() => slides.delete(index, 1), origin)
}

/**
 * Moves a slide so it ends up at `toIndex`. Yjs cannot move a shared type, so
 * this deletes the slide and inserts a copy with the same id and content.
 * Edits other people make to that slide while the move syncs are lost.
 */
export function moveSlide(doc: Y.Doc, slideId: string, toIndex: number, origin?: unknown) {
  const { slides, index, map } = locateSlide(doc, slideId)
  checkIndex(toIndex, slides.length - 1, 'slide')
  if (toIndex === index)
    return
  const copy = cloneSlide(map)
  doc.transact(() => {
    slides.delete(index, 1)
    slides.insert(toIndex, [copy])
  }, origin)
}

/** Copies a slide, with fresh ids, right after it. Returns the new slide's id. */
export function duplicateSlide(doc: Y.Doc, slideId: string, origin?: unknown): string {
  const { slides, index, map } = locateSlide(doc, slideId)
  const entry = readSlideEntry(map)
  if (!entry)
    throw new Error(`Slide "${slideId}" cannot be read`)
  const copy: Slide = {
    ...entry.slide,
    id: newId('s'),
    elements: entry.slide.elements.map(element => ({ ...element, id: newId('e') })),
  }
  doc.transact(() => slides.insert(index + 1, [slideToY(copy)]), origin)
  return copy.id
}

/**
 * Makes a slide's frontmatter `frontmatter`: keys left out are deleted.
 * Only the keys whose value or place changed are written, so someone
 * changing another key at the same time keeps their change.
 */
export function setFrontmatter(doc: Y.Doc, slideId: string, frontmatter: Record<string, unknown>, origin?: unknown) {
  const { map } = locateSlide(doc, slideId)
  const next = valid(SlideSchema.shape.frontmatter, frontmatter, 'frontmatter')
  checkFrontmatter(next)
  const stored = map.get('frontmatter')
  if (stored instanceof Y.Map ? sameStoredFrontmatter(stored, next) : isRecord(stored) && sameJson(stored, next))
    return
  doc.transact(() => writeFrontmatter(map, next), origin)
}

/** Whether a frontmatter map already holds `next`, with nothing stored the wrong way. */
function sameStoredFrontmatter(map: Y.Map<unknown>, next: Record<string, unknown>) {
  return map.size === Object.keys(next).length && sameJson(storedFrontmatter(map), next)
}

export function setNotes(doc: Y.Doc, slideId: string, notes: string, origin?: unknown) {
  const { map } = locateSlide(doc, slideId)
  if (typeof notes !== 'string')
    throw new Error('Notes must be text')
  doc.transact(() => {
    const text = map.get('notes')
    if (text instanceof Y.Text)
      applyTextDiff(text, notes)
    else
      map.set('notes', new Y.Text(notes))
  }, origin)
}

/** Inserts an element. Its place in the list is its place in the paint order. */
export function insertElement(doc: Y.Doc, slideId: string, index: number, element: DeckElement, origin?: unknown) {
  const { map } = locateSlide(doc, slideId)
  const elements = slideElements(map, slideId)
  const next = valid(ElementSchema, element, 'element')
  checkIndex(index, elements.length, 'element')
  if (elements.toArray().some(value => value instanceof Y.Map && value.get('id') === next.id))
    throw new Error(`Slide "${slideId}" already has an element with the id "${next.id}"`)
  doc.transact(() => elements.insert(index, [elementToY(next)]), origin)
}

export function deleteElement(doc: Y.Doc, slideId: string, elementId: string, origin?: unknown) {
  const { elements, index } = locateElement(doc, slideId, elementId)
  doc.transact(() => elements.delete(index, 1), origin)
}

/**
 * Moves an element in the paint order (later elements are drawn on top).
 * Like `moveSlide`, it inserts a copy, so concurrent edits to it are lost.
 */
export function moveElementInStack(doc: Y.Doc, slideId: string, elementId: string, toIndex: number, origin?: unknown) {
  const { elements, index, map } = locateElement(doc, slideId, elementId)
  checkIndex(toIndex, elements.length - 1, 'element')
  if (toIndex === index)
    return
  const copy = cloneElement(map)
  doc.transact(() => {
    elements.delete(index, 1)
    elements.insert(toIndex, [copy])
  }, origin)
}

/**
 * Copies an element right above it, shifted by `offset` (raw elements have no
 * position and are copied as they are). Returns the new element's id.
 */
export function duplicateElement(doc: Y.Doc, slideId: string, elementId: string, offset: { x: number, y: number }, origin?: unknown): string {
  const { elements, index, map } = locateElement(doc, slideId, elementId)
  const element = readElement(map)
  if (!element)
    throw new Error(`Element "${elementId}" on slide "${slideId}" is not valid`)
  for (const key of ['x', 'y'] as const) {
    if (typeof offset?.[key] !== 'number' || !Number.isFinite(offset[key]))
      throw new Error(`The offset field "${key}" must be a finite number`)
  }
  const copy = valid(ElementSchema, element.type === 'raw'
    ? { ...element, id: newId('e') }
    : { ...element, id: newId('e'), pos: { ...element.pos, x: element.pos.x + offset.x, y: element.pos.y + offset.y } }, 'element')
  doc.transact(() => elements.insert(index + 1, [elementToY(copy)]), origin)
  return copy.id
}

/** Fields `updateElement` can change. Which ones apply depends on the element type. */
export interface ElementPatch {
  type?: DeckElement['type']
  id?: string
  pos?: Partial<Position>
  markdown?: string
  src?: string
  alt?: string
  props?: Record<string, unknown>
  steps?: CodeStep[]
}

const FIELDS: Record<DeckElement['type'], string[]> = {
  'text': ['pos', 'markdown'],
  'raw': ['markdown'],
  'image': ['pos', 'src', 'alt'],
  'code': ['pos', 'steps'],
  'shape': ['pos', 'props'],
  'scene3d': ['pos', 'props'],
  'algo-player': ['pos', 'props'],
  'sandbox': ['pos', 'props'],
}

/**
 * Changes an element in place: position fields one by one (clamped, so
 * people moving different axes both win), Markdown as a text diff (so
 * concurrent typing merges), `props` key by key (so people changing
 * different settings both win; keys left out are deleted), and `src`, `alt`
 * or `steps` as whole values. Only what differs is written. The type and
 * the id cannot change.
 */
export function updateElement(doc: Y.Doc, slideId: string, elementId: string, patch: ElementPatch, origin?: unknown) {
  const { map } = locateElement(doc, slideId, elementId)
  const current = elementValues(map) as Record<string, unknown> & { type: DeckElement['type'] }
  if (patch.type !== undefined && patch.type !== current.type)
    throw new Error(`An element cannot change its type from ${current.type} to ${patch.type}`)
  if (patch.id !== undefined && patch.id !== current.id)
    throw new Error('An element cannot change its id')
  const allowed = FIELDS[current.type] ?? []
  for (const [key, value] of Object.entries(patch)) {
    if (value !== undefined && key !== 'type' && key !== 'id' && !allowed.includes(key))
      throw new Error(`A ${current.type} element has no field "${key}"`)
  }
  const pos = patch.pos === undefined ? undefined : clampPosition(patch.pos)
  const merged: Record<string, unknown> = { ...current }
  for (const key of allowed) {
    const value = patch[key as keyof ElementPatch]
    if (value !== undefined)
      merged[key] = key === 'pos' ? { ...(current.pos as Position), ...pos } : value
  }
  const next = valid(ElementSchema, merged, 'element')

  doc.transact(() => {
    if (pos && 'pos' in next) {
      const posMap = map.get('pos')
      if (posMap instanceof Y.Map) {
        for (const [key, value] of Object.entries(pos)) {
          if (!Object.is(posMap.get(key), value))
            posMap.set(key, value)
        }
      }
      else {
        map.set('pos', positionToY(next.pos))
      }
    }
    if (patch.markdown !== undefined && 'markdown' in next) {
      const text = map.get('markdown')
      if (text instanceof Y.Text)
        applyTextDiff(text, next.markdown)
      else
        map.set('markdown', new Y.Text(next.markdown))
    }
    if (patch.props !== undefined && 'props' in next)
      writeProps(map, next.props)
    for (const key of ['src', 'alt', 'steps'] as const) {
      if (patch[key] !== undefined && !sameJson(map.get(key), (next as Record<string, unknown>)[key]))
        map.set(key, (next as Record<string, unknown>)[key])
    }
  }, origin)
}

/** Moves or resizes an element. Only the fields given change, so concurrent edits to other fields survive. */
export function moveElement(doc: Y.Doc, slideId: string, elementId: string, change: Partial<Position>, origin?: unknown) {
  const { map } = locateElement(doc, slideId, elementId)
  if (!(map.get('pos') instanceof Y.Map))
    throw new Error(`No positioned element "${elementId}" on slide "${slideId}"`)
  updateElement(doc, slideId, elementId, { pos: change }, origin)
}

/**
 * Turns a raw block into a text element with the same Markdown at `pos`, in
 * the same place in the paint order, with a fresh id. Returns that id.
 */
export function makeMovable(doc: Y.Doc, slideId: string, rawElementId: string, pos: Position, origin?: unknown): string {
  const { elements, index, map } = locateElement(doc, slideId, rawElementId)
  const raw = readElement(map)
  if (raw?.type !== 'raw')
    throw new Error(`Element "${rawElementId}" on slide "${slideId}" is not a raw block`)
  const text: TextElement = { id: newId('e'), type: 'text', pos: { ...pos, ...clampPosition(pos) } as Position, markdown: raw.markdown }
  const next = valid(ElementSchema, text, 'element')
  doc.transact(() => {
    elements.delete(index, 1)
    elements.insert(index, [elementToY(next)])
  }, origin)
  return next.id
}
