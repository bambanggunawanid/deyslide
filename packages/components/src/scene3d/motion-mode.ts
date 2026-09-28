/**
 * How the camera should behave for one rendered copy of a slide.
 * - animate: ease toward the target pose (the slide the audience sees)
 * - hold: freeze where it is (a preloaded slide waiting off screen)
 * - snap: jump to the final pose (PDF export, overview grid, next slide preview)
 */
export type MotionMode = 'animate' | 'hold' | 'snap'

export interface MotionModeInput {
  renderContext: string
  isPrintMode: boolean
  isSlideActive: boolean
}

const LIVE_CONTEXTS = new Set(['slide', 'presenter'])

export function resolveMotionMode({ renderContext, isPrintMode, isSlideActive }: MotionModeInput): MotionMode {
  if (isPrintMode || !LIVE_CONTEXTS.has(renderContext))
    return 'snap'
  return isSlideActive ? 'animate' : 'hold'
}
