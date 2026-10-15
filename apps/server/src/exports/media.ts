import type { MediaStore } from '../media/store.ts'
import { mediaAddress } from '../media/store.ts'

/** One slide of the deck being exported, as Slidev splits it. */
export interface ExportSlide {
  content: string
  frontmatter: Record<string, unknown>
}

/** Media files one export may carry inside its slides. */
export const MAX_INLINE_MEDIA_BYTES = 20 * 1024 * 1024

/** A file from a project's media library, as slides link to it. */
const MEDIA_LINK = /\/api\/media\/([\w-]{1,100})\/file/g

/** Something about the deck stops the export. The message says what to change. */
export class ExportError extends Error {}

/**
 * The project media the slides use, each link mapped to a `data:` URL with
 * the file inside. The renderer has no network, so this is how slides show
 * them. Files the person may not open are left out, as in the editor.
 */
export async function inlineMedia(media: MediaStore | undefined, userId: string, slides: ExportSlide[]): Promise<Record<string, string>> {
  if (!media)
    return {}
  const ids = new Set(slides.flatMap(slide => [...textOf(slide).matchAll(MEDIA_LINK)].map(match => match[1])))
  const links: Record<string, string> = {}
  let total = 0
  for (const id of ids) {
    const file = await media.contents(userId, id)
    if (!file)
      continue
    total += file.size
    if (total > MAX_INLINE_MEDIA_BYTES)
      throw new ExportError(`The slides use more than ${MAX_INLINE_MEDIA_BYTES / 1024 / 1024} MB of media, which is more than an export can hold. Use smaller files.`)
    links[mediaAddress(id)] = `data:${file.type};base64,${Buffer.from(await file.read()).toString('base64')}`
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
