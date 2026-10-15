import type { Position } from '@deyslide/deck-model'

/** Messages between the editor and the sandboxed preview frame. */

export interface PreviewSlide {
  content: string
  frontmatter: Record<string, unknown>
  first: boolean
}

export interface RenderRequest {
  type: 'deyslide:render'
  /**
   * Comes back on the `rendered` or `error` reply, so a caller can match
   * replies to its renders. A render with an id always gets exactly one of
   * them: one that a newer render overtakes before it shows gets an `error`
   * reading `REPLACED`.
   */
  id?: string
  slide: PreviewSlide
  /** The first slide's frontmatter, which holds deck settings such as `colorSchema` and `fonts`. */
  headmatter: Record<string, unknown>
  clicks: number
  /**
   * `edit` when left out. `print` tells components the slide is being
   * exported, and mounts the slide afresh at every click, so each step is
   * drawn in its final state rather than halfway through an animation.
   */
  mode?: 'edit' | 'present' | 'print'
  /**
   * Present mode only: the transition into this slide, reversed when `back`.
   * An empty name picks one the way Slidev does: moving forward plays the
   * `transition` of the slide on screen (the one being left), moving back
   * the one of this slide, and either falls back to the deck's. Send it only
   * when moving to another slide, so an edit to the slide on screen swaps it
   * in place.
   */
  transition?: { name: string, back: boolean }
  /** Media links the frame cannot load (`/api/media/<id>/file`), each mapped to one that loads without cookies. */
  media?: Record<string, string>
}

/** Places positioned elements by `data-id` without compiling the slide again, until the next render. */
export interface PositionsMessage {
  type: 'deyslide:positions'
  positions: Record<string, Position>
}

/** Asks the frame for a PNG of the slide it shows. */
export interface CaptureRequest {
  type: 'deyslide:capture'
  id: string
  /** The PNG is 1280 by 720 times this (1 when left out), whatever size the frame is shown at. */
  pixelRatio?: number
}

export type ToPreview = RenderRequest | PositionsMessage | CaptureRequest

/** The `error` reply to a render that a newer one overtook before it showed. */
export const REPLACED = 'A newer render replaced this one.'

export type FromPreview
  = | { type: 'deyslide:ready' }
    | { type: 'deyslide:rendered', id?: string, clicks: number }
    | { type: 'deyslide:error', id?: string, message: string }
    | { type: 'deyslide:captured', id: string, png?: ArrayBuffer, overflow: boolean, error?: string }

/** A captured slide: the PNG, whether anything spills past the slide's edges, and the error it shows, if any. */
export interface CapturedSlide {
  png?: ArrayBuffer
  overflow: boolean
  error?: string
}
