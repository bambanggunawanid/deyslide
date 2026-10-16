import type { FromPreview, KeyTarget } from './protocol'

/**
 * While presenting, the slide fills the window, so presses, swipes and keys
 * land in the frame rather than on the page around it. The frame passes them
 * on, and the page moves the talk as it would for its own. A press on
 * something the slide lets people use (a button, a form field, a 3D scene
 * with orbit controls, an animation player) says so, and the page leaves it
 * to the slide.
 */

/** What people can press, type in or drag inside a slide. */
const INTERACTIVE = [
  'a[href]',
  'button',
  'input',
  'select',
  'textarea',
  'label',
  'summary',
  'video[controls]',
  'audio[controls]',
  '[contenteditable]:not([contenteditable="false"])',
  '[role="button"]',
  '[role="link"]',
  '[role="checkbox"]',
  '[role="switch"]',
  '[role="slider"]',
  '[role="tab"]',
  '[role="menuitem"]',
  '[tabindex]:not([tabindex="-1"])',
  '[data-interactive]',
  '[data-orbit-controls="on"]',
  'motion-canvas-player',
].join(', ')

/** Input types people type into, where every key but Escape belongs to the field. */
const TEXT_INPUTS = new Set(['text', 'search', 'email', 'url', 'tel', 'password', 'number', 'range', 'date', 'time', 'datetime-local', 'month', 'week'])

/** Controls that Space and Enter press. */
const CONTROLS = 'button, a[href], summary, input, [role="button"], [role="link"], [role="checkbox"], [role="switch"], [role="tab"], [role="menuitem"]'

/** Whether a press on this path (from `composedPath()`) is meant for the slide itself. */
export function isInteractive(path: readonly EventTarget[]): boolean {
  return path.some(item => item instanceof Element && item.matches(INTERACTIVE))
}

/**
 * What a key press lands on: a field people type in, a control that Space
 * and Enter press, or neither.
 */
export function keyTarget(target: EventTarget | null | undefined): KeyTarget {
  const element = target instanceof Element ? target : undefined
  const field = element?.closest('input, textarea, select, [contenteditable]')
  if (field && field.getAttribute('contenteditable') !== 'false')
    return field.tagName === 'INPUT' && !TEXT_INPUTS.has((field as HTMLInputElement).type) ? 'control' : 'text'
  return element?.closest(CONTROLS) ? 'control' : 'none'
}

/** Pointer moves are passed on at most this often, enough to show the page's controls. */
const MOVE_INTERVAL_MS = 100

/**
 * Passes presses, moves and keys on to the page while `presenting()` says
 * so. Positions are the frame's own CSS pixels. Returns a function that stops.
 */
export function forwardInput(send: (message: FromPreview) => void, presenting: () => boolean) {
  let lastMove = 0
  const pointer = (phase: 'down' | 'move' | 'up' | 'cancel') => (event: PointerEvent) => {
    if (!presenting())
      return
    if (phase === 'move') {
      if (event.timeStamp - lastMove < MOVE_INTERVAL_MS)
        return
      lastMove = event.timeStamp
    }
    send({
      type: 'deyslide:pointer',
      phase,
      pointerId: event.pointerId,
      pointerType: event.pointerType,
      button: event.button,
      x: event.clientX,
      y: event.clientY,
      interactive: isInteractive(event.composedPath()),
    })
  }
  const key = (event: KeyboardEvent) => {
    if (!presenting())
      return
    send({
      type: 'deyslide:key',
      key: event.key,
      ctrlKey: event.ctrlKey,
      altKey: event.altKey,
      metaKey: event.metaKey,
      shiftKey: event.shiftKey,
      target: keyTarget(event.composedPath()[0] ?? event.target),
    })
  }
  const listeners: [string, (event: never) => void][] = [
    ['pointerdown', pointer('down')],
    ['pointermove', pointer('move')],
    ['pointerup', pointer('up')],
    ['pointercancel', pointer('cancel')],
    ['keydown', key],
  ]
  // Capture first, so a slide that stops an event from spreading still lets the page know.
  for (const [type, listener] of listeners)
    window.addEventListener(type, listener as EventListener, true)
  return () => {
    for (const [type, listener] of listeners)
      window.removeEventListener(type, listener as EventListener, true)
  }
}
