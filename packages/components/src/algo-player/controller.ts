/**
 * The parts of the `<motion-canvas-player>` element that Deyslide drives.
 * `setPlaying`, `state` and `player` are runtime members of the element
 * class in `@motion-canvas/player`; they are not in its published typings.
 */
export interface MotionCanvasPlayerElement extends HTMLElement {
  state?: 'initial' | 'loading' | 'ready' | 'error'
  playing?: boolean
  setPlaying?: (value: boolean) => void
  player?: {
    toggleLoop: (value?: boolean) => void
    requestReset: () => void
  } | null
}

export type PlayerStatus = 'loading' | 'ready' | 'error'

export interface PlayerController {
  status: () => PlayerStatus
  play: () => boolean
  pause: () => boolean
  toggle: () => boolean
  setLoop: (loop: boolean) => boolean
  restart: () => boolean
}

export function readStatus(element: MotionCanvasPlayerElement | null | undefined): PlayerStatus {
  if (!element)
    return 'loading'
  if (element.state === 'error')
    return 'error'
  if (element.state === 'ready' && element.player)
    return 'ready'
  return 'loading'
}

/**
 * Wraps the element so the Vue component never touches its internals
 * directly. Every command returns false when the player is not ready,
 * so callers can retry after the `ready` status arrives.
 */
export function createPlayerController(getElement: () => MotionCanvasPlayerElement | null | undefined): PlayerController {
  function ready() {
    const element = getElement()
    return readStatus(element) === 'ready' ? element! : undefined
  }

  function setPlaying(value: boolean) {
    const element = ready()
    if (!element?.setPlaying)
      return false
    element.setPlaying(value)
    return true
  }

  return {
    status: () => readStatus(getElement()),
    play: () => setPlaying(true),
    pause: () => setPlaying(false),
    toggle() {
      const element = ready()
      return element ? setPlaying(!element.playing) : false
    },
    setLoop(loop) {
      const element = ready()
      if (!element?.player)
        return false
      element.player.toggleLoop(loop)
      return true
    },
    restart() {
      const element = ready()
      if (!element?.player)
        return false
      element.player.requestReset()
      return true
    },
  }
}

/**
 * Turns the `src` prop into the absolute URL the player imports.
 *
 * - A root path like `/animations/x.js` is placed under the deck base, so a
 *   deck built with `--base /talks/` loads `/talks/animations/x.js`.
 * - The result is always absolute. In dev, Vite rewrites relative dynamic
 *   imports with an `?import` query, and files in `public/` refuse that query.
 */
export function resolvePlayerSrc(src: string, base: string, pageUrl: string): string {
  if (/^[a-z][a-z\d+.-]*:/i.test(src))
    return src
  if (src.startsWith('/')) {
    const prefix = base.endsWith('/') ? base.slice(0, -1) : base
    return new URL(`${prefix}${src}`, pageUrl).href
  }
  return new URL(src, pageUrl).href
}
