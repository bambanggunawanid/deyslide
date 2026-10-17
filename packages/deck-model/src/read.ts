import type { Deck, Slide } from './schema.ts'
import * as Y from 'yjs'
import { newId } from './ids.ts'
import { elementToMarkdown, slideToMarkdown } from './markdown.ts'
import { DECK_VERSION, DeckSchema, ElementSchema, isFrontmatterValue } from './schema.ts'
import {
  DECK_KEY,
  DeckNotLoadedError,
  elementValues,
  frontmatterEntry,
  frontmatterToY,
  hasDeck,
  isFrontmatterEntry,
  isRecord,
  POSITION_KEYS,
  positionToY,
  propsToY,
  readElement,
  readFrontmatter,
  readSlideEntry,
  slidesOf,
  slideToY,
  storedFrontmatter,
  zodMessage,
} from './y-shape.ts'

/** What views show while a document briefly has no slides, until a repair adds one. */
function emptySlide(): Slide {
  return { id: 'slide-1', frontmatter: {}, elements: [] }
}

/**
 * Reads the live document for views. Unlike `yDocToDeck` it never throws for
 * a loaded document: elements that fail the schema are left out, and a
 * document without slides (or with a broken slides list) reads as one empty
 * slide. Throws `DeckNotLoadedError` when the document holds no deck yet.
 */
export function readDeckDoc(doc: Y.Doc): Deck {
  if (!hasDeck(doc))
    throw new DeckNotLoadedError()
  const slides = (slidesOf(doc)?.toArray() ?? []).flatMap((value) => {
    const entry = readSlideEntry(value)
    return entry ? [entry.slide] : []
  })
  return { version: DECK_VERSION, slides: slides.length > 0 ? slides : [emptySlide()] }
}

export type DeckCheck = { ok: true, deck: Deck } | { ok: false, message: string }

/** Whether the document holds a valid deck, with unique slide ids and element ids unique on each slide. */
export function checkDeckDoc(doc: Y.Doc): DeckCheck {
  const slides = slidesOf(doc)
  if (!slides)
    return { ok: false, message: hasDeck(doc) ? 'The deck has no list of slides' : 'The deck is not loaded yet' }
  const version = doc.getMap<unknown>(DECK_KEY).get('version')
  const deck: Record<string, unknown> & { slides: unknown[] } = { version: version ?? DECK_VERSION, slides: [] }
  const slideIds = new Set<string>()
  for (const [index, value] of slides.toArray().entries()) {
    const where = `Slide ${index + 1}`
    if (!(value instanceof Y.Map))
      return { ok: false, message: `${where} is not a slide` }
    const notes = value.get('notes')
    const elements = value.get('elements')
    if (!(notes instanceof Y.Text) || !(elements instanceof Y.Array))
      return { ok: false, message: `${where} has no notes or no elements` }
    const frontmatter = value.get('frontmatter')
    if (frontmatter instanceof Y.Map && [...frontmatter.values()].some(entry => !isFrontmatterEntry(entry)))
      return { ok: false, message: `${where} has frontmatter that is not stored the right way` }
    const id = value.get('id')
    if (typeof id === 'string' && slideIds.has(id))
      return { ok: false, message: `${where} has the same id as another slide` }
    slideIds.add(id as string)
    const elementIds = new Set<string>()
    const items: unknown[] = []
    for (const [position, element] of elements.toArray().entries()) {
      if (!(element instanceof Y.Map))
        return { ok: false, message: `${where}, element ${position + 1} is not an element` }
      const values = elementValues(element)
      const textual = values.type === 'text' || values.type === 'raw'
      if (textual !== (element.get('markdown') instanceof Y.Text) || ('pos' in values) !== (element.get('pos') instanceof Y.Map))
        return { ok: false, message: `${where}, element ${position + 1} is not stored the right way` }
      if (typeof values.id === 'string' && elementIds.has(values.id))
        return { ok: false, message: `${where} has two elements with the id "${values.id}"` }
      elementIds.add(values.id as string)
      items.push(values)
    }
    const slide: Record<string, unknown> = { id, frontmatter: storedFrontmatter(frontmatter), elements: items }
    if (notes.length > 0)
      slide.notes = notes.toString()
    deck.slides.push(slide)
  }
  const result = DeckSchema.safeParse(deck)
  return result.success ? { ok: true, deck: result.data } : { ok: false, message: zodMessage(result.error) }
}

/** A position that passes the schema: finite numbers, no negative size. */
function clampedPosition(values: Record<string, unknown>) {
  const number = (value: unknown, fallback: number) => typeof value === 'number' && Number.isFinite(value) ? value : fallback
  const h = values.h
  return {
    x: number(values.x, 0),
    y: number(values.y, 0),
    w: Math.max(0, number(values.w, 0)),
    h: typeof h === 'number' && Number.isFinite(h) ? Math.max(0, h) : null,
    rotate: number(values.rotate, 0),
  }
}

/**
 * Fixes what a valid deck cannot hold: one empty slide when there are none,
 * or when the slides list itself is broken; frontmatter values YAML cannot
 * write, and frontmatter entries not stored the right way, are dropped;
 * elements that fail the schema get their position clamped, or are deleted
 * when that is not enough; a later sibling with the same id is deleted when
 * its Markdown is the same as an earlier one's (two people moved it at
 * once), and gets a fresh id otherwise. Returns whether it changed anything. Only one place should repair a shared document (the
 * server, for cloud decks), or two repairs at once would both add a slide.
 * Throws `DeckNotLoadedError` when the document holds no deck yet.
 */
export function repairDeckDoc(doc: Y.Doc, origin?: unknown): boolean {
  if (!hasDeck(doc))
    throw new DeckNotLoadedError()
  let changed = false
  const change = () => {
    changed = true
  }

  /** Makes one element map valid. Returns false when it has to go. */
  function repairElement(map: Y.Map<unknown>): boolean {
    const type = map.get('type')
    const textual = type === 'text' || type === 'raw'
    const markdown = map.get('markdown')
    if (textual && !(markdown instanceof Y.Text)) {
      map.set('markdown', new Y.Text(typeof markdown === 'string' ? markdown : ''))
      change()
    }
    if (typeof map.get('id') !== 'string' || !map.get('id')) {
      map.set('id', newId('e'))
      change()
    }
    const pos = map.get('pos')
    if (type === 'raw' && pos !== undefined) {
      map.delete('pos')
      change()
    }
    else if (pos !== undefined) {
      const values = pos instanceof Y.Map ? pos.toJSON() : isRecord(pos) ? pos : {}
      const clamped = clampedPosition(values)
      const fits = pos instanceof Y.Map && Object.keys(values).length === POSITION_KEYS.length
        && POSITION_KEYS.every(key => Object.is(values[key], clamped[key]))
      if (!fits) {
        map.set('pos', positionToY(clamped))
        change()
      }
    }
    return ElementSchema.safeParse(elementValues(map)).success
  }

  doc.transact(() => {
    const root = doc.getMap<unknown>(DECK_KEY)
    if (root.get('version') === undefined) {
      root.set('version', DECK_VERSION)
      change()
    }
    if (!slidesOf(doc)) {
      root.set('slides', new Y.Array())
      change()
    }
    const slides = slidesOf(doc)!
    for (let index = slides.length - 1; index >= 0; index--) {
      const slide = slides.get(index)
      if (!(slide instanceof Y.Map)) {
        slides.delete(index, 1)
        change()
        continue
      }
      if (typeof slide.get('id') !== 'string' || !slide.get('id')) {
        slide.set('id', newId('s'))
        change()
      }
      if (repairFrontmatter(slide))
        change()
      const notes = slide.get('notes')
      if (!(notes instanceof Y.Text)) {
        slide.set('notes', new Y.Text(typeof notes === 'string' ? notes : ''))
        change()
      }
      let elements = slide.get('elements')
      if (!(elements instanceof Y.Array)) {
        elements = new Y.Array()
        slide.set('elements', elements)
        change()
      }
      const array = elements as Y.Array<unknown>
      for (let position = array.length - 1; position >= 0; position--) {
        const element = array.get(position)
        if (!(element instanceof Y.Map) || !repairElement(element)) {
          array.delete(position, 1)
          change()
        }
      }
      removeDuplicates(array, value => readElement(value), (value) => {
        (value as Y.Map<unknown>).set('id', newId('e'))
      }, element => elementToMarkdown(element), change)
    }
    removeDuplicates(slides, value => readSlideEntry(value)?.slide, (value) => {
      (value as Y.Map<unknown>).set('id', newId('s'))
    }, slide => slideToMarkdown(slide, { ids: false }), change)
    if (slides.length === 0) {
      slides.push([slideToY({ id: newId('s'), frontmatter: {}, elements: [] })])
      change()
    }
  }, origin)
  return changed
}

/**
 * Drops frontmatter entries that are not stored the right way or hold a
 * value YAML cannot write. A broken older plain value becomes a frontmatter
 * map. Returns whether it changed anything.
 */
function repairFrontmatter(slide: Y.Map<unknown>): boolean {
  const frontmatter = slide.get('frontmatter')
  if (frontmatter instanceof Y.Map) {
    const broken = [...frontmatter.entries()].flatMap(([key, value]) => {
      const entry = frontmatterEntry(value)
      return entry && isFrontmatterValue(entry.value, 1) ? [] : [key]
    })
    for (const key of broken)
      frontmatter.delete(key)
    return broken.length > 0
  }
  // A valid plain frontmatter reads back as the very same object.
  if (readFrontmatter(frontmatter) === frontmatter)
    return false
  slide.set('frontmatter', frontmatterToY(readFrontmatter(frontmatter)))
  return true
}

/** A plain object, not a shared type. */
function plainRecord(value: unknown) {
  return isRecord(value) && !(value instanceof Y.AbstractType)
}

/**
 * Stores each slide's frontmatter and each block's settings key by key,
 * for a deck stored before they were split: an older plain value becomes a
 * map with the same keys and values, in one transaction. Nothing else
 * changes, so the deck reads and writes the same Markdown. Returns whether
 * it changed anything.
 *
 * Writers convert an older value on its first change anyway, but two people
 * making that first change to one block at once would each replace the
 * whole value, and one change would be lost. The server runs this when a
 * cloud deck's room loads, before anyone edits it. Like a repair, only one
 * place should run it on a shared document.
 */
export function upgradeDeckDoc(doc: Y.Doc, origin?: unknown): boolean {
  const slides = slidesOf(doc)
  if (!slides)
    return false
  const frontmatters: Y.Map<unknown>[] = []
  const props: Y.Map<unknown>[] = []
  for (const slide of slides) {
    if (!(slide instanceof Y.Map))
      continue
    if (plainRecord(slide.get('frontmatter')))
      frontmatters.push(slide)
    const elements = slide.get('elements')
    if (!(elements instanceof Y.Array))
      continue
    for (const element of elements) {
      if (element instanceof Y.Map && plainRecord(element.get('props')))
        props.push(element)
    }
  }
  if (frontmatters.length === 0 && props.length === 0)
    return false
  doc.transact(() => {
    for (const slide of frontmatters)
      slide.set('frontmatter', frontmatterToY(slide.get('frontmatter') as Record<string, unknown>))
    for (const element of props)
      element.set('props', propsToY(element.get('props') as Record<string, unknown>))
  }, origin)
  return true
}

/**
 * Siblings sharing an id: a later one whose Markdown equals an earlier one's
 * with that id is deleted, any other later one gets a fresh id.
 */
function removeDuplicates<T extends { id: string }>(
  array: Y.Array<unknown>,
  read: (value: unknown) => T | undefined,
  renew: (value: unknown) => void,
  markdown: (item: T) => string,
  change: () => void,
) {
  const seen = new Map<string, Set<string>>()
  const doomed: number[] = []
  for (const [index, value] of array.toArray().entries()) {
    const item = read(value)
    if (!item)
      continue
    const text = markdown(item)
    const earlier = seen.get(item.id)
    if (!earlier) {
      seen.set(item.id, new Set([text]))
      continue
    }
    if (earlier.has(text)) {
      doomed.push(index)
    }
    else {
      earlier.add(text)
      renew(value)
      change()
    }
  }
  for (const index of doomed.reverse()) {
    array.delete(index, 1)
    change()
  }
}
