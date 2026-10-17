<script setup lang="ts">
import type { Position, PositionedElement } from '@deyslide/deck-model'
import type * as Y from 'yjs'
import type { DeckSession, Peer } from '../deck/session'
import type { ElementSize, RenderRequest } from '../preview/protocol'
import type { Bounds, Box, Guide, Handle, Point, Size, View } from './geometry'
import { deleteElement, duplicateElement, elementText, updateElement } from '@deyslide/deck-model'
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import { publishPresence } from '../deck/presence'
import { LOCAL_ORIGIN } from '../deck/session'
import SlidePreviewFrame from '../editor/SlidePreviewFrame.vue'
import { boxOf, slideElements } from './elements'
import {
  boundsOf,
  CANVAS,
  clampView,
  fitView,
  handleOffset,
  hitTest,
  keepOnSlide,
  panBy,
  pinchView,
  resizeBox,
  rotateHandleGap,
  rotateHandlePlace,
  rotationFor,
  round2,
  shownHandles,
  snapMove,
  snapResize,
  toCanvas,
  unionBounds,
  wheelZoom,
  zoomAt,
} from './geometry'
import InlineTextEditor from './InlineTextEditor.vue'

/**
 * The slide on show, with its elements laid over it to select, move,
 * resize, turn and edit. The preview frame draws the slide; an overlay in
 * this page, at the slide's 980 by 551.25 canvas scale, draws boxes and
 * handles and takes the pointer. Every change goes into the live deck
 * through the session, so others see it and undo covers it.
 */
const props = defineProps<{
  session: DeckSession
  slideId: string
  request?: RenderRequest
  /** Ids of the selected elements of this slide. */
  selection: string[]
  /** Nothing changes: the deck is view only or read only, or the assistant is at work. */
  locked: boolean
}>()
const emit = defineEmits<{
  'update:selection': [ids: string[]]
  'rendered': [result: { id?: string, clicks: number }]
  'error': [message: string]
  /** A double click or double tap on an element that has no text to edit in place: its settings are wanted. */
  'inspect': [id: string]
}>()

/** How often a drag writes into the deck, at most. */
const WRITE_INTERVAL_MS = 50
/** How often the pointer goes to others, at most. */
const POINTER_INTERVAL_MS = 50
/** Two taps on one element closer together than this edit it. */
const DOUBLE_TAP_MS = 400
/** How far a press moves, in pixels, before it is a drag rather than a click. */
const DRAG_START = { mouse: 4, touch: 8 }
/** Where Mod-d puts a copy, from the original. */
const DUPLICATE_OFFSET = { x: 20, y: 20 }
/** The longest the preview waits after a gesture for a render with its changes. */
const HOLD_LIMIT_MS = 1000
/** The handles at the corners, which a small box keeps. */
const ZOOMS = [0.5, 1, 2]

// The slide's elements, read again whenever the deck changes ---------------------

const elements = shallowRef<PositionedElement[]>([])

watch(() => [props.session, props.slideId] as const, ([session, slideId], _, onCleanup) => {
  const read = () => {
    elements.value = slideElements(session.doc, slideId)
  }
  read()
  session.doc.on('update', read)
  onCleanup(() => session.doc.off('update', read))
}, { immediate: true })

// Selection. Kept here too, so a drag can start before the page passes it back.

const chosen = ref<string[]>([...props.selection])
watch(() => props.selection, (ids) => {
  chosen.value = [...ids]
})
const selected = computed(() => new Set(chosen.value))

function select(ids: string[]) {
  if (ids.length === chosen.value.length && ids.every((id, index) => id === chosen.value[index]))
    return
  chosen.value = ids
  emit('update:selection', ids)
}

// Elements someone removed are no longer selected.
watch(elements, (list) => {
  const here = new Set(list.map(element => element.id))
  if (chosen.value.some(id => !here.has(id)))
    select(chosen.value.filter(id => here.has(id)))
})

// What the preview shows ----------------------------------------------------------

/**
 * Where moving elements are, ahead of the deck. The preview gets them, so it
 * moves the elements without compiling the slide again. After a gesture they
 * stay until the preview shows a render that has the gesture's change: taken
 * away sooner, the preview would show an older render's places for a moment.
 */
const positions = shallowRef<Record<string, Position>>()
/** The move, resize or turn under way. */
let edit: Edit | undefined
/** Where it puts elements, for the overlay. */
const live = shallowRef<Record<string, Position>>()
/**
 * The render the preview keeps showing during a gesture, so the deck's own
 * changes do not compile the slide again. It stays after the gesture until
 * the page has a render with all of the gesture's changes: one in between
 * would show their places halfway for a moment.
 */
const heldRequest = shallowRef<RenderRequest>()
let holdTimer: ReturnType<typeof setTimeout> | undefined
/** The render sent to the preview, with an id, so its reply says which one is on screen. */
const shownRequest = shallowRef<RenderRequest>()

/** Changes the canvas made to the deck, counted, so a render can tell which of them it has. */
let changes = 0
/** How many changes the canvas had made when the page made each render. */
const changesBefore = new WeakMap<RenderRequest, number>()
/** Whether a render of the page's has every change the canvas made so far. */
const hasAllChanges = (request: RenderRequest | undefined) => request !== undefined && (changesBefore.get(request) ?? -1) >= changes
/** The same, by the id of each render sent to the preview, newest last. */
const sentAfter = new Map<string, number>()
/** Positions left from a gesture go once the preview shows a render made after this many changes. */
let dropAfter = Number.POSITIVE_INFINITY
let renders = 0

watch(() => props.request, (request) => {
  if (request && !changesBefore.has(request))
    changesBefore.set(request, changes)
  if (!edit && heldRequest.value && hasAllChanges(request))
    letGo()
}, { immediate: true, flush: 'sync' })

/** The preview shows the page's renders again. */
function letGo() {
  clearTimeout(holdTimer)
  holdTimer = undefined
  heldRequest.value = undefined
}

watch(() => heldRequest.value ?? props.request, (request) => {
  if (!request) {
    shownRequest.value = undefined
    return
  }
  const id = `canvas-${++renders}`
  sentAfter.set(id, changesBefore.get(request) ?? -1)
  // Only replies to the last few renders can still come.
  if (sentAfter.size > 20)
    sentAfter.delete(sentAfter.keys().next().value!)
  shownRequest.value = { ...request, id }
}, { immediate: true })

function onRendered(result: { id?: string, clicks: number }) {
  const made = result.id === undefined ? undefined : sentAfter.get(result.id)
  if (!edit && made !== undefined && made >= dropAfter) {
    positions.value = undefined
    dropAfter = Number.POSITIVE_INFINITY
  }
  emit('rendered', result)
}

/** How large the preview laid out each element, for those with auto height. */
const measured = shallowRef<Record<string, ElementSize>>({})

const guides = shallowRef<Guide[]>([])

interface Item {
  id: string
  element: PositionedElement
  box: Box
}

const items = computed<Item[]>(() => elements.value.map((element) => {
  const position = live.value?.[element.id] ?? element.pos
  return { id: element.id, element, box: boxOf(element, position, measured.value[element.id]?.h) }
}))

/** The one selected element that shows handles. */
const handled = computed(() => !props.locked && chosen.value.length === 1 ? items.value.find(item => item.id === chosen.value[0]) : undefined)

// The stage: its size, the zoom and the pan -------------------------------------------

const stage = ref<HTMLElement>()
const stageSize = ref<Size>({ width: 0, height: 0 })
/** Fit follows the stage's size. Any other zoom stays until the person changes it. */
const fit = ref(true)
const view = ref<View>({ scale: 1, x: 0, y: 0 })
let observer: ResizeObserver | undefined

function setStageSize(size: Size) {
  stageSize.value = size
  view.value = fit.value ? fitView(size) : clampView(view.value, size)
}

const scale = computed(() => view.value.scale)
const sheetStyle = computed(() => ({
  width: `${CANVAS.width * scale.value}px`,
  height: `${CANVAS.height * scale.value}px`,
  transform: `translate(${view.value.x}px, ${view.value.y}px)`,
}))
/** Whether the slide is larger than the stage, so there is somewhere to pan. */
const overflows = computed(() => CANVAS.width * scale.value > stageSize.value.width + 0.5 || CANVAS.height * scale.value > stageSize.value.height + 0.5)

const zoomChoice = computed(() => fit.value ? 'fit' : String(ZOOMS.find(zoom => Math.abs(zoom - scale.value) < 1e-3) ?? 'custom'))
const zoomLabel = computed(() => `${Math.round(scale.value * 100)}%`)

function chooseZoom(choice: string) {
  if (choice === 'fit') {
    fit.value = true
    view.value = fitView(stageSize.value)
    return
  }
  const next = Number(choice)
  if (!Number.isFinite(next) || next <= 0)
    return
  fit.value = false
  view.value = zoomAt(view.value, next, { x: stageSize.value.width / 2, y: stageSize.value.height / 2 }, stageSize.value)
}

function stagePoint(event: MouseEvent): Point {
  const rect = stage.value?.getBoundingClientRect()
  return { x: event.clientX - (rect?.left ?? 0), y: event.clientY - (rect?.top ?? 0) }
}

const canvasPoint = (event: MouseEvent) => toCanvas(view.value, stagePoint(event))

/** Handles are larger where fingers press them. */
const coarse = ref(false)
let coarseQuery: MediaQueryList | undefined
const readCoarse = () => {
  coarse.value = Boolean(coarseQuery?.matches)
}
const handleSize = computed(() => coarse.value ? 24 : 10)

/** The handles the selected box shows: only its corners when it is small on screen. */
const handlesShown = computed(() => {
  const box = handled.value?.box
  return box ? shownHandles(box.w * scale.value, box.h * scale.value, handleSize.value) : []
})
/** How far off the box the rotate handle sits, clear of the resize handles. */
const rotateGap = computed(() => rotateHandleGap(handleSize.value))

/** The rotate handle goes below the box, or inside it, where the stage's edge would cut it off above. */
const rotatePlace = computed(() => handled.value
  ? rotateHandlePlace(handled.value.box, view.value, stageSize.value, { gap: rotateGap.value, size: handleSize.value })
  : 'above')

// Pixels on the stage, for what the overlay draws.

function px(value: number) {
  return `${value * scale.value}px`
}

function boxStyle(box: Box) {
  return {
    left: px(box.x),
    top: px(box.y),
    width: px(box.w),
    height: px(box.h),
    transform: box.rotate ? `rotate(${box.rotate}deg)` : undefined,
  }
}

/** A resize handle, just outside the edge or corner it pulls, so it covers nothing the box shows. */
function handleStyle(box: Box, handle: Handle) {
  const size = handleSize.value
  const place = handleOffset(handle, box.w * scale.value, box.h * scale.value, size)
  return {
    left: `${place.x}px`,
    top: `${place.y}px`,
    width: `${size}px`,
    height: `${size}px`,
    cursor: `${handle}-resize`,
  }
}

/** Where the rotate handle's center sits, in pixels down from the box's top edge. */
function rotateHandleMiddle(box: Box) {
  const height = box.h * scale.value
  switch (rotatePlace.value) {
    case 'above':
      return -rotateGap.value
    case 'below':
      return height + rotateGap.value
    case 'inside':
      return Math.min(rotateGap.value, height / 2)
  }
}

function rotateHandleStyle(box: Box) {
  const size = handleSize.value
  return { left: `${box.w * scale.value / 2 - size / 2}px`, top: `${rotateHandleMiddle(box) - size / 2}px`, width: `${size}px`, height: `${size}px` }
}

/** The line from the box's edge to the rotate handle. */
function rotateLineStyle(box: Box) {
  return { top: rotatePlace.value === 'above' ? `${-rotateGap.value}px` : px(box.h), height: `${rotateGap.value}px` }
}

/** How thick a snap guide is drawn, in pixels at any zoom. */
const GUIDE_WIDTH = 2

/** A snap guide, centered on the line it marks. */
function guideStyle(guide: Guide) {
  const at = `${guide.at * scale.value - GUIDE_WIDTH / 2}px`
  const thick = `${GUIDE_WIDTH}px`
  return guide.axis === 'x'
    ? { left: at, top: px(guide.from), width: thick, height: px(guide.to - guide.from) }
    : { left: px(guide.from), top: at, width: px(guide.to - guide.from), height: thick }
}

// Writing to the deck ----------------------------------------------------------------

/** Runs `fn`, and counts it among the canvas's changes when it changed the deck. */
function counted(fn: () => void) {
  const { doc } = props.session
  let changed = false
  const seen = () => {
    changed = true
  }
  doc.on('update', seen)
  try {
    fn()
  }
  finally {
    doc.off('update', seen)
  }
  if (changed)
    changes++
}

/** Runs one change to the slide's elements as the person, unless editing is locked. */
function change(fn: (doc: Y.Doc) => void) {
  if (!props.locked)
    counted(() => props.session.transact(() => fn(props.session.doc)))
}

/** A change that is its own undo step, not merged with typing or a drag just before. */
function step(fn: (doc: Y.Doc) => void) {
  props.session.undo.stopCapturing()
  change(fn)
  props.session.undo.stopCapturing()
}

type Field = keyof Position

/** A move, resize or turn under way. */
interface Edit {
  group: { end: () => void }
  /** The slide it changes, which stays the same even when the page shows another one before it ends. */
  slideId: string
  /** The position fields it changes. Others' changes to the rest stay. */
  fields: Field[]
  /** Where the elements it changes were when it began. */
  starts: Map<string, Position>
  /** Where it puts them now. Only these are written. */
  moved?: Record<string, Position>
  /** How many steps the undo stack had when it began, so it can take back its own. */
  undoSteps: number
}

let lastWrite = 0
let writeTimer: ReturnType<typeof setTimeout> | undefined

function beginEdit(fields: Field[], starts: Map<string, Position>) {
  // A gesture right after another keeps the render the first one held.
  clearTimeout(holdTimer)
  heldRequest.value ??= props.request
  dropAfter = Number.POSITIVE_INFINITY
  const group = props.session.group()
  edit = { group, slideId: props.slideId, fields, starts, undoSteps: props.session.undo.undoStack.length }
}

function writeNow() {
  clearTimeout(writeTimer)
  writeTimer = undefined
  lastWrite = Date.now()
  const current = edit
  const moved = current?.moved
  if (!current || !moved)
    return
  change((doc) => {
    for (const [id, position] of Object.entries(moved)) {
      const pos = Object.fromEntries(current.fields.map(field => [field, position[field]]))
      try {
        updateElement(doc, current.slideId, id, { pos }, LOCAL_ORIGIN)
      }
      catch {
        // Someone removed the element, or its slide, meanwhile.
      }
    }
  })
}

function scheduleWrite() {
  const wait = lastWrite + WRITE_INTERVAL_MS - Date.now()
  if (wait <= 0)
    writeNow()
  else
    writeTimer ??= setTimeout(writeNow, wait)
}

function setPositions(next: Record<string, Position>) {
  if (!edit)
    return
  edit.moved = next
  live.value = next
  positions.value = { ...positions.value, ...next }
  scheduleWrite()
}

/**
 * Ends a move, resize or turn. Kept, it writes once more and the whole
 * gesture is one undo step. Dropped, the deck goes back to how it was
 * before it, and there is nothing to redo.
 */
function endEdit(keep: boolean) {
  const current = edit
  if (!current)
    return
  if (keep) {
    writeNow()
  }
  else {
    clearTimeout(writeTimer)
    writeTimer = undefined
  }
  edit = undefined
  current.group.end()
  if (!keep) {
    const { undo } = props.session
    if (undo.undoStack.length > current.undoSteps) {
      counted(() => undo.undo())
      undo.redoStack.pop()
    }
    // The preview shows the elements where they started until it renders the deck again.
    const moved = current.moved ?? {}
    positions.value = { ...positions.value, ...Object.fromEntries([...current.starts].filter(([id]) => id in moved)) }
  }
  dropAfter = changes
  live.value = undefined
  guides.value = []
  if (hasAllChanges(props.request))
    letGo()
  else
    holdTimer = setTimeout(letGo, HOLD_LIMIT_MS)
}

// Gestures ----------------------------------------------------------------------------

type Gesture
  = | { kind: 'press', pointerId: number, start: Point, id?: string, handle?: Handle | 'rotate', touch: boolean, shift: boolean, moved: boolean, narrow: boolean }
    | { kind: 'move', pointerId: number, from: Point, starts: Map<string, Position>, bounds: Bounds[], others: Bounds[] }
    | { kind: 'resize', pointerId: number, id: string, handle: Handle, start: Position, box: Box, from: Point, others: Bounds[] }
    | { kind: 'rotate', pointerId: number, id: string, start: Position, box: Box, from: Point }
    | { kind: 'pan', pointerId: number, start: Point, startView: View }
    | { kind: 'pinch', ids: [number, number], from: [Point, Point], startView: View }

let gesture: Gesture | undefined
/** Pointers down on the stage, at their stage points. */
const pointers = new Map<number, Point>()
let lastTap: { id: string, time: number, point: Point } | undefined

/** Ends the gesture under way. A move, resize or turn is kept, unless `keep` is false. */
function endGesture(keep = true) {
  endEdit(keep)
  gesture = undefined
}

function startMove(press: Extract<Gesture, { kind: 'press' }>) {
  const moving = items.value.filter(item => selected.value.has(item.id))
  if (moving.length === 0)
    return
  const starts = new Map(moving.map(item => [item.id, { ...item.element.pos }]))
  beginEdit(['x', 'y'], starts)
  gesture = {
    kind: 'move',
    pointerId: press.pointerId,
    from: toCanvas(view.value, press.start),
    starts,
    bounds: moving.map(item => boundsOf(item.box)),
    others: items.value.filter(item => !selected.value.has(item.id)).map(item => boundsOf(item.box)),
  }
}

/** A press on a handle that moved: it resizes or turns from where it was pressed. */
function startTransform(press: Extract<Gesture, { kind: 'press' }>) {
  const item = items.value.find(entry => entry.id === press.id)
  if (!item || !press.handle)
    return
  const from = toCanvas(view.value, press.start)
  const start = { ...item.element.pos }
  const starts = new Map([[item.id, start]])
  if (press.handle === 'rotate') {
    beginEdit(['rotate'], starts)
    gesture = { kind: 'rotate', pointerId: press.pointerId, id: item.id, start, box: item.box, from }
  }
  else {
    beginEdit(['x', 'y', 'w', 'h'], starts)
    const others = items.value.filter(entry => entry.id !== item.id).map(entry => boundsOf(entry.box))
    gesture = { kind: 'resize', pointerId: press.pointerId, id: item.id, handle: press.handle, start, box: item.box, from, others }
  }
}

function applyMove(move: Extract<Gesture, { kind: 'move' }>, event: PointerEvent) {
  const now = canvasPoint(event)
  let delta = { x: Math.round(now.x - move.from.x), y: Math.round(now.y - move.from.y) }
  let shown: Guide[] = []
  // Alt (Option) moves freely.
  if (!event.altKey) {
    const snapped = snapMove(unionBounds(move.bounds), delta, move.others)
    delta = snapped.delta
    shown = snapped.guides
  }
  // Each element keeps a part on the slide, so it can be grabbed again.
  const kept = keepOnSlide(move.bounds, delta)
  // A guide on an axis the slide's edge held back no longer lines up.
  shown = shown.filter(guide => guide.axis === 'x' ? kept.x === delta.x : kept.y === delta.y)
  guides.value = shown
  setPositions(Object.fromEntries([...move.starts].map(([id, pos]) => [id, { ...pos, x: round2(pos.x + kept.x), y: round2(pos.y + kept.y) }])))
}

function applyResize(resize: Extract<Gesture, { kind: 'resize' }>, event: PointerEvent) {
  const now = canvasPoint(event)
  const delta = { x: Math.round(now.x - resize.from.x), y: Math.round(now.y - resize.from.y) }
  const keepRatio = event.shiftKey
  // An auto height stays auto while the drag leaves the height as it was,
  // so its bottom edge does not snap then.
  const keepsHeight = (box: Box) => resize.start.h === null && !keepRatio && Math.abs(box.h - resize.box.h) < 0.5
  let box = resizeBox(resize.box, resize.handle, delta, { keepRatio })
  let shown: Guide[] = []
  // Alt (Option) resizes freely, and so does a box turned away from 0 degrees (see `snapResize`).
  if (!event.altKey) {
    const snapped = snapResize(resize.box, resize.handle, delta, resize.others, { keepRatio, axes: { y: !keepsHeight(box) } })
    box = snapped.box
    shown = snapped.guides
  }
  guides.value = shown
  const autoHeight = keepsHeight(box)
  setPositions({ [resize.id]: { x: round2(box.x), y: round2(box.y), w: round2(box.w), h: autoHeight ? null : round2(box.h), rotate: resize.start.rotate } })
}

function applyRotate(rotate: Extract<Gesture, { kind: 'rotate' }>, event: PointerEvent) {
  const angle = rotationFor(rotate.box, rotate.from, canvasPoint(event), { snap: event.shiftKey })
  setPositions({ [rotate.id]: { ...rotate.start, rotate: Math.round(angle) || 0 } })
}

function startPinch() {
  // A second finger makes a pinch: what the first one began moving goes back.
  endGesture(false)
  const [[a, from], [b, to]] = [...pointers]
  gesture = { kind: 'pinch', ids: [a, b], from: [from, to], startView: view.value }
}

function onPointerDown(event: PointerEvent) {
  const target = event.target as Element | null
  if (editorHost.value?.contains(target))
    return
  if (event.pointerType === 'mouse') {
    if (event.button !== 0)
      return
    // A mouse has one pointer: a press it never let go of (outside the window, say) is over.
    endGesture()
    pointers.clear()
  }
  else {
    // No mouse events follow a finger's press: after a double tap they would
    // reach the text editor it opens, and select a word there.
    event.preventDefault()
  }
  stage.value?.focus({ preventScroll: true })
  const point = stagePoint(event)
  pointers.set(event.pointerId, point)
  try {
    stage.value?.setPointerCapture(event.pointerId)
  }
  catch {
    // Not a pointer the browser knows: nothing to capture.
  }
  if (pointers.size === 2 && event.pointerType !== 'mouse') {
    startPinch()
    return
  }
  if (pointers.size > 1 || gesture)
    return
  const touch = event.pointerType !== 'mouse'

  const handle = target?.closest?.('[data-handle]')?.getAttribute('data-handle') as Handle | 'rotate' | null | undefined
  const item = handled.value
  if (handle && item) {
    // It resizes or turns once it moves. A tap on a handle is a tap on its element.
    gesture = { kind: 'press', pointerId: event.pointerId, start: point, id: item.id, handle, touch, shift: event.shiftKey, moved: false, narrow: false }
    return
  }

  let id = hitTest(items.value, toCanvas(view.value, point))
  let narrow = false
  if (id && event.shiftKey) {
    // Shift adds an element to the selection, or takes it out.
    if (selected.value.has(id)) {
      select(chosen.value.filter(chosenId => chosenId !== id))
      id = undefined
    }
    else {
      select([...chosen.value, id])
    }
  }
  else if (id && !selected.value.has(id)) {
    select([id])
  }
  else if (id) {
    // Pressed on one of several selected: they move together, and a click selects just it.
    narrow = chosen.value.length > 1
  }
  else if (!event.shiftKey) {
    select([])
  }
  gesture = { kind: 'press', pointerId: event.pointerId, start: point, id, touch, shift: event.shiftKey, moved: false, narrow }
}

function onPointerMove(event: PointerEvent) {
  if (!pointers.has(event.pointerId))
    return
  const point = stagePoint(event)
  pointers.set(event.pointerId, point)
  const current = gesture
  if (!current)
    return
  if (current.kind === 'pinch') {
    const [a, b] = current.ids.map(id => pointers.get(id))
    if (a && b) {
      fit.value = false
      view.value = pinchView(current.startView, current.from, [a, b], stageSize.value)
    }
    return
  }
  if (event.pointerId !== current.pointerId)
    return
  switch (current.kind) {
    case 'press': {
      if (current.moved || Math.hypot(point.x - current.start.x, point.y - current.start.y) < DRAG_START[current.touch ? 'touch' : 'mouse'])
        return
      current.moved = true
      if (current.handle && !props.locked)
        startTransform(current)
      else if (current.id && !current.handle && !props.locked)
        startMove(current)
      else if (!current.id && overflows.value)
        gesture = { kind: 'pan', pointerId: current.pointerId, start: current.start, startView: view.value }
      if (gesture !== current)
        onPointerMove(event)
      return
    }
    case 'move':
      return applyMove(current, event)
    case 'resize':
      return applyResize(current, event)
    case 'rotate':
      return applyRotate(current, event)
    case 'pan':
      fit.value = false
      view.value = panBy(current.startView, { x: point.x - current.start.x, y: point.y - current.start.y }, stageSize.value)
  }
}

function tapped(press: Extract<Gesture, { kind: 'press' }>) {
  // Shift changes the selection: such a press is never half of a double tap.
  if (press.moved || !press.id || press.shift) {
    lastTap = undefined
    return
  }
  if (press.narrow)
    select([press.id])
  const now = Date.now()
  const previous = lastTap
  if (previous && previous.id === press.id && now - previous.time < DOUBLE_TAP_MS && Math.hypot(previous.point.x - press.start.x, previous.point.y - press.start.y) < 24) {
    lastTap = undefined
    if (!openEditor(press.id))
      emit('inspect', press.id)
    return
  }
  lastTap = { id: press.id, time: now, point: press.start }
}

function onPointerUp(event: PointerEvent) {
  if (!pointers.delete(event.pointerId))
    return
  const current = gesture
  if (!current)
    return
  if (current.kind === 'pinch') {
    if (current.ids.includes(event.pointerId))
      gesture = undefined
    return
  }
  if (current.pointerId !== event.pointerId)
    return
  if (current.kind === 'press' && event.type === 'pointerup')
    tapped(current)
  endGesture()
}

function onWheel(event: WheelEvent) {
  // The text editor scrolls its own text.
  if (editorHost.value?.contains(event.target as Node))
    return
  const point = stagePoint(event)
  if (event.ctrlKey || event.metaKey) {
    // Mod and the wheel, or a pinch on a touchpad.
    event.preventDefault()
    fit.value = false
    view.value = zoomAt(view.value, wheelZoom(scale.value, event.deltaY), point, stageSize.value)
    return
  }
  if (overflows.value) {
    event.preventDefault()
    fit.value = false
    view.value = panBy(view.value, { x: -event.deltaX, y: -event.deltaY }, stageSize.value)
  }
}

// Others see where the pointer is -------------------------------------------------------

let pointerSent = 0
let pointerTimer: ReturnType<typeof setTimeout> | undefined
let pointerNext: Point | null = null

function sendPointer() {
  clearTimeout(pointerTimer)
  pointerTimer = undefined
  pointerSent = Date.now()
  publishPresence(props.session.awareness, { pointer: pointerNext && { x: round2(pointerNext.x), y: round2(pointerNext.y) } })
}

/** Shares the pointer in canvas units about 20 times a second, and null at once when it leaves. */
function sharePointer(point: Point | null) {
  pointerNext = point
  if (point === null) {
    sendPointer()
    return
  }
  const wait = pointerSent + POINTER_INTERVAL_MS - Date.now()
  if (wait <= 0)
    sendPointer()
  else
    pointerTimer ??= setTimeout(sendPointer, wait)
}

function onHover(event: PointerEvent) {
  sharePointer(canvasPoint(event))
}

// Others' selections and pointers on this slide.

const peersHere = computed(() => props.session.peers.value.filter(peer => peer.slideId === props.slideId && peer.view === 'design'))

const peerOutlines = computed(() => peersHere.value.flatMap(peer => (peer.selection ?? []).flatMap((id) => {
  const item = items.value.find(entry => entry.id === id)
  return item ? [{ key: `${peer.clientId}:${id}`, peer, box: item.box }] : []
})))

const peerPointers = computed(() => peersHere.value.filter((peer): peer is Peer & { pointer: Point } =>
  Boolean(peer.pointer) && Number.isFinite(peer.pointer?.x) && Number.isFinite(peer.pointer?.y)))

// Editing text in place ----------------------------------------------------------------------

const editing = shallowRef<{ id: string, text: Y.Text }>()
const editorHost = ref<HTMLElement>()

/** Opens the text editor on a text element. Says whether it did. */
function openEditor(id: string) {
  const element = elements.value.find(entry => entry.id === id)
  if (props.locked || element?.type !== 'text')
    return false
  let text: Y.Text
  try {
    text = elementText(props.session.doc, props.slideId, id)
  }
  catch {
    return false
  }
  select([id])
  editing.value = { id, text }
  return true
}

function closeEditor() {
  if (!editing.value)
    return
  editing.value = undefined
  stage.value?.focus({ preventScroll: true })
}

const editorStyle = computed(() => {
  const item = editing.value && items.value.find(entry => entry.id === editing.value!.id)
  if (!item)
    return {}
  return {
    left: px(item.box.x),
    top: px(item.box.y),
    width: `${Math.max(item.box.w * scale.value, 160)}px`,
    height: `${Math.max(item.box.h * scale.value, 48)}px`,
  }
})
const editorFontSize = computed(() => Math.max(12, Math.round(18 * scale.value)))

// The editor closes when its element goes away, or its text is replaced.
watch(elements, () => {
  const current = editing.value
  if (!current)
    return
  try {
    if (elementText(props.session.doc, props.slideId, current.id) === current.text)
      return
  }
  catch {
    // The element is gone.
  }
  closeEditor()
})

/** A press anywhere outside the editor closes it. */
function onPressAnywhere(event: PointerEvent) {
  if (editing.value && !editorHost.value?.contains(event.target as Node))
    closeEditor()
}

// The keyboard ------------------------------------------------------------------------------

function inEditableField(target: EventTarget | null) {
  return target instanceof Element && Boolean(target.closest('input, textarea, select, [contenteditable="true"], [contenteditable=""], .cm-editor'))
}

/** A dialog is open, such as the share dialog. Focus can fall back to the page behind it. */
function dialogOpen() {
  return Boolean(document.querySelector('[role="dialog"], [role="alertdialog"]'))
}

/**
 * Shortcuts work when focus is on the page itself or in the canvas, never
 * in a field, and never while a dialog is open: its keys are its own.
 */
function forCanvas(event: KeyboardEvent) {
  if (event.defaultPrevented || inEditableField(event.target) || dialogOpen())
    return false
  const active = document.activeElement
  return !active || active === document.body || Boolean(active.closest('[data-canvas-keys]')) || Boolean(stage.value?.contains(active))
}

/** Focus on the stage or the page itself, so Enter belongs to no button or link. */
function onStageOrPage(target: EventTarget | null) {
  return target === stage.value || target === document.body || target === document.documentElement
}

/** Bounds of the selected elements. */
function selectedBounds() {
  return items.value.filter(item => selected.value.has(item.id)).map(item => boundsOf(item.box))
}

function nudge(dx: number, dy: number) {
  const moving = items.value.filter(item => selected.value.has(item.id))
  if (moving.length === 0)
    return
  const delta = keepOnSlide(selectedBounds(), { x: dx, y: dy })
  change((doc) => {
    for (const item of moving) {
      try {
        updateElement(doc, props.slideId, item.id, { pos: { x: round2(item.element.pos.x + delta.x), y: round2(item.element.pos.y + delta.y) } }, LOCAL_ORIGIN)
      }
      catch {
        // Someone removed the element meanwhile.
      }
    }
  })
}

function removeSelected() {
  const ids = chosen.value
  step((doc) => {
    for (const id of ids) {
      try {
        deleteElement(doc, props.slideId, id, LOCAL_ORIGIN)
      }
      catch {
        // Someone removed it already.
      }
    }
  })
  select([])
}

function duplicateSelected() {
  const copies: string[] = []
  // Copies keep a part on the slide too, so they can be grabbed.
  const offset = keepOnSlide(selectedBounds(), DUPLICATE_OFFSET)
  step((doc) => {
    for (const id of chosen.value) {
      try {
        copies.push(duplicateElement(doc, props.slideId, id, offset, LOCAL_ORIGIN))
      }
      catch {
        // Someone removed the element meanwhile.
      }
    }
  })
  if (copies.length)
    select(copies)
}

const ARROWS: Record<string, Point> = {
  ArrowLeft: { x: -1, y: 0 },
  ArrowRight: { x: 1, y: 0 },
  ArrowUp: { x: 0, y: -1 },
  ArrowDown: { x: 0, y: 1 },
}

function onKeydown(event: KeyboardEvent) {
  if (editing.value || !forCanvas(event))
    return
  const mod = event.metaKey || event.ctrlKey
  const key = event.key.length === 1 ? event.key.toLowerCase() : event.key
  if (key === 'Escape') {
    if (chosen.value.length) {
      event.preventDefault()
      select([])
    }
    return
  }
  if (props.locked)
    return
  if (mod && (key === 'z' || key === 'y')) {
    event.preventDefault()
    if (key === 'y' || event.shiftKey)
      props.session.redoStep()
    else
      props.session.undoStep()
    return
  }
  if (chosen.value.length === 0)
    return
  if (mod && key === 'd') {
    event.preventDefault()
    duplicateSelected()
    return
  }
  if (mod || event.altKey)
    return
  if (key === 'Delete' || key === 'Backspace') {
    event.preventDefault()
    removeSelected()
  }
  else if (ARROWS[key]) {
    event.preventDefault()
    const by = event.shiftKey ? 10 : 1
    nudge(ARROWS[key].x * by, ARROWS[key].y * by)
  }
  else if (key === 'Enter' && chosen.value.length === 1 && onStageOrPage(event.target)) {
    // Enter on the stage edits the selected text. On a focused button it presses the button.
    if (openEditor(chosen.value[0]))
      event.preventDefault()
  }
}

// Changes from outside ---------------------------------------------------------------------

function reset() {
  endGesture()
  pointers.clear()
  closeEditor()
  positions.value = undefined
  measured.value = {}
  dropAfter = Number.POSITIVE_INFINITY
  letGo()
  lastTap = undefined
}

watch(() => props.slideId, reset)
watch(() => props.locked, (locked) => {
  if (locked) {
    // Nothing more reaches the deck, so the preview shows the deck as it is.
    endGesture()
    positions.value = undefined
    closeEditor()
  }
})

onMounted(() => {
  observer = new ResizeObserver(([entry]) => setStageSize({ width: entry.contentRect.width, height: entry.contentRect.height }))
  observer.observe(stage.value!)
  coarseQuery = window.matchMedia?.('(pointer: coarse)')
  readCoarse()
  coarseQuery?.addEventListener?.('change', readCoarse)
  window.addEventListener('pointermove', onPointerMove)
  window.addEventListener('pointerup', onPointerUp)
  window.addEventListener('pointercancel', onPointerUp)
  window.addEventListener('pointerdown', onPressAnywhere, true)
  window.addEventListener('keydown', onKeydown)
})

onBeforeUnmount(() => {
  reset()
  observer?.disconnect()
  coarseQuery?.removeEventListener?.('change', readCoarse)
  window.removeEventListener('pointermove', onPointerMove)
  window.removeEventListener('pointerup', onPointerUp)
  window.removeEventListener('pointercancel', onPointerUp)
  window.removeEventListener('pointerdown', onPressAnywhere, true)
  window.removeEventListener('keydown', onKeydown)
  clearTimeout(writeTimer)
  sharePointer(null)
})
</script>

<template>
  <div class="flex min-w-0 flex-col gap-2">
    <div
      ref="stage"
      class="relative aspect-video w-full touch-none select-none overflow-hidden rounded-md bg-black outline-none focus-visible:ring-2 focus-visible:ring-dey-accent"
      tabindex="0"
      role="application"
      aria-label="Slide canvas"
      data-testid="slide-stage"
      :data-locked="locked || undefined"
      @pointerdown="onPointerDown"
      @pointermove="onHover"
      @pointerleave="sharePointer(null)"
      @wheel="onWheel"
    >
      <div class="absolute left-0 top-0" :style="sheetStyle" data-testid="stage-sheet">
        <SlidePreviewFrame
          class="pointer-events-none !rounded-none !border-0"
          :request="shownRequest"
          :positions="positions"
          @rendered="onRendered"
          @error="emit('error', $event)"
          @sizes="measured = $event"
        />
        <div class="pointer-events-none absolute inset-0" data-testid="stage-overlay">
          <div
            v-for="item in items"
            :key="item.id"
            class="absolute"
            :class="selected.has(item.id) ? 'ring-2 ring-dey-accent' : 'ring-1 ring-white/10'"
            :style="boxStyle(item.box)"
            :data-element="item.id"
            :data-type="item.element.type"
            :data-selected="selected.has(item.id) || undefined"
            data-testid="element-box"
          >
            <template v-if="handled?.id === item.id">
              <span
                v-for="handle in handlesShown"
                :key="handle"
                class="pointer-events-auto absolute rounded-sm border border-slate-900 bg-dey-accent"
                :style="handleStyle(item.box, handle)"
                :data-handle="handle"
                data-testid="resize-handle"
              />
              <span v-if="rotatePlace !== 'inside'" class="absolute left-1/2 w-px bg-dey-accent" :style="rotateLineStyle(item.box)" />
              <span
                class="pointer-events-auto absolute cursor-grab rounded-full border border-slate-900 bg-dey-accent"
                :style="rotateHandleStyle(item.box)"
                data-handle="rotate"
                :data-place="rotatePlace"
                data-testid="rotate-handle"
              />
            </template>
          </div>
          <div
            v-for="guide in guides"
            :key="`${guide.axis}:${guide.at}`"
            class="absolute bg-fuchsia-400 shadow-[0_0_0_1px_rgba(2,6,23,0.5)]"
            :style="guideStyle(guide)"
            :data-axis="guide.axis"
            :data-at="guide.at"
            data-testid="snap-guide"
          />
          <div
            v-for="outline in peerOutlines"
            :key="outline.key"
            class="absolute border-2"
            :style="{ ...boxStyle(outline.box), borderColor: outline.peer.user.color }"
            :data-peer="outline.peer.user.name"
            data-testid="peer-selection"
          >
            <span class="absolute bottom-full left-0 whitespace-nowrap rounded-t px-1 text-xs font-medium text-slate-950" :style="{ backgroundColor: outline.peer.user.color }">
              {{ outline.peer.user.name }}
            </span>
          </div>
          <div
            v-for="peer in peerPointers"
            :key="peer.clientId"
            class="absolute"
            :style="{ left: px(peer.pointer.x), top: px(peer.pointer.y) }"
            :data-peer="peer.user.name"
            data-testid="peer-pointer"
          >
            <svg width="14" height="18" viewBox="0 0 14 18" aria-hidden="true">
              <path d="M1 1 L1 15 L5 11 L8 17 L10 16 L7 10 L13 10 Z" :fill="peer.user.color" stroke="#0f172a" stroke-width="1" />
            </svg>
            <span class="absolute left-3 top-4 whitespace-nowrap rounded px-1 text-xs font-medium text-slate-950" :style="{ backgroundColor: peer.user.color }">
              {{ peer.user.name }}
            </span>
          </div>
        </div>
        <div v-if="editing" ref="editorHost" class="absolute touch-auto" :style="editorStyle">
          <InlineTextEditor class="h-full" :text="editing.text" :session="session" :font-size="editorFontSize" @close="closeEditor" />
        </div>
      </div>
    </div>
    <div class="flex items-center justify-end gap-2 text-sm text-dey-muted">
      <label for="stage-zoom">Zoom</label>
      <select
        id="stage-zoom"
        class="dey-input w-auto py-1 text-sm"
        :value="zoomChoice"
        data-testid="zoom"
        @change="chooseZoom(($event.target as HTMLSelectElement).value)"
      >
        <option value="fit">
          Fit
        </option>
        <option v-for="zoom in ZOOMS" :key="zoom" :value="String(zoom)">
          {{ zoom * 100 }}%
        </option>
        <option v-if="zoomChoice === 'custom'" value="custom" disabled>
          {{ zoomLabel }}
        </option>
      </select>
      <span data-testid="zoom-level">{{ zoomLabel }}</span>
    </div>
  </div>
</template>
