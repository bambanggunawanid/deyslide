import type { ParsedDeck } from './markdown.ts'
import type { Deck, DeckElement, Position, Slide } from './schema.ts'
import type { SlideEntry } from './y-shape.ts'
import * as Y from 'yjs'
import { newId } from './ids.ts'
import { deckSlideTexts, elementToMarkdown, joinSlides, parseMarkdown, slideToMarkdown } from './markdown.ts'
import { readDeckDoc } from './read.ts'
import { escapeNotes } from './scan.ts'
import { DECK_VERSION, DeckSchema } from './schema.ts'
import { applyTextDiff } from './text-diff.ts'
import {
  DECK_KEY,
  DeckNotLoadedError,
  elementToY,
  isRecord,
  POSITION_KEYS,
  positionToY,
  readSlideEntry,
  sameJson,
  slidesOf,
  slideToY,
  zodMessage,
} from './y-shape.ts'

const PLAIN = { ids: false }

// Alignment -------------------------------------------------------------------

/** A slide or element on one side of an alignment. */
interface Item {
  /** Canonical Markdown. Old items without it cannot be read and never pair. */
  key?: string
  /** An id that may pair it: explicit, and unique on its side. */
  id?: string
  /** Element type, so ids only pair elements of one type. */
  type?: string
}

interface Alignment {
  /** For each new item, the old item it continues, or -1. */
  match: number[]
  /** For each new item, whether its old item can stay where it is. */
  stays: boolean[]
}

/**
 * The most cells the longest common subsequence table may have (4 MB). Past
 * it only the shared start and end pair here, and `align` pairs the rest by
 * equal Markdown anywhere, so aligning a huge rewrite takes linear time and
 * memory instead of quadratic.
 */
const COMMON_PAIRS_CELLS = 1_000_000

/** Longest common subsequence of two key lists, as index pairs. */
function commonPairs(a: string[], b: string[]): [number, number][] {
  let start = 0
  while (start < a.length && start < b.length && a[start] === b[start])
    start++
  let endA = a.length
  let endB = b.length
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--
    endB--
  }
  const pairs: [number, number][] = []
  for (let index = 0; index < start; index++)
    pairs.push([index, index])
  const rows = endA - start
  const columns = endB - start
  if (rows > 0 && columns > 0 && rows * columns <= COMMON_PAIRS_CELLS) {
    // lengths[i][j]: how long the longest common subsequence of a[start + i..]
    // and b[start + j..] is, both cut before the shared end.
    const width = columns + 1
    const lengths = new Uint32Array((rows + 1) * width)
    for (let i = rows - 1; i >= 0; i--) {
      for (let j = columns - 1; j >= 0; j--) {
        lengths[i * width + j] = a[start + i] === b[start + j]
          ? lengths[(i + 1) * width + j + 1] + 1
          : Math.max(lengths[(i + 1) * width + j], lengths[i * width + j + 1])
      }
    }
    let i = 0
    let j = 0
    while (i < rows && j < columns) {
      if (a[start + i] === b[start + j]) {
        pairs.push([start + i, start + j])
        i++
        j++
      }
      else if (lengths[(i + 1) * width + j] >= lengths[i * width + j + 1]) {
        i++
      }
      else {
        j++
      }
    }
  }
  for (let offset = 0; offset < a.length - endA; offset++)
    pairs.push([endA + offset, endB + offset])
  return pairs
}

/** Indexes (into `values`) of a longest strictly increasing run. */
function increasingRun(values: number[]): number[] {
  const tails: number[] = []
  const previous: number[] = []
  for (const [index, value] of values.entries()) {
    let low = 0
    let high = tails.length
    while (low < high) {
      const middle = (low + high) >> 1
      if (values[tails[middle]] < value)
        low = middle + 1
      else
        high = middle
    }
    previous[index] = low > 0 ? tails[low - 1] : -1
    tails[low] = index
  }
  const run: number[] = []
  for (let index = tails.at(-1) ?? -1; index >= 0; index = previous[index])
    run.push(index)
  return run.reverse()
}

/**
 * Pairs old items with new ones: explicit ids first, then equal Markdown in
 * order, then equal Markdown anywhere (moves). Pairs out of order become
 * moves. What is left in each gap between pairs that stay is paired by
 * `byPlace`.
 */
function align(old: Item[], next: Item[], byPlace: (old: number[], next: number[]) => [number, number][]): Alignment {
  const match = Array.from<number>({ length: next.length }).fill(-1)
  const taken = Array.from<boolean>({ length: old.length }).fill(false)
  const pair = (from: number, to: number) => {
    match[to] = from
    taken[from] = true
  }

  const oldById = new Map<string, number>()
  for (const [index, item] of old.entries()) {
    if (item.id !== undefined && item.key !== undefined)
      oldById.set(item.id, index)
  }
  for (const [index, item] of next.entries()) {
    const from = item.id === undefined ? undefined : oldById.get(item.id)
    if (from !== undefined && old[from].type === item.type)
      pair(from, index)
  }

  const freeOld = old.flatMap((item, index) => !taken[index] && item.key !== undefined ? [index] : [])
  const freeNew = next.flatMap((_, index) => match[index] < 0 ? [index] : [])
  for (const [a, b] of commonPairs(freeOld.map(index => old[index].key!), freeNew.map(index => next[index].key!)))
    pair(freeOld[a], freeNew[b])

  const waiting = new Map<string, number[]>()
  for (const index of freeOld) {
    if (taken[index])
      continue
    const list = waiting.get(old[index].key!)
    if (list)
      list.push(index)
    else
      waiting.set(old[index].key!, [index])
  }
  for (const index of freeNew) {
    const from = match[index] < 0 ? waiting.get(next[index].key!)?.shift() : undefined
    if (from !== undefined)
      pair(from, index)
  }

  const paired = next.flatMap((_, index) => match[index] >= 0 ? [index] : [])
  const stays = Array.from<boolean>({ length: next.length }).fill(false)
  for (const position of increasingRun(paired.map(index => match[index])))
    stays[paired[position]] = true

  // Fill the gaps between pairs that stay.
  const anchors = paired.filter(index => stays[index])
  let lastOld = -1
  let lastNew = -1
  for (const anchor of [...anchors, next.length]) {
    const oldEnd = anchor < next.length ? match[anchor] : old.length
    const gapOld: number[] = []
    for (let index = lastOld + 1; index < oldEnd; index++) {
      if (!taken[index] && old[index].key !== undefined)
        gapOld.push(index)
    }
    const gapNew: number[] = []
    for (let index = lastNew + 1; index < anchor; index++) {
      if (match[index] < 0)
        gapNew.push(index)
    }
    for (const [from, to] of byPlace(gapOld, gapNew)) {
      pair(from, to)
      stays[to] = true
    }
    lastOld = oldEnd
    lastNew = anchor
  }
  return { match, stays }
}

/** Slides left in a gap pair up in order. */
function slidesByPlace(old: number[], next: number[]): [number, number][] {
  return old.slice(0, next.length).map((from, index) => [from, next[index]])
}

/** Gaps with more possible pairs than this pair by place, so a huge rewrite stays fast. */
const SIMILAR_PAIRS_MAX = 400

/**
 * What a pair is worth before its similarity: enough that slides in a gap
 * of the same size keep pairing in place, as an edit of each, unless one
 * slide clearly continues another.
 */
const PAIR_WORTH = 0.5

/** Each pair of characters in a text, counted. */
function bigrams(text: string) {
  const counts = new Map<string, number>()
  for (let index = 0; index < text.length - 1; index++) {
    const pair = text.slice(index, index + 2)
    counts.set(pair, (counts.get(pair) ?? 0) + 1)
  }
  return counts
}

/** How alike two texts are, from 0 to 1, by the pairs of characters they share (the Dice coefficient). */
function likeness(a: Map<string, number>, b: Map<string, number>) {
  let total = 0
  let shared = 0
  for (const count of a.values())
    total += count
  for (const [pair, count] of b) {
    total += count
    shared += Math.min(count, a.get(pair) ?? 0)
  }
  return total === 0 ? 1 : (2 * shared) / total
}

/**
 * Slides left in a gap pair up by what they say, in order: when a change
 * inserts or deletes a slide next to one it edits, the edited slide keeps
 * pairing with itself, so its id and text (and what others type in it)
 * stay with it. Gaps of the same size pair in place unless a slide clearly
 * continues another.
 */
function slidesByLikeness(keys: { old: (string | undefined)[], next: (string | undefined)[] }) {
  return (old: number[], next: number[]): [number, number][] => {
    if (old.length === 0 || next.length === 0)
      return []
    if (old.length * next.length > SIMILAR_PAIRS_MAX)
      return slidesByPlace(old, next)
    const oldGrams = old.map(index => bigrams(keys.old[index] ?? ''))
    const nextGrams = next.map(index => bigrams(keys.next[index] ?? ''))
    const worth = old.map((_, i) => next.map((_, j) => PAIR_WORTH + likeness(oldGrams[i]!, nextGrams[j]!)))
    // best[i][j]: the most the pairs among old[i..] and next[j..] are worth.
    const width = next.length + 1
    const best = new Float64Array((old.length + 1) * width)
    for (let i = old.length - 1; i >= 0; i--) {
      for (let j = next.length - 1; j >= 0; j--)
        best[i * width + j] = Math.max(best[(i + 1) * width + j + 1] + worth[i]![j]!, best[(i + 1) * width + j], best[i * width + j + 1])
    }
    // From the start, pairing when it is worth as much, so ties pair in place.
    const pairs: [number, number][] = []
    let i = 0
    let j = 0
    while (i < old.length && j < next.length) {
      const here = best[i * width + j]
      if (here === best[(i + 1) * width + j + 1] + worth[i]![j]!) {
        pairs.push([old[i]!, next[j]!])
        i++
        j++
      }
      else if (here === best[(i + 1) * width + j]) {
        i++
      }
      else {
        j++
      }
    }
    return pairs
  }
}

// Applying ------------------------------------------------------------------

/** Ids that appear once in a list, the only ones that may pair. */
function uniqueIds(ids: (string | undefined)[]) {
  const counts = new Map<string, number>()
  for (const id of ids) {
    if (id !== undefined)
      counts.set(id, (counts.get(id) ?? 0) + 1)
  }
  return ids.map(id => id !== undefined && counts.get(id) === 1 ? id : undefined)
}

/**
 * Which new items keep their explicit id. Explicit ids beat derived ones;
 * among explicit duplicates, the one whose Markdown (or else type) matches the
 * old item with that id wins, else the first.
 */
function claimIds(next: { id: string, explicit: boolean, key: string, type?: string }[], old: Map<string, Item>): (string | undefined)[] {
  const groups = new Map<string, number[]>()
  for (const [index, item] of next.entries()) {
    if (!item.explicit)
      continue
    const list = groups.get(item.id)
    if (list)
      list.push(index)
    else
      groups.set(item.id, [index])
  }
  const claimed: (string | undefined)[] = next.map(() => undefined)
  for (const [id, indexes] of groups) {
    const before = old.get(id)
    const winner = indexes.find(index => before && next[index].key === before.key)
      ?? indexes.find(index => before && next[index].type === before.type)
      ?? indexes[0]
    claimed[winner] = id
  }
  return claimed
}

/**
 * Ids for the new items that pair with nothing (`match` is -1, or missing for
 * a brand new list): their claimed id when it is free, else a fresh one.
 */
function freshIds(claimed: (string | undefined)[], used: Set<string>, prefix: 's' | 'e', match?: number[]) {
  return claimed.map((id, index) => {
    if (match && match[index] >= 0)
      return undefined
    const value = id !== undefined && !used.has(id) ? id : newId(prefix)
    used.add(value)
    return value
  })
}

/** Deletes the old entries that do not stay, from the end, in runs. */
function deleteLeaving(array: Y.Array<unknown>, keep: boolean[]) {
  let index = keep.length - 1
  while (index >= 0) {
    if (keep[index]) {
      index--
      continue
    }
    let start = index
    while (start > 0 && !keep[start - 1])
      start--
    array.delete(start, index - start + 1)
    index = start - 1
  }
}

/**
 * Lays out the new list: items that stay are already in order, the rest are
 * inserted where they belong. `create` makes the map for a new position.
 */
function placeItems(array: Y.Array<unknown>, stays: boolean[], create: (index: number) => Y.Map<unknown>) {
  let index = 0
  while (index < stays.length) {
    if (stays[index]) {
      index++
      continue
    }
    const start = index
    const maps: Y.Map<unknown>[] = []
    while (index < stays.length && !stays[index])
      maps.push(create(index++))
    array.insert(start, maps)
  }
}

function patchElement(map: Y.Map<unknown>, next: DeckElement) {
  for (const [key, value] of Object.entries(next)) {
    if (key === 'id' || key === 'type')
      continue
    if (key === 'pos') {
      const target = value as Position
      const pos = map.get('pos')
      if (!(pos instanceof Y.Map)) {
        map.set('pos', positionToY(target))
        continue
      }
      for (const field of POSITION_KEYS) {
        if (!Object.is(pos.get(field), target[field]))
          pos.set(field, target[field])
      }
    }
    else if (key === 'markdown') {
      const text = map.get('markdown')
      if (text instanceof Y.Text)
        applyTextDiff(text, value as string)
      else
        map.set('markdown', new Y.Text(value as string))
    }
    else if (!sameJson(map.get(key), value)) {
      map.set(key, value)
    }
  }
}

function elementsByType(oldTypes: string[], newTypes: string[]) {
  return (old: number[], next: number[]): [number, number][] =>
    commonPairs(old.map(index => oldTypes[index]), next.map(index => newTypes[index]))
      .map(([a, b]) => [old[a], next[b]])
}

/** Makes a slide's elements hold `next`, keeping elements whose Markdown did not change. */
function applyElements(array: Y.Array<unknown>, entry: SlideEntry, next: DeckElement[], explicit: boolean[]) {
  const oldKeys = entry.elements.map(item => item.element && elementToMarkdown(item.element))
  const oldIds = uniqueIds(entry.elements.map(item => item.element?.id))
  const old: Item[] = entry.elements.map((item, index) => ({ key: oldKeys[index], id: oldIds[index], type: item.element?.type }))
  const newKeys = next.map(elementToMarkdown)
  const oldWithId = new Map(old.flatMap(item => item.id !== undefined ? [[item.id, item] as const] : []))
  const claimed = claimIds(next.map((element, index) => ({ id: element.id, explicit: explicit[index], key: newKeys[index], type: element.type })), oldWithId)
  const items: Item[] = next.map((element, index) => ({ key: newKeys[index], id: claimed[index], type: element.type }))
  const { match, stays } = align(old, items, elementsByType(old.map(item => item.type ?? ''), items.map(item => item.type!)))

  const used = new Set<string>()
  for (const from of match) {
    if (from >= 0)
      used.add(entry.elements[from].element!.id)
  }
  const ids = freshIds(claimed, used, 'e', match)
  const copies = new Map<number, Y.Map<unknown>>()
  for (const [index, from] of match.entries()) {
    if (from >= 0 && !stays[index])
      copies.set(index, (entry.elements[from].map as Y.Map<unknown>).clone())
  }
  const keep = entry.elements.map(() => false)
  for (const [index, from] of match.entries()) {
    if (from >= 0 && stays[index])
      keep[from] = true
  }

  deleteLeaving(array, keep)
  placeItems(array, stays, index => copies.get(index) ?? elementToY({ ...next[index], id: ids[index]! }))
  for (const [index, from] of match.entries()) {
    if (from < 0 || oldKeys[from] === newKeys[index])
      continue
    const map = stays[index] ? entry.elements[from].map as Y.Map<unknown> : copies.get(index)!
    patchElement(map, next[index])
  }
}

/** Makes a changed slide hold `next`: frontmatter, notes and elements. */
function applySlide(map: Y.Map<unknown>, next: Slide, explicit: boolean[]) {
  const frontmatter = map.get('frontmatter')
  if (!isRecord(frontmatter) || !sameJson(frontmatter, next.frontmatter))
    map.set('frontmatter', next.frontmatter)
  // Notes that write the same Markdown are left alone, like elements, so the
  // trailing space someone just typed in them survives.
  const notes = map.get('notes')
  if (!(notes instanceof Y.Text))
    map.set('notes', new Y.Text(next.notes ?? ''))
  else if (escapeNotes(notes.toString()) !== escapeNotes(next.notes ?? ''))
    applyTextDiff(notes, next.notes ?? '')
  const entry = readSlideEntry(map)!
  const elements = map.get('elements')
  if (elements instanceof Y.Array) {
    applyElements(elements, entry, next.elements, explicit)
  }
  else {
    const used = new Set<string>()
    const ids = freshIds(claimIds(next.elements.map((element, index) => ({ id: element.id, explicit: explicit[index], key: '' })), new Map()), used, 'e')
    const array = new Y.Array<Y.Map<unknown>>()
    array.push(next.elements.map((element, index) => elementToY({ ...element, id: ids[index]! })))
    map.set('elements', array)
  }
}

/** A new slide with its ids settled: explicit ones kept when free, fresh ones otherwise. */
function newSlide(slide: Slide, id: string, explicit: boolean[]): Slide {
  const ids = freshIds(claimIds(slide.elements.map((element, index) => ({ id: element.id, explicit: explicit[index], key: '' })), new Map()), new Set(), 'e')
  return { ...slide, id, elements: slide.elements.map((element, index) => ({ ...element, id: ids[index]! })) }
}

const DERIVED_SLIDE_ID = /^slide-\d+$/
const DERIVED_ELEMENT_ID = /:(?:raw|el):\d+$/

/**
 * A plain deck as a parsed one. Ids shaped like the ones `fromMarkdown`
 * derives from places (`slide-N`, `:raw:N`, `:el:N`) are treated as derived.
 */
function asParsed(input: ParsedDeck | Deck): ParsedDeck {
  if ('deck' in input)
    return input
  const result = DeckSchema.safeParse(input)
  if (!result.success)
    throw new Error(`The deck is not valid: ${zodMessage(result.error)}`)
  return {
    deck: result.data,
    explicit: result.data.slides.map(slide => ({
      slide: !DERIVED_SLIDE_ID.test(slide.id),
      elements: slide.elements.map(element => !DERIVED_ELEMENT_ID.test(element.id)),
    })),
  }
}

export interface ApplyDeckOptions {
  /**
   * Lets `applyDeck` fill a document that holds no deck yet. Only code that
   * creates a deck (a new deck, an import, the first load of a file) sets it:
   * filling a document before its first sync would replace the real deck.
   */
  create?: boolean
}

/**
 * Makes the live document hold `input` with as few changes as it can, so
 * edits other people make elsewhere at the same time survive.
 *
 * - Slides, and elements inside a changed slide, whose Markdown is the same
 *   on both sides are not touched at all.
 * - Slides pair by explicit id, then by equal Markdown in order, then by
 *   equal Markdown elsewhere (moved, keeping the id), then by likeness in
 *   order in each gap (by place when the gap's sides are the same size and
 *   no slide clearly continues another). Old slides left over are deleted;
 *   new ones are inserted.
 * - Inside a changed slide, frontmatter is replaced when it differs, notes
 *   change by a text diff, and elements pair the same way (by place and type
 *   in the gaps), then change field by field.
 * - Paired slides and elements keep their ids. New ones keep an explicit id
 *   when it is free, and get a fresh id otherwise.
 *
 * Throws `DeckNotLoadedError` when the document holds no deck, unless
 * `create` is set.
 */
export function applyDeck(doc: Y.Doc, input: ParsedDeck | Deck, origin?: unknown, options: ApplyDeckOptions = {}) {
  const { deck, explicit } = asParsed(input)
  const root = doc.getMap<unknown>(DECK_KEY)
  const slides = slidesOf(doc)
  if (!slides) {
    if (!options.create)
      throw new DeckNotLoadedError()
    const claimed = claimIds(deck.slides.map((slide, index) => ({ id: slide.id, explicit: explicit[index].slide, key: '' })), new Map())
    const ids = freshIds(claimed, new Set(), 's')
    doc.transact(() => {
      root.set('version', DECK_VERSION)
      const array = new Y.Array<Y.Map<unknown>>()
      array.push(deck.slides.map((slide, index) => slideToY(newSlide(slide, ids[index]!, explicit[index].elements))))
      root.set('slides', array)
    }, origin)
    return
  }

  const entries = slides.toArray().map(value => readSlideEntry(value))
  const oldKeys = entries.map(entry => entry && slideToMarkdown(entry.slide, PLAIN))
  const oldIds = uniqueIds(entries.map(entry => entry?.slide.id))
  const old: Item[] = entries.map((_, index) => ({ key: oldKeys[index], id: oldIds[index] }))
  const newKeys = deck.slides.map(slide => slideToMarkdown(slide, PLAIN))
  const oldWithId = new Map(old.flatMap(item => item.id !== undefined ? [[item.id, item] as const] : []))
  const claimed = claimIds(deck.slides.map((slide, index) => ({ id: slide.id, explicit: explicit[index].slide, key: newKeys[index] })), oldWithId)
  const { match, stays } = align(old, deck.slides.map((_, index) => ({ key: newKeys[index], id: claimed[index] })), slidesByLikeness({ old: oldKeys, next: newKeys }))

  const used = new Set<string>()
  for (const from of match) {
    if (from >= 0)
      used.add(entries[from]!.slide.id)
  }
  const ids = freshIds(claimed, used, 's', match)
  const copies = new Map<number, Y.Map<unknown>>()
  for (const [index, from] of match.entries()) {
    if (from >= 0 && !stays[index])
      copies.set(index, entries[from]!.map.clone())
  }
  const keep = entries.map(() => false)
  for (const [index, from] of match.entries()) {
    if (from >= 0 && stays[index])
      keep[from] = true
  }
  const changed = keep.some(value => !value) || stays.some(value => !value)
    || match.some((from, index) => oldKeys[from] !== newKeys[index])
  if (!changed && root.get('version') === DECK_VERSION)
    return

  doc.transact(() => {
    if (root.get('version') !== DECK_VERSION)
      root.set('version', DECK_VERSION)
    deleteLeaving(slides, keep)
    placeItems(slides, stays, index => copies.get(index) ?? slideToY(newSlide(deck.slides[index], ids[index]!, explicit[index].elements)))
    for (const [index, from] of match.entries()) {
      if (from < 0 || oldKeys[from] === newKeys[index])
        continue
      const map = stays[index] ? entries[from]!.map : copies.get(index)!
      applySlide(map, deck.slides[index], explicit[index].elements)
    }
  }, origin)
}

/**
 * Makes the document hold the deck this Markdown describes, as `applyDeck`
 * does. Throws `DeckMarkdownError` before touching the document when the
 * Markdown cannot be read.
 */
export function applyMarkdown(doc: Y.Doc, markdown: string, origin?: unknown, options: ApplyDeckOptions = {}) {
  applyDeck(doc, parseMarkdown(markdown), origin, options)
}

/** The deck as people edit it: Slidev Markdown without slide ids. */
export function deckMarkdown(doc: Y.Doc): string {
  return joinSlides(deckSlideTexts(readDeckDoc(doc), PLAIN))
}

/**
 * Each slide's Markdown, exactly as Slidev's splitter reads it from
 * `deckMarkdown(doc)`, so `joinSlides` of the list equals `deckMarkdown(doc)`.
 */
export function slideMarkdowns(doc: Y.Doc): { id: string, markdown: string }[] {
  const deck = readDeckDoc(doc)
  const texts = deckSlideTexts(deck, PLAIN)
  return deck.slides.map((slide, index) => ({ id: slide.id, markdown: texts[index] }))
}
