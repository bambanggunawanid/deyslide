import type { ExportSlide, LinkedMedia } from '../exports/media.ts'
import type { MediaStore } from '../media/store.ts'
import { dataUrl, linkedMedia, MAX_INLINE_MEDIA_BYTES } from '../exports/media.ts'

/** Why a file the slides use is not in their images. */
export type LeftOutReason = 'too-big' | 'no-room' | 'unreadable'

export interface LeftOut {
  /** The link in the slides: `/api/media/<id>/file`. */
  link: string
  why: LeftOutReason
}

/**
 * Calls that carry media to the renderer at the same time. The renderer
 * draws one request after another, so more would only wait there, each
 * holding its files.
 */
export const MEDIA_CALLS_AT_ONCE = 2
/** Calls that may wait for their turn. Further calls are told to try again. */
export const MEDIA_CALLS_WAITING = 4

/** Too many calls with media are under way. Asking again in a moment works. */
export class MediaBusyError extends Error {}

/** A still image shows a whole picture but one frame of a video, and nothing of a sound. */
const SHOWN_FIRST = ['image/', 'video/']

/**
 * The files to draw with: pictures first, then videos, smaller ones first,
 * while they fit in MAX_INLINE_MEDIA_BYTES. The rest are left out, each
 * with its reason. Audio is left out without a word: an image cannot show it.
 */
function pick(files: LinkedMedia[]): { files: LinkedMedia[], left: LeftOut[] } {
  const ranked = files
    .map(file => ({ file, rank: SHOWN_FIRST.findIndex(kind => file.type.startsWith(kind)) }))
    .filter(({ rank }) => rank >= 0)
    .sort((a, b) => a.rank - b.rank || a.file.size - b.file.size)
  const picked: LinkedMedia[] = []
  const left: LeftOut[] = []
  let room = MAX_INLINE_MEDIA_BYTES
  for (const { file } of ranked) {
    if (file.size <= room) {
      picked.push(file)
      room -= file.size
    }
    else {
      left.push({ link: file.link, why: file.size > MAX_INLINE_MEDIA_BYTES ? 'too-big' : 'no-room' })
    }
  }
  return { files: picked, left }
}

/**
 * Project media for Claude Code's slide images. The renderer has no
 * network, so the files the slides use go inside the request as `data:`
 * URLs, as in exports, and only files the person may open. Unlike an
 * export, the slides are always drawn: a file that does not fit in
 * MAX_INLINE_MEDIA_BYTES, or that storage cannot read, is left out and
 * named, so Claude knows the slide itself is not at fault.
 *
 * Until the renderer answers, a call holds its files several times over
 * (the bytes, their base64 text, the request body), so a few calls carry
 * media at a time and the others wait their turn.
 */
export class SlideMedia {
  private readonly media: MediaStore
  private running = 0
  private readonly waiting: (() => void)[] = []

  constructor(media: MediaStore) {
    this.media = media
  }

  /**
   * Calls `draw` with the media links the slides use mapped to `data:`
   * URLs (none when they use no files), and returns what it drew and the
   * files left out. Throws `MediaBusyError` when too many calls wait.
   */
  async draw<T>(userId: string, slides: ExportSlide[], draw: (links: Record<string, string>) => Promise<T>): Promise<{ drawn: T, left: LeftOut[] }> {
    const { files, left } = pick(await linkedMedia(this.media, userId, slides))
    if (!files.length)
      return { drawn: await draw({}), left }
    await this.turn()
    try {
      const links: Record<string, string> = {}
      for (const file of files) {
        try {
          links[file.link] = dataUrl(file.type, await file.read())
        }
        catch (error) {
          console.error(`Could not read ${file.link} for slide images:`, error)
          left.push({ link: file.link, why: 'unreadable' })
        }
      }
      return { drawn: await draw(links), left }
    }
    finally {
      this.next()
    }
  }

  private async turn() {
    if (this.running < MEDIA_CALLS_AT_ONCE) {
      this.running++
      return
    }
    if (this.waiting.length >= MEDIA_CALLS_WAITING)
      throw new MediaBusyError('Slide images are busy right now. Try again in a minute.')
    await new Promise<void>(resolve => this.waiting.push(resolve))
  }

  /** Hands the finished call's turn to the next one in line. */
  private next() {
    const waiting = this.waiting.shift()
    if (waiting)
      waiting()
    else
      this.running--
  }
}
