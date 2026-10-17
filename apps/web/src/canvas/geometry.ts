import { CANVAS_HEIGHT, CANVAS_WIDTH } from '@deyslide/deck-model'

// The math of the canvas editor, in slide canvas units (980 by 551.25) unless
// a name says otherwise. Nothing here touches the page or the deck, so every
// rule can be checked on its own.

export interface Point {
  x: number
  y: number
}

/** An element's box: its top left corner before turning, its size, and the degrees it turns around its center. */
export interface Box {
  x: number
  y: number
  w: number
  h: number
  rotate: number
}

/** An upright rectangle that holds something, such as a turned box. */
export interface Bounds {
  left: number
  top: number
  right: number
  bottom: number
}

export interface Size {
  width: number
  height: number
}

/** How close, in canvas units, an edge or center gets before it snaps. */
export const SNAP_DISTANCE = 5
/** Shift turns in steps of this many degrees. */
export const ROTATE_STEP = 15
/** The smallest width or height a resize leaves. */
export const MIN_SIZE = 8
/** How much of an element, in canvas units, always stays on the slide, so it can be grabbed again. */
export const KEEP_VISIBLE = 20
export const MIN_ZOOM = 0.1
export const MAX_ZOOM = 4

export const CANVAS: Size = { width: CANVAS_WIDTH, height: CANVAS_HEIGHT }

/** Rounds away floating point noise, keeping two decimals. */
export function round2(value: number) {
  return Math.round(value * 100) / 100 || 0
}

export function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max)
}

export function center(box: Box): Point {
  return { x: box.x + box.w / 2, y: box.y + box.h / 2 }
}

/** Turns a vector by `degrees`, clockwise on screen (y points down). */
export function rotateVector(vector: Point, degrees: number): Point {
  const radians = degrees * Math.PI / 180
  const cos = Math.cos(radians)
  const sin = Math.sin(radians)
  return { x: vector.x * cos - vector.y * sin, y: vector.x * sin + vector.y * cos }
}

/** Turns a point around another, clockwise on screen. */
export function rotatePoint(point: Point, around: Point, degrees: number): Point {
  const turned = rotateVector({ x: point.x - around.x, y: point.y - around.y }, degrees)
  return { x: around.x + turned.x, y: around.y + turned.y }
}

/** A point in the box's own upright frame, measured from its top left corner. */
export function toLocal(point: Point, box: Box): Point {
  const upright = rotatePoint(point, center(box), -box.rotate)
  return { x: upright.x - box.x, y: upright.y - box.y }
}

/** Whether a point falls inside a box, turned or not. */
export function contains(box: Box, point: Point): boolean {
  const local = toLocal(point, box)
  return local.x >= 0 && local.x <= box.w && local.y >= 0 && local.y <= box.h
}

/** The id of the topmost box under a point. Later boxes are drawn on top. */
export function hitTest(boxes: { id: string, box: Box }[], point: Point): string | undefined {
  for (let index = boxes.length - 1; index >= 0; index--) {
    if (contains(boxes[index].box, point))
      return boxes[index].id
  }
  return undefined
}

/** The corners of a box after it turns, clockwise from the top left. */
export function corners(box: Box): Point[] {
  const middle = center(box)
  return [
    { x: box.x, y: box.y },
    { x: box.x + box.w, y: box.y },
    { x: box.x + box.w, y: box.y + box.h },
    { x: box.x, y: box.y + box.h },
  ].map(corner => rotatePoint(corner, middle, box.rotate))
}

/** The upright rectangle around a box, turned or not. */
export function boundsOf(box: Box): Bounds {
  if (!box.rotate)
    return { left: box.x, top: box.y, right: box.x + box.w, bottom: box.y + box.h }
  const points = corners(box)
  const xs = points.map(point => point.x)
  const ys = points.map(point => point.y)
  return { left: Math.min(...xs), top: Math.min(...ys), right: Math.max(...xs), bottom: Math.max(...ys) }
}

/** The upright rectangle around several. */
export function unionBounds(list: Bounds[]): Bounds {
  return {
    left: Math.min(...list.map(item => item.left)),
    top: Math.min(...list.map(item => item.top)),
    right: Math.max(...list.map(item => item.right)),
    bottom: Math.max(...list.map(item => item.bottom)),
  }
}

function shift(bounds: Bounds, by: Point): Bounds {
  return { left: bounds.left + by.x, top: bounds.top + by.y, right: bounds.right + by.x, bottom: bounds.bottom + by.y }
}

// Resizing ---------------------------------------------------------------------

export type Handle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w'

/** The eight resize handles, clockwise from the top left corner. */
export const HANDLES: Handle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w']

/** Which sides a handle pulls: -1 the left or top one, 1 the right or bottom one, 0 neither. */
export function handleSides(handle: Handle): { x: -1 | 0 | 1, y: -1 | 0 | 1 } {
  return {
    x: handle.includes('w') ? -1 : handle.includes('e') ? 1 : 0,
    y: handle.includes('n') ? -1 : handle.includes('s') ? 1 : 0,
  }
}

/** Where a handle sits in the box's own upright frame. */
export function handlePoint(box: Box, handle: Handle): Point {
  const sides = handleSides(handle)
  return { x: box.w * (sides.x + 1) / 2, y: box.h * (sides.y + 1) / 2 }
}

export interface ResizeOptions {
  /** Keeps the width to height ratio the box started with (Shift). */
  keepRatio?: boolean
  minSize?: number
}

/**
 * Resizes a box by dragging one handle `delta` canvas units. The opposite
 * side or corner stays where it is on the slide, also when the box is
 * turned. An edge handle with the ratio kept grows the box evenly on both
 * sides of that edge's axis.
 */
export function resizeBox(start: Box, handle: Handle, delta: Point, { keepRatio = false, minSize = MIN_SIZE }: ResizeOptions = {}): Box {
  const sides = handleSides(handle)
  // The drag in the box's own frame.
  const move = rotateVector(delta, -start.rotate)
  let left = 0
  let right = start.w
  let top = 0
  let bottom = start.h
  if (sides.x === -1)
    left = Math.min(move.x, right - minSize)
  if (sides.x === 1)
    right = Math.max(start.w + move.x, left + minSize)
  if (sides.y === -1)
    top = Math.min(move.y, bottom - minSize)
  if (sides.y === 1)
    bottom = Math.max(start.h + move.y, top + minSize)
  let w = right - left
  let h = bottom - top

  if (keepRatio && start.w > 0 && start.h > 0) {
    const ratio = start.w / start.h
    if (sides.x !== 0 && sides.y !== 0) {
      // A corner follows whichever side moved more.
      if (w / start.w >= h / start.h)
        h = w / ratio
      else
        w = h * ratio
    }
    else if (sides.x !== 0) {
      h = w / ratio
    }
    else {
      w = h * ratio
    }
    if (w < minSize) {
      w = minSize
      h = w / ratio
    }
    if (h < minSize) {
      h = minSize
      w = h * ratio
    }
    if (sides.x === -1)
      left = right - w
    else if (sides.x === 1)
      right = left + w
    else
      left = (start.w - w) / 2
    if (sides.y === -1)
      top = bottom - h
    else if (sides.y === 1)
      bottom = top + h
    else
      top = (start.h - h) / 2
  }

  // The new box turns around its own center: find where that center is on the slide.
  const middle = rotatePoint({ x: start.x + left + w / 2, y: start.y + top + h / 2 }, center(start), start.rotate)
  return { x: middle.x - w / 2, y: middle.y - h / 2, w, h, rotate: start.rotate }
}

// Turning ----------------------------------------------------------------------

/** Degrees in the range from -180 (not included) to 180. */
export function normalizeAngle(degrees: number) {
  const turned = ((degrees % 360) + 360) % 360
  return (turned > 180 ? turned - 360 : turned) || 0
}

export function snapAngle(degrees: number, step = ROTATE_STEP) {
  return normalizeAngle(Math.round(degrees / step) * step)
}

/** The direction from one point to another in degrees: 0 straight up, growing clockwise. */
export function angleTo(from: Point, to: Point) {
  return Math.atan2(to.x - from.x, from.y - to.y) * 180 / Math.PI
}

/**
 * The angle of a box whose rotate handle was grabbed at `from` and is now at
 * `to`. With `snap` (Shift) the angle goes in steps of 15 degrees.
 */
export function rotationFor(start: Box, from: Point, to: Point, { snap = false }: { snap?: boolean } = {}) {
  const middle = center(start)
  const angle = start.rotate + angleTo(middle, to) - angleTo(middle, from)
  return snap ? snapAngle(angle) : normalizeAngle(angle)
}

// Snapping ---------------------------------------------------------------------

/**
 * A guide line shown while an edge or center snaps. An `x` guide is the
 * upright line at x = `at`, from y = `from` to y = `to`; a `y` guide lies
 * flat at y = `at`, from x = `from` to x = `to`.
 */
export interface Guide {
  axis: 'x' | 'y'
  at: number
  from: number
  to: number
}

interface Target {
  at: number
  from: number
  to: number
}

/** Lines things snap to: the slide's edges and center lines, and the edges and centers of other elements. */
function targetsOf(others: Bounds[], canvas: Size) {
  const x: Target[] = [0, canvas.width / 2, canvas.width].map(at => ({ at, from: 0, to: canvas.height }))
  const y: Target[] = [0, canvas.height / 2, canvas.height].map(at => ({ at, from: 0, to: canvas.width }))
  for (const other of others) {
    for (const at of [other.left, (other.left + other.right) / 2, other.right])
      x.push({ at, from: other.top, to: other.bottom })
    for (const at of [other.top, (other.top + other.bottom) / 2, other.bottom])
      y.push({ at, from: other.left, to: other.right })
  }
  return { x, y }
}

/** The smallest change, within `distance`, that puts one of `lines` on one of `targets`. */
function nearest(lines: number[], targets: Target[], distance: number) {
  let best: number | undefined
  for (const line of lines) {
    for (const target of targets) {
      const change = target.at - line
      if (Math.abs(change) <= distance && (best === undefined || Math.abs(change) < Math.abs(best)))
        best = change
    }
  }
  return best
}

const SAME = 1e-6

/** Guides for every target one of `lines` now sits on, one per line, spanning both things. */
function guidesFor(axis: 'x' | 'y', lines: number[], targets: Target[], span: { from: number, to: number }): Guide[] {
  const guides = new Map<number, Guide>()
  for (const target of targets) {
    if (!lines.some(line => Math.abs(line - target.at) < SAME))
      continue
    const at = round2(target.at)
    const known = guides.get(at)
    guides.set(at, {
      axis,
      at,
      from: Math.min(known?.from ?? span.from, target.from, span.from),
      to: Math.max(known?.to ?? span.to, target.to, span.to),
    })
  }
  return [...guides.values()]
}

export interface SnapOptions {
  distance?: number
  canvas?: Size
}

/**
 * Snaps a move. `moving` is the upright rectangle around what moves, before
 * the move; `delta` is how far the pointer took it. Its left, center and
 * right snap to the slide's edges and center, and to the edges and centers
 * of `others`, within `distance`, and the same goes for top, middle and
 * bottom. Returns the snapped move and the guides to show.
 */
export function snapMove(moving: Bounds, delta: Point, others: Bounds[], { distance = SNAP_DISTANCE, canvas = CANVAS }: SnapOptions = {}): { delta: Point, guides: Guide[] } {
  const targets = targetsOf(others, canvas)
  const xLines = (bounds: Bounds) => [bounds.left, (bounds.left + bounds.right) / 2, bounds.right]
  const yLines = (bounds: Bounds) => [bounds.top, (bounds.top + bounds.bottom) / 2, bounds.bottom]
  const moved = shift(moving, delta)
  const snapped = {
    x: delta.x + (nearest(xLines(moved), targets.x, distance) ?? 0),
    y: delta.y + (nearest(yLines(moved), targets.y, distance) ?? 0),
  }
  const placed = shift(moving, snapped)
  return {
    delta: snapped,
    guides: [
      ...guidesFor('x', xLines(placed), targets.x, { from: placed.top, to: placed.bottom }),
      ...guidesFor('y', yLines(placed), targets.y, { from: placed.left, to: placed.right }),
    ],
  }
}

export interface ResizeSnapOptions extends ResizeOptions, SnapOptions {
  /**
   * Whether the edge a handle pulls may snap on each axis. A box with an
   * auto height leaves `y` out, so a sideways drag does not fix its height.
   */
  axes?: { x?: boolean, y?: boolean }
}

/**
 * Resizes a box like `resizeBox`, then snaps the edges the handle pulls
 * (the left or right edge, the top or bottom one, or one of each for a
 * corner) to the slide's edges and center lines and to the edges and
 * centers of `others`, within `distance`. With the ratio kept, a corner
 * snaps the edge that lines up with the smaller change, and the other side
 * follows the ratio. Returns the box and the guides to show.
 *
 * A turned box only snaps when it is turned 0 degrees: its edges do not
 * run along the slide's lines, so it resizes freely.
 */
export function snapResize(start: Box, handle: Handle, delta: Point, others: Bounds[], options: ResizeSnapOptions = {}): { box: Box, guides: Guide[] } {
  const { distance = SNAP_DISTANCE, canvas = CANVAS, axes = {} } = options
  const unsnapped = resizeBox(start, handle, delta, options)
  if (normalizeAngle(start.rotate) !== 0)
    return { box: unsnapped, guides: [] }
  const sides = handleSides(handle)
  const targets = targetsOf(others, canvas)
  /** The edges the handle pulls, on each axis. */
  const pulled = (box: Box) => ({
    x: sides.x === 0 || axes.x === false ? [] : [sides.x < 0 ? box.x : box.x + box.w],
    y: sides.y === 0 || axes.y === false ? [] : [sides.y < 0 ? box.y : box.y + box.h],
  })
  const lines = pulled(unsnapped)
  const change = { x: nearest(lines.x, targets.x, distance), y: nearest(lines.y, targets.y, distance) }
  /** Whether the pulled edge on an axis now sits on a target. */
  const lands = (box: Box, axis: 'x' | 'y') =>
    pulled(box)[axis].some(line => targets[axis].some(target => Math.abs(line - target.at) < SAME))
  const resized = (by: Point) => resizeBox(start, handle, { x: delta.x + by.x, y: delta.y + by.y }, options)

  let box = unsnapped
  if (options.keepRatio) {
    // The ratio ties the two sides together: snap one axis, the smaller change first.
    const tries = (['x', 'y'] as const)
      .flatMap(axis => change[axis] === undefined ? [] : [{ axis, by: change[axis]! }])
      .sort((a, b) => Math.abs(a.by) - Math.abs(b.by))
    for (const { axis, by } of tries) {
      const candidate = resized(axis === 'x' ? { x: by, y: 0 } : { x: 0, y: by })
      if (lands(candidate, axis)) {
        box = candidate
        break
      }
    }
  }
  else {
    // Each axis on its own: one that cannot land (the smallest size held it back) stays as dragged.
    const by = { x: change.x ?? 0, y: change.y ?? 0 }
    const both = resized(by)
    box = resized({ x: lands(both, 'x') ? by.x : 0, y: lands(both, 'y') ? by.y : 0 })
  }

  const placed = boundsOf(box)
  const shown = pulled(box)
  return {
    box,
    guides: [
      ...guidesFor('x', shown.x, targets.x, { from: placed.top, to: placed.bottom }),
      ...guidesFor('y', shown.y, targets.y, { from: placed.left, to: placed.right }),
    ],
  }
}

/**
 * Limits a move so that at least `keep` canvas units of each of `moving`
 * stay on the slide on each axis. When things already lie off the slide
 * and no move keeps every one on it, the move goes no further than the
 * limits of the ones it would push off.
 */
export function keepOnSlide(moving: Bounds | Bounds[], delta: Point, { canvas = CANVAS, keep = KEEP_VISIBLE }: { canvas?: Size, keep?: number } = {}): Point {
  const list = Array.isArray(moving) ? moving : [moving]
  const limit = (value: number, sides: [number, number][], size: number) => {
    let min = Number.NEGATIVE_INFINITY
    let max = Number.POSITIVE_INFINITY
    for (const [low, high] of sides) {
      // Something smaller than `keep` only has to stay on the slide.
      const reach = Math.min(keep, high - low)
      min = Math.max(min, reach - high)
      max = Math.min(max, size - reach - low)
    }
    return min <= max ? clamp(value, min, max) : clamp(value, max, min)
  }
  return {
    x: limit(delta.x, list.map(bounds => [bounds.left, bounds.right]), canvas.width),
    y: limit(delta.y, list.map(bounds => [bounds.top, bounds.bottom]), canvas.height),
  }
}

// Zoom and pan -------------------------------------------------------------------

/**
 * How the slide sits in the stage: a canvas point `p` shows at
 * `p * scale + (x, y)` pixels from the stage's top left corner.
 */
export interface View {
  scale: number
  x: number
  y: number
}

export function clampZoom(scale: number) {
  return clamp(scale, MIN_ZOOM, MAX_ZOOM)
}

/** The whole slide, as large as the stage allows, centered. */
export function fitView(stage: Size, canvas: Size = CANVAS): View {
  const scale = Math.max(Math.min(stage.width / canvas.width, stage.height / canvas.height), 0) || 1
  return { scale, x: (stage.width - canvas.width * scale) / 2, y: (stage.height - canvas.height * scale) / 2 }
}

/**
 * Keeps the slide in sight: a slide larger than the stage cannot leave a gap
 * past its edges, and a smaller one stays inside the stage.
 */
export function clampView(view: View, stage: Size, canvas: Size = CANVAS): View {
  const width = canvas.width * view.scale
  const height = canvas.height * view.scale
  return {
    scale: view.scale,
    x: clamp(view.x, Math.min(0, stage.width - width), Math.max(0, stage.width - width)),
    y: clamp(view.y, Math.min(0, stage.height - height), Math.max(0, stage.height - height)),
  }
}

/** The canvas point under a point of the stage. */
export function toCanvas(view: View, point: Point): Point {
  return { x: (point.x - view.x) / view.scale, y: (point.y - view.y) / view.scale }
}

/** The stage point that shows a canvas point. */
export function toStage(view: View, point: Point): Point {
  return { x: point.x * view.scale + view.x, y: point.y * view.scale + view.y }
}

/** Zooms to `scale` keeping the canvas point under `anchor` (a stage point) where it is. */
export function zoomAt(view: View, scale: number, anchor: Point, stage: Size, canvas: Size = CANVAS): View {
  const next = clampZoom(scale)
  const fixed = toCanvas(view, anchor)
  return clampView({ scale: next, x: anchor.x - fixed.x * next, y: anchor.y - fixed.y * next }, stage, canvas)
}

/** Moves the slide by `delta` stage pixels. */
export function panBy(view: View, delta: Point, stage: Size, canvas: Size = CANVAS): View {
  return clampView({ scale: view.scale, x: view.x + delta.x, y: view.y + delta.y }, stage, canvas)
}

function distance(a: Point, b: Point) {
  return Math.hypot(a.x - b.x, a.y - b.y)
}

function midpoint(a: Point, b: Point): Point {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
}

/**
 * Two fingers that started at `from` and are now at `to` (stage points):
 * the zoom follows how far apart they are, and the canvas point that was
 * between them stays between them, so moving both pans.
 */
export function pinchView(start: View, from: [Point, Point], to: [Point, Point], stage: Size, canvas: Size = CANVAS): View {
  const before = distance(...from)
  const scale = clampZoom(before > 0 ? start.scale * distance(...to) / before : start.scale)
  const fixed = toCanvas(start, midpoint(...from))
  const middle = midpoint(...to)
  return clampView({ scale, x: middle.x - fixed.x * scale, y: middle.y - fixed.y * scale }, stage, canvas)
}

// Handles -----------------------------------------------------------------------

/** Where the rotate handle goes: off the box's top edge, off its bottom edge, or just inside its top. */
export type RotateHandlePlace = 'above' | 'below' | 'inside'

/**
 * Puts the rotate handle where the stage shows it. It sits `gap` pixels
 * off the middle of the box's top edge, turning with the box, unless that
 * spot is cut off by the stage's edge (a box at the top of the slide):
 * then off the bottom edge, and if both are cut off, inside the box.
 * `size` is the handle's size in pixels.
 */
export function rotateHandlePlace(box: Box, view: View, stage: Size, { gap, size }: { gap: number, size: number }): RotateHandlePlace {
  const middle = center(box)
  const shows = (offset: number) => {
    // The handle's center in the box's upright frame, in canvas units from its center, turned onto the stage.
    const turned = rotateVector({ x: 0, y: offset / view.scale }, box.rotate)
    const point = toStage(view, { x: middle.x + turned.x, y: middle.y + turned.y })
    const half = size / 2
    return point.x >= half && point.x <= stage.width - half && point.y >= half && point.y <= stage.height - half
  }
  const tall = box.h * view.scale / 2
  if (shows(-tall - gap))
    return 'above'
  if (shows(tall + gap))
    return 'below'
  return 'inside'
}

/** How much a wheel turn zooms: each 100 pixels of scrolling zooms by about a fifth. */
export function wheelZoom(scale: number, deltaY: number) {
  return clampZoom(scale * Math.exp(-deltaY * 0.002))
}
