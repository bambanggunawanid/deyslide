/**
 * Pure helpers for `pnpm export:video`. Kept apart from the recorder so the
 * option rules can be tested without starting a browser.
 */

export interface VideoOptions {
  output: string
  width: number
  height: number
  /** Default time each click step stays on screen, in milliseconds. */
  dwellMs: number
  port: number
  executablePath?: string
}

export const DEFAULT_VIDEO_OPTIONS: VideoOptions = {
  output: 'exports/deyslide.webm',
  width: 1920,
  height: 1080,
  dwellMs: 3000,
  port: 3931,
}

export class VideoOptionError extends Error {}

const NUMBER_FLAGS = {
  '--width': 'width',
  '--height': 'height',
  '--dwell': 'dwellMs',
  '--port': 'port',
} as const

const STRING_FLAGS = {
  '--output': 'output',
  '--executable-path': 'executablePath',
} as const

function positiveInteger(flag: string, raw: string | undefined): number {
  const value = Number(raw)
  if (!raw || !Number.isInteger(value) || value <= 0)
    throw new VideoOptionError(`${flag} needs a positive whole number, got "${raw ?? ''}"`)
  return value
}

export function parseVideoArgs(argv: readonly string[]): VideoOptions {
  const options: VideoOptions = { ...DEFAULT_VIDEO_OPTIONS }

  for (let i = 0; i < argv.length; i++) {
    const [flag, inline] = argv[i].split('=', 2)
    const next = () => inline ?? argv[++i]

    if (flag in NUMBER_FLAGS) {
      const key = NUMBER_FLAGS[flag as keyof typeof NUMBER_FLAGS]
      options[key] = positiveInteger(flag, next())
    }
    else if (flag in STRING_FLAGS) {
      const key = STRING_FLAGS[flag as keyof typeof STRING_FLAGS]
      const value = next()
      if (!value)
        throw new VideoOptionError(`${flag} needs a value`)
      options[key] = value
    }
    else {
      throw new VideoOptionError(`Unknown option "${argv[i]}"`)
    }
  }

  if (!options.output.endsWith('.webm'))
    throw new VideoOptionError('--output must end with .webm')
  return options
}

/**
 * A slide can ask for more screen time with `videoDwell: <seconds>` in its
 * frontmatter, for example a slide that plays a full Motion Canvas animation.
 */
export function dwellFor(frontmatter: Record<string, unknown> | undefined, defaultMs: number): number {
  const seconds = frontmatter?.videoDwell
  if (typeof seconds === 'number' && Number.isFinite(seconds) && seconds > 0)
    return Math.round(seconds * 1000)
  return defaultMs
}
