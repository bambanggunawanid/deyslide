import type { KeyTarget } from '../preview/protocol'

/**
 * Moving through a talk: which slide is on screen and how many of its
 * clicks are shown. Pure functions over what the page knows about the deck,
 * so the audience and presenter pages, the keyboard and autoplay all move
 * the same way, the way Slidev moves.
 */

/** A slide, counted from 0, and the clicks of it on screen. */
export interface PresentPosition {
  slide: number
  clicks: number
}

/**
 * What navigation knows about the deck: how many slides it has, and each
 * slide's click count once the preview has drawn that slide and said so.
 */
export interface PresentDeck {
  slides: number
  clicks: readonly (number | undefined)[]
}

/**
 * Clicks for "every click of the slide", while the slide's count is not
 * known yet. The preview stops at the slide's last click, says how many it
 * has, and {@link settle} puts the real number in.
 */
export const LAST_CLICKS = 999_999

/** How long autoplay shows each step of a slide that does not say. */
export const DEFAULT_DWELL_MS = 4000

function clamp(value: number, low: number, high: number) {
  return Math.min(Math.max(value, low), high)
}

/** The slide's click count, when the preview has reported it. */
function clicksOf(deck: PresentDeck, slide: number) {
  return deck.clicks[slide]
}

/** A position that lies inside the deck: a real slide, and no more clicks than that slide has (when known). */
export function settle(deck: PresentDeck, at: PresentPosition): PresentPosition {
  const slide = clamp(Math.trunc(at.slide) || 0, 0, Math.max(deck.slides - 1, 0))
  const total = clicksOf(deck, slide)
  const wanted = Math.max(Math.trunc(at.clicks) || 0, 0)
  return { slide, clicks: total === undefined ? Math.min(wanted, LAST_CLICKS) : Math.min(wanted, total) }
}

/** True on the last step of the last slide. */
export function atEnd(deck: PresentDeck, at: PresentPosition) {
  const here = settle(deck, at)
  const total = clicksOf(deck, here.slide)
  return here.slide >= deck.slides - 1 && (total === undefined ? here.clicks >= LAST_CLICKS : here.clicks >= total)
}

/** True on the first step of the first slide. */
export function atStart(deck: PresentDeck, at: PresentPosition) {
  const here = settle(deck, at)
  return here.slide === 0 && here.clicks === 0
}

/**
 * The next step: the slide's next click, else the next slide from its
 * start. A slide whose clicks are not known yet steps one click, and the
 * preview's reply settles it. The last step stays where it is.
 */
export function next(deck: PresentDeck, at: PresentPosition): PresentPosition {
  const here = settle(deck, at)
  const total = clicksOf(deck, here.slide)
  const more = total === undefined ? here.clicks < LAST_CLICKS : here.clicks < total
  if (more)
    return { slide: here.slide, clicks: here.clicks + 1 }
  if (here.slide < deck.slides - 1)
    return { slide: here.slide + 1, clicks: 0 }
  return here
}

/**
 * The step before: the click before, else the previous slide at its last
 * click, as in Slidev. The first step stays where it is.
 */
export function previous(deck: PresentDeck, at: PresentPosition): PresentPosition {
  const here = settle(deck, at)
  // Every click of a slide whose count is still unknown: nothing tells which click is one less.
  if (here.clicks > 0 && here.clicks < LAST_CLICKS)
    return { slide: here.slide, clicks: here.clicks - 1 }
  if (here.slide > 0)
    return { slide: here.slide - 1, clicks: clicksOf(deck, here.slide - 1) ?? LAST_CLICKS }
  return { slide: 0, clicks: 0 }
}

/** A slide, counted from 0, from its start. Numbers past either end stop at that end. */
export function goTo(deck: PresentDeck, slide: number, clicks = 0): PresentPosition {
  return settle(deck, { slide, clicks })
}

export function first(deck: PresentDeck): PresentPosition {
  return goTo(deck, 0)
}

/** The last slide, from its start, like Slidev's End key. */
export function last(deck: PresentDeck): PresentPosition {
  return goTo(deck, deck.slides - 1)
}

/**
 * Where a person typing a slide number wants to go: the slide counted from
 * 1, or undefined when the text is not a slide number of this deck.
 */
export function slideNumber(deck: PresentDeck, typed: string): number | undefined {
  const text = typed.trim()
  if (!/^\d+$/.test(text))
    return undefined
  const number = Number(text)
  return number >= 1 && number <= deck.slides ? number - 1 : undefined
}

/** The step after this one for autoplay: the next one, the first again when looping, or undefined at the end. */
export function autoplayNext(deck: PresentDeck, at: PresentPosition, loop: boolean): PresentPosition | undefined {
  if (!atEnd(deck, at))
    return next(deck, at)
  return loop && deck.slides > 0 ? first(deck) : undefined
}

/**
 * How long autoplay shows each click step of a slide: its `videoDwell`
 * seconds, as for video export, else 4 seconds.
 */
export function dwellMs(frontmatter: Record<string, unknown>): number {
  const seconds = frontmatter.videoDwell
  if (typeof seconds === 'number' && Number.isFinite(seconds) && seconds > 0)
    return Math.round(seconds * 1000)
  return DEFAULT_DWELL_MS
}

/** What a key does while presenting. */
export type PresentAction
  = | 'next'
    | 'previous'
    | 'first'
    | 'last'
    | 'fullscreen'
    | 'overview'
    | 'goto'
    | 'autoplay'
    | 'escape'

/** Keys while presenting, by `KeyboardEvent.key`. Letters match in either case. */
export const PRESENT_KEYS: Readonly<Record<string, PresentAction>> = {
  'ArrowRight': 'next',
  'ArrowDown': 'next',
  ' ': 'next',
  'PageDown': 'next',
  'n': 'next',
  'Enter': 'next',
  'ArrowLeft': 'previous',
  'ArrowUp': 'previous',
  'PageUp': 'previous',
  'p': 'previous',
  'Backspace': 'previous',
  'Home': 'first',
  'End': 'last',
  'f': 'fullscreen',
  'o': 'overview',
  'g': 'goto',
  'a': 'autoplay',
  'Escape': 'escape',
}

/**
 * The action for a key press, or undefined. Shortcuts with Control, Alt
 * or Meta belong to the browser or the system, so they do nothing here.
 */
export function keyAction(event: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'altKey' | 'metaKey'>): PresentAction | undefined {
  if (event.ctrlKey || event.altKey || event.metaKey)
    return undefined
  const key = event.key.length === 1 ? event.key.toLowerCase() : event.key
  return Object.hasOwn(PRESENT_KEYS, key) ? PRESENT_KEYS[key] : undefined
}

/**
 * Whether a key belongs to what it was pressed on rather than to the talk:
 * every key but Escape in a field people type in, and Space or Enter on a
 * focused control, which press it. Elsewhere, a checkbox just ticked
 * included, talk keys move the talk.
 */
export function keyBelongsTo(target: KeyTarget, key: string): boolean {
  if (target === 'text')
    return key !== 'Escape'
  return target === 'control' && (key === 'Enter' || key === ' ')
}

/** How far a finger moves, in CSS pixels, before a touch counts as a swipe rather than a tap. */
export const SWIPE_DISTANCE = 50

/**
 * What a tap or a swipe does on the slide. A swipe with a finger or a pen
 * to the left goes on and to the right goes back; a tap or a click on the
 * left third goes back and anywhere else goes on. Undefined for a drag that
 * is neither, and for any mouse drag, which selects text or turns a scene.
 */
export function pointerAction(start: { x: number, y: number }, end: { x: number, y: number }, width: number, pointerType: string): 'next' | 'previous' | undefined {
  const dx = end.x - start.x
  const dy = end.y - start.y
  const swipes = pointerType === 'touch' || pointerType === 'pen'
  if (swipes && Math.abs(dx) >= SWIPE_DISTANCE && Math.abs(dx) > Math.abs(dy))
    return dx < 0 ? 'next' : 'previous'
  if (Math.hypot(dx, dy) >= SWIPE_DISTANCE / 2)
    return undefined
  return end.x < width / 3 ? 'previous' : 'next'
}

export interface AutoplayOptions {
  /** How long the step on screen stays, in milliseconds. */
  dwellMs: () => number
  /** Moves on one step. Returns false at the end, which stops autoplay. */
  advance: () => boolean
  /** Autoplay started or stopped. */
  onChange?: (running: boolean) => void
}

/**
 * Plays a talk by itself: each step stays for its dwell time, then the next
 * one comes. Moving by hand starts the wait again from that step.
 */
export class Autoplay {
  private timer: ReturnType<typeof setTimeout> | undefined
  private on = false

  constructor(private readonly options: AutoplayOptions) {}

  get running() {
    return this.on
  }

  start() {
    if (this.on)
      return
    this.on = true
    this.options.onChange?.(true)
    this.schedule()
  }

  stop() {
    if (!this.on)
      return
    this.on = false
    clearTimeout(this.timer)
    this.timer = undefined
    this.options.onChange?.(false)
  }

  toggle() {
    if (this.on)
      this.stop()
    else
      this.start()
  }

  /** The step on screen changed: it gets its whole dwell time from now. */
  restart() {
    if (this.on)
      this.schedule()
  }

  private schedule() {
    clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      this.timer = undefined
      if (!this.on)
        return
      if (this.options.advance())
        this.schedule()
      else
        this.stop()
    }, Math.max(this.options.dwellMs(), 0))
  }
}
