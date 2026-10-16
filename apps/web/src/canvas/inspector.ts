import type { Position, PositionedElement } from '@deyslide/deck-model'
import type * as Y from 'yjs'
import type { DeckSession } from '../deck/session'
import { boxOf, imageLink } from './elements'
import { boundsOf, keepOnSlide } from './geometry'

// What the inspector reads from its fields, and how it writes to the deck.
// A field's text is checked here first: a value the deck cannot take never
// reaches it, and the field says why in a few words.

/** A field's text read as a value, or why it cannot be one. */
export type Reading<T> = { value: T } | { problem: string }

export interface NumberRules {
  /** The smallest value allowed. */
  min?: number
  /** Values must be above this one. */
  above?: number
  max?: number
  whole?: boolean
  /** An empty field means no value (the default, or auto height). */
  optional?: boolean
}

/** A number typed in a field. */
export function readNumber(text: string, rules: NumberRules = {}): Reading<number | undefined> {
  const trimmed = text.trim()
  if (!trimmed)
    return rules.optional ? { value: undefined } : { problem: 'Enter a number.' }
  const value = Number(trimmed)
  if (!Number.isFinite(value))
    return { problem: 'Enter a number.' }
  if (rules.whole && !Number.isInteger(value))
    return { problem: 'Enter a whole number.' }
  if (rules.min !== undefined && rules.max !== undefined && (value < rules.min || value > rules.max))
    return { problem: `Enter a number from ${rules.min} to ${rules.max}.` }
  if (rules.min !== undefined && value < rules.min)
    return { problem: `Enter ${rules.min} or more.` }
  if (rules.above !== undefined && value <= rules.above)
    return { problem: `Enter a number above ${rules.above}.` }
  return { value }
}

/** Three numbers, such as a camera position: `7, 5, 9`. */
export function readVector(text: string): Reading<[number, number, number] | undefined> {
  const trimmed = text.trim()
  if (!trimmed)
    return { value: undefined }
  const parts = trimmed.split(/[\s,;]+/).filter(Boolean).map(Number)
  if (parts.length !== 3 || !parts.every(Number.isFinite))
    return { problem: 'Enter three numbers, such as 7, 5, 9.' }
  return { value: parts as [number, number, number] }
}

/** CSS color names, so a word that names no color is refused. */
const COLOR_NAMES = new Set(`aliceblue antiquewhite aqua aquamarine azure beige bisque black blanchedalmond blue blueviolet brown
burlywood cadetblue chartreuse chocolate coral cornflowerblue cornsilk crimson cyan darkblue darkcyan darkgoldenrod darkgray
darkgreen darkgrey darkkhaki darkmagenta darkolivegreen darkorange darkorchid darkred darksalmon darkseagreen darkslateblue
darkslategray darkslategrey darkturquoise darkviolet deeppink deepskyblue dimgray dimgrey dodgerblue firebrick floralwhite
forestgreen fuchsia gainsboro ghostwhite gold goldenrod gray green greenyellow grey honeydew hotpink indianred indigo ivory
khaki lavender lavenderblush lawngreen lemonchiffon lightblue lightcoral lightcyan lightgoldenrodyellow lightgray lightgreen
lightgrey lightpink lightsalmon lightseagreen lightskyblue lightslategray lightslategrey lightsteelblue lightyellow lime
limegreen linen magenta maroon mediumaquamarine mediumblue mediumorchid mediumpurple mediumseagreen mediumslateblue
mediumspringgreen mediumturquoise mediumvioletred midnightblue mintcream mistyrose moccasin navajowhite navy oldlace olive
olivedrab orange orangered orchid palegoldenrod palegreen paleturquoise palevioletred papayawhip peachpuff peru pink plum
powderblue purple rebeccapurple red rosybrown royalblue saddlebrown salmon sandybrown seagreen seashell sienna silver skyblue
slateblue slategray slategrey snow springgreen steelblue tan teal thistle tomato turquoise violet wheat white whitesmoke yellow
yellowgreen transparent currentcolor`.split(/\s+/))

/** Hex colors and CSS color functions with numbers in them. */
const COLOR = /^(?:#(?:[\da-f]{3,4}|[\da-f]{6}|[\da-f]{8})|(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch)\((?=[^()]*\d)[\d\s.,%/+\-a-z]*\))$/i

/** Whether the browser draws `value` as a color. Pages without CSS (tests) take the shapes above as they are. */
function browserColor(value: string) {
  try {
    return typeof CSS === 'undefined' || typeof CSS.supports !== 'function' || CSS.supports('color', value)
  }
  catch {
    return true
  }
}

/** A CSS color, or nothing for the default. */
export function readColor(text: string): Reading<string | undefined> {
  const trimmed = text.trim()
  if (!trimmed)
    return { value: undefined }
  const known = COLOR_NAMES.has(trimmed.toLowerCase()) || COLOR.test(trimmed)
  return known && browserColor(trimmed) ? { value: trimmed } : { problem: 'Enter a color, such as #38bdf8 or red.' }
}

/** A link to an image or another file a slide loads. */
export function readLink(text: string): Reading<string> {
  const link = imageLink(text)
  return link ? { value: link } : { problem: 'Enter a link that starts with https://, http:// or /.' }
}

/** A link, or nothing for the default. */
export function readOptionalLink(text: string): Reading<string | undefined> {
  return text.trim() ? readLink(text) : { value: undefined }
}

/**
 * A slide's background: a color the layout paints as one (Slidev takes
 * only `#` and `rgb` colors that way; any other word would be loaded as a
 * picture), or a link to an image. Nothing for none.
 */
export function readBackground(text: string): Reading<string | undefined> {
  const trimmed = text.trim()
  if (!trimmed)
    return { value: undefined }
  const color = /^(?:#|rgb)/i.test(trimmed) ? readColor(trimmed) : undefined
  if (color && 'value' in color)
    return color
  return imageLink(trimmed) ? { value: trimmed } : { problem: 'Enter a color such as #0f172a, or an image link.' }
}

/** Text that may be left empty, for the default. */
export function readText(text: string): Reading<string | undefined> {
  const trimmed = text.trim()
  return { value: trimmed || undefined }
}

/** A value as a field shows it: numbers rounded to two places, nothing for none. */
export function fieldText(value: unknown): string {
  if (typeof value === 'number')
    return String(Math.round(value * 100) / 100)
  if (Array.isArray(value))
    return value.map(fieldText).join(', ')
  return typeof value === 'string' ? value : ''
}

/**
 * Why an element cannot take a new place, size or turn, if it cannot: the
 * canvas keeps part of every element on the slide, so it can be grabbed
 * again. A side the Markdown already put off the slide may stay off, but a
 * change never pushes one off.
 */
export function placeProblem(element: PositionedElement, next: Position): string | undefined {
  const off = (pos: Position) => {
    const fix = keepOnSlide(boundsOf(boxOf(element, pos)), { x: 0, y: 0 })
    return { x: fix.x !== 0, y: fix.y !== 0 }
  }
  const before = off(element.pos)
  const after = off(next)
  return (after.x && !before.x) || (after.y && !before.y) ? 'Keep part of it on the slide.' : undefined
}

/** Keys that follow a list's rows, with the rows' content they were given for. */
export interface RowKeys {
  keys: string[]
  rows: string[]
}

let rowCount = 0

/**
 * Keys for a list's rows that follow each row while others change the
 * list, so a row keeps its fields, and what is typed in them, when a row
 * above it goes. Rows keep their key when their content is in the same
 * place or anywhere else in the list. The rest keep theirs only when each
 * changed where it was, with no row added or removed among them; otherwise
 * which is which cannot be told, so they get new keys, and a draft for one
 * of them says its row is gone rather than land in another.
 */
export function followRows(before: RowKeys, rows: string[]): RowKeys {
  const keys: (string | undefined)[] = rows.map(() => undefined)
  const used = new Set<number>()
  rows.forEach((row, at) => {
    if (at < before.rows.length && before.rows[at] === row) {
      keys[at] = before.keys[at]
      used.add(at)
    }
  })
  rows.forEach((row, at) => {
    if (keys[at] !== undefined)
      return
    const old = before.rows.findIndex((other, index) => !used.has(index) && other === row)
    if (old !== -1) {
      keys[at] = before.keys[old]
      used.add(old)
    }
  })
  const changed = rows.flatMap((_, at) => keys[at] === undefined ? [at] : [])
  const left = before.keys.flatMap((_, at) => used.has(at) ? [] : [at])
  const inPlace = changed.length === left.length && changed.every((at, index) => left[index] === at)
  return { keys: keys.map((key, at) => key ?? (inPlace ? before.keys[at] : `row-${++rowCount}`)), rows }
}

/** The answer when the row a field was for has gone. */
export const ROW_GONE = 'Someone changed this list meanwhile. Check it and try again.'

/** A class or style that takes Markdown out of the flow and lays it over the slide. */
const POSITIONED = /\bclass(?:Name)?\s*=\s*["'][^"']*\b(?:absolute|fixed)\b|position\s*:\s*(?:absolute|fixed)/i

/**
 * Whether a Markdown block holds content laid over the slide, such as a 3D
 * scene behind the title. Other Markdown flows and always shows under
 * movable elements, so it has no place in their order.
 */
export function holdsPositioned(markdown: string) {
  return POSITIONED.test(markdown)
}

/** A slot marker such as `::right::`, a script or a style. */
const UNMOVABLE = /^::[\w-]+::\s*$|<script\b|<style\b/im

/**
 * Why a Markdown block cannot be made movable, if it cannot: a v-drag
 * around a slot marker, a script or a style would split the slide, and one
 * around content laid over the slide (a backdrop) would shrink it into a box.
 */
export function movableProblem(markdown: string): string | undefined {
  if (UNMOVABLE.test(markdown))
    return 'A block with a slot marker such as ::right::, a script or a style cannot be made movable.'
  if (holdsPositioned(markdown))
    return 'This block is laid over the slide by its class or style, so it cannot be made movable.'
  return undefined
}

/** What the inspector calls each kind of element. */
export function elementLabel(element: PositionedElement): string {
  switch (element.type) {
    case 'text':
      return 'Text'
    case 'image':
      return 'Image'
    case 'shape':
      return element.props.shape === 'ellipse' ? 'Ellipse' : 'Rectangle'
    case 'code':
      return 'Code'
    case 'scene3d':
      return '3D scene'
    case 'algo-player':
      return 'Algorithm player'
    case 'sandbox':
      return 'Live sandbox'
  }
}

/** Props with a key set to undefined left out, so the component's default applies. */
export function withProps<T extends Record<string, unknown>>(props: T, patch: Record<string, unknown>): T {
  const next: Record<string, unknown> = { ...props, ...patch }
  for (const [key, value] of Object.entries(next)) {
    if (value === undefined)
      delete next[key]
  }
  return next as T
}

/** The answer when a change could not be made, for whatever reason the deck gave. */
export const NOT_CHANGED = 'That could not be changed. Try again.'

/**
 * Runs one change from the inspector as its own undo step. Says why when it
 * could not be made: the deck cannot be changed now, or the change failed
 * (someone removed the element meanwhile, say).
 */
export function inspectorChange(session: DeckSession, locked: boolean, change: (doc: Y.Doc) => void): string | undefined {
  if (locked || session.readOnly.value)
    return 'This deck cannot be changed right now.'
  session.undo.stopCapturing()
  try {
    session.transact(() => change(session.doc))
    return undefined
  }
  catch {
    return NOT_CHANGED
  }
  finally {
    session.undo.stopCapturing()
  }
}

/** Reads a field, then writes its value with `write`. Answers what the field shows under it. */
export function commitReading<T>(reading: Reading<T>, write: (value: T) => string | undefined): string | undefined {
  return 'problem' in reading ? reading.problem : write(reading.value)
}

let layouts: Promise<string[]> | undefined

/**
 * The layouts the preview has, by name, from its own list. The list loads
 * with the preview's layout components, so it comes once, when first asked.
 */
export function previewLayouts(): Promise<string[]> {
  layouts ??= import('../preview/layouts')
    .then(module => Object.keys(module.LAYOUTS))
    .catch((error: unknown) => {
      // Asked again next time.
      layouts = undefined
      throw error
    })
  return layouts
}
