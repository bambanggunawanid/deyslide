import type { MediaStore } from '../media/store.ts'
import { mediaAddress } from '../media/store.ts'

/** One slide of the deck being exported, as Slidev splits it. */
export interface ExportSlide {
  content: string
  frontmatter: Record<string, unknown>
}

/** Media files one export, or one call for Claude Code's slide images, may carry inside its slides. */
export const MAX_INLINE_MEDIA_BYTES = 20 * 1024 * 1024

/** A file from a project's media library, as slides link to it. */
const MEDIA_LINK = /\/api\/media\/([\w-]{1,100})\/file/g

/** Something about the deck stops the export. The message says what to change. */
export class ExportError extends Error {}

/** A project file the slides link to, which the person may open. */
export interface LinkedMedia {
  /** The link in the slides: `/api/media/<id>/file`. */
  link: string
  type: string
  size: number
  read: () => Promise<Uint8Array>
}

/**
 * The project files the slides link to, in the order they first appear.
 * Files the person may not open are left out, as in the editor.
 */
export async function linkedMedia(media: MediaStore | undefined, userId: string, slides: ExportSlide[]): Promise<LinkedMedia[]> {
  if (!media)
    return []
  const ids = new Set(slides.flatMap(slide => [...textOf(slide).matchAll(MEDIA_LINK)].map(match => match[1])))
  const files: LinkedMedia[] = []
  for (const id of ids) {
    const file = await media.contents(userId, id)
    if (file)
      files.push({ link: mediaAddress(id), ...file })
  }
  return files
}

/** The file as a `data:` URL. */
export function dataUrl(type: string, bytes: Uint8Array) {
  // A view of the same memory rather than a copy, since files can be large.
  return `data:${type};base64,${Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64')}`
}

/**
 * The project media the slides use, each link mapped to a `data:` URL with
 * the file inside. The renderer has no network, so this is how slides show
 * them. Files the person may not open are left out, as in the editor.
 */
export async function inlineMedia(media: MediaStore | undefined, userId: string, slides: ExportSlide[]): Promise<Record<string, string>> {
  const links: Record<string, string> = {}
  let total = 0
  for (const file of await linkedMedia(media, userId, slides)) {
    total += file.size
    if (total > MAX_INLINE_MEDIA_BYTES)
      throw new ExportError(`The slides use more than ${MAX_INLINE_MEDIA_BYTES / 1024 / 1024} MB of media, which is more than an export can hold. Use smaller files.`)
    links[file.link] = dataUrl(file.type, await file.read())
  }
  return links
}

/** Where a slide can link to media: its content, and its frontmatter for a layout's `image` or `background`. */
function textOf(slide: ExportSlide) {
  return `${slide.content}\n${JSON.stringify(slide.frontmatter)}`
}

/** The part of `links` that these slides use. */
export function mediaFor(slides: ExportSlide[], links: Record<string, string>): Record<string, string> {
  const texts = slides.map(textOf)
  return Object.fromEntries(Object.entries(links).filter(([link]) => texts.some(text => text.includes(link))))
}
