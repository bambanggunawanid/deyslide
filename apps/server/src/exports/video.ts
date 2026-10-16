/** The longest video. */
export const MAX_VIDEO_MS = 10 * 60_000
export const DEFAULT_DWELL_MS = 3000
/** How long a step may stay on screen, as the request's `dwellMs` sets it. */
export const MIN_DWELL_MS = 500
export const MAX_DWELL_MS = 60_000
/** Time a video gives each slide to settle when it comes in, before its first step's dwell. */
export const SETTLE_MS = 600
/** Time a video allows for drawing each step, on top of the step's dwell. */
export const STEP_ALLOWANCE_MS = 200

export const VIDEO_TOO_LONG = `The video would be longer than ${MAX_VIDEO_MS / 60_000} minutes. Show each slide for less time, or export fewer slides.`

/**
 * How long a slide's steps stay on screen in a video: its `videoDwell`
 * seconds, else the default. The same rule as `pnpm export:video`, kept
 * from half a second up to the longest video.
 */
export function videoDwellMs(frontmatter: Record<string, unknown>, dwellMs: number) {
  const seconds = frontmatter.videoDwell
  if (typeof seconds === 'number' && Number.isFinite(seconds) && seconds > 0)
    return Math.min(Math.max(Math.round(seconds * 1000), MIN_DWELL_MS), MAX_VIDEO_MS)
  return dwellMs
}

/**
 * How long a video runs: each slide settles once when it comes in, then
 * shows each of its steps for its dwell time plus the time to draw it. The
 * renderer measures with the same rule (videoLength in apps/renderer) once
 * it knows every slide's click steps. Before that, the API counts one step
 * per slide, which is exact without click steps and a lower bound with them.
 */
export function videoLength(slides: { dwellMs: number, steps: number }[]) {
  return slides.reduce((sum, slide) => sum + SETTLE_MS + slide.steps * (slide.dwellMs + STEP_ALLOWANCE_MS), 0)
}
