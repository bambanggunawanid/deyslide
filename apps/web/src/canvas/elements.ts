import type { Position, PositionedElement } from '@deyslide/deck-model'
import type { Box } from './geometry'
import { CANVAS_HEIGHT, CANVAS_WIDTH, ElementSchema, findSlide, newId } from '@deyslide/deck-model'
import * as Y from 'yjs'
import { round2 } from './geometry'

// The elements of one slide as the canvas sees them, and the new elements
// its toolbar adds.

/** The positioned elements of a slide, in paint order. Elements that fail the schema and raw blocks are left out. */
export function slideElements(doc: Y.Doc, slideId: string): PositionedElement[] {
  const elements = findSlide(doc, slideId)?.get('elements')
  if (!(elements instanceof Y.Array))
    return []
  return elements.toArray().flatMap((value) => {
    if (!(value instanceof Y.Map))
      return []
    const parsed = ElementSchema.safeParse(value.toJSON())
    return parsed.success && parsed.data.type !== 'raw' ? [parsed.data] : []
  })
}

/** How the preview lays out a kind of Markdown block, in canvas units: font size, line height and the margins above and below. */
interface BlockStyle {
  size: number
  line: number
  top: number
  bottom: number
}

/** Paragraphs (0) and headings by level, from the preview's styles. */
const TEXT_BLOCKS: BlockStyle[] = [
  { size: 17.6, line: 24, top: 16, bottom: 16 },
  { size: 60, line: 80, top: 0, bottom: 16 },
  { size: 30, line: 36, top: 0, bottom: 0 },
  { size: 24, line: 32, top: 0, bottom: 0 },
]
/** A list item, which has no margins of its own. */
const LIST_ITEM: BlockStyle = { size: 17.6, line: 31.5, top: 0, bottom: 0 }
/** A code block: the space around its lines, and each line. */
const CODE = { around: 24, line: 18 }

/** Lines a text of `characters` takes at a font size in a box `width` wide: about half a font size per character. */
function wrappedLines(characters: number, size: number, width: number) {
  return Math.max(1, Math.ceil(characters * size * 0.5 / width))
}

/**
 * A first guess at how tall an element with auto height (`h` null) shows,
 * until the preview reports the height it laid out.
 */
export function estimatedHeight(element: PositionedElement): number {
  const width = Math.max(element.pos.w, 1)
  switch (element.type) {
    case 'text': {
      // Blocks of the Markdown: headings, list items and paragraphs, each with its characters.
      const blocks: { kind: BlockStyle, characters: number }[] = []
      let paragraph: { kind: BlockStyle, characters: number } | undefined
      for (const raw of element.markdown.split('\n')) {
        const line = raw.trim()
        if (!line) {
          paragraph = undefined
          continue
        }
        const level = line.match(/^(#{1,6})\s/)?.[1].length
        if (level !== undefined || /^(?:[-*+]|\d+\.)\s/.test(line)) {
          paragraph = undefined
          blocks.push({ kind: level === undefined ? LIST_ITEM : TEXT_BLOCKS[Math.min(level, 3)], characters: line.length })
        }
        else if (paragraph) {
          paragraph.characters += line.length + 1
        }
        else {
          paragraph = { kind: TEXT_BLOCKS[0], characters: line.length }
          blocks.push(paragraph)
        }
      }
      let height = 0
      let margin = 0
      for (const [index, { kind, characters }] of blocks.entries()) {
        // Margins between blocks overlap, as in the browser.
        height += index === 0 ? kind.top : Math.max(margin, kind.top)
        height += kind.line * wrappedLines(characters, kind.size, width)
        margin = kind.bottom
      }
      height += margin
      const empty = TEXT_BLOCKS[0]
      return round2(Math.max(height, empty.top + empty.line + empty.bottom))
    }
    case 'code': {
      const lines = Math.max(...element.steps.map(step => step.code.split('\n').length))
      return CODE.around + lines * CODE.line
    }
    default:
      return round2(width * 9 / 16)
  }
}

/**
 * The box the canvas draws for an element, from its position, or
 * `position` while it moves. An element with auto height takes the height
 * the preview laid it out at (`measured`), else a guess.
 */
export function boxOf(element: PositionedElement, position: Position = element.pos, measured?: number): Box {
  return {
    x: position.x,
    y: position.y,
    w: position.w,
    h: position.h ?? measured ?? estimatedHeight({ ...element, pos: position } as PositionedElement),
    rotate: position.rotate,
  }
}

export type ElementKind = 'text' | 'image' | 'rect' | 'ellipse' | 'code' | 'scene3d' | 'algo-player' | 'sandbox'

/** What the toolbar adds, in the order it shows them. */
export const ELEMENT_KINDS: { kind: ElementKind, label: string }[] = [
  { kind: 'text', label: 'Text' },
  { kind: 'image', label: 'Image' },
  { kind: 'rect', label: 'Rectangle' },
  { kind: 'ellipse', label: 'Ellipse' },
  { kind: 'code', label: 'Code' },
  { kind: 'scene3d', label: '3D scene' },
  { kind: 'algo-player', label: 'Algorithm player' },
  { kind: 'sandbox', label: 'Live sandbox' },
]

/** The animation the demo deck plays, served with the app, so a new player shows something at once. */
export const SAMPLE_ANIMATION = '/animations/bubble-sort.js'

/** A position of this size at the slide's top left corner, until `newElement` centers it. */
function sized(w: number, h: number | null): Position {
  return { x: 0, y: 0, w, h, rotate: 0 }
}

function draft(kind: ElementKind, src: string, alt: string): PositionedElement {
  const id = newId('e')
  switch (kind) {
    case 'text':
      return { id, type: 'text', pos: sized(480, null), markdown: 'New text' }
    case 'image':
      return { id, type: 'image', pos: sized(400, 225), src, alt }
    case 'rect':
      return { id, type: 'shape', pos: sized(240, 160), props: { shape: 'rect' } }
    case 'ellipse':
      return { id, type: 'shape', pos: sized(200, 200), props: { shape: 'ellipse' } }
    case 'code':
      return { id, type: 'code', pos: sized(480, null), steps: [{ lang: 'ts', code: 'const greeting = \'Hello\'' }] }
    case 'scene3d':
      return { id, type: 'scene3d', pos: sized(480, 300), props: {} }
    case 'algo-player':
      return { id, type: 'algo-player', pos: sized(480, 270), props: { src: SAMPLE_ANIMATION } }
    case 'sandbox':
      return { id, type: 'sandbox', pos: sized(420, 260), props: { initial: { count: 0 } } }
  }
}

/** A new element of a kind, in the middle of the slide. An image needs its `src`, and may say what it shows in `alt`. */
export function newElement(kind: ElementKind, { src = '', alt = '' }: { src?: string, alt?: string } = {}): PositionedElement {
  const element = draft(kind, src, alt)
  const { w, h } = element.pos
  const height = h ?? estimatedHeight(element)
  return { ...element, pos: { ...element.pos, x: Math.round((CANVAS_WIDTH - w) / 2), y: Math.round((CANVAS_HEIGHT - height) / 2) } }
}

/**
 * What a library image shows, from its file name, until someone writes a
 * better description: `red-cat.png` reads "red cat".
 */
export function describeFile(name: string): string {
  return name.replace(/\.[^.]+$/, '').replace(/[-_.\s]+/g, ' ').trim()
}

/** A link an image element can show: web addresses, paths on this site, and inline images. */
export function imageLink(value: string): string | undefined {
  const link = value.trim()
  return /^(?:https?:\/\/\S+|\/\S*|data:image\/\S+)$/i.test(link) ? link : undefined
}
