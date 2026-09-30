/** A file type people may upload, with how to recognize its first bytes. */
interface MediaKind {
  /** For messages, with its article, such as "a PNG image". */
  label: string
  matches: (head: Uint8Array) => boolean
}

const ascii = (head: Uint8Array, offset: number, text: string) =>
  [...text].every((char, index) => head[offset + index] === char.charCodeAt(0))
const bytes = (head: Uint8Array, offset: number, values: number[]) =>
  values.every((value, index) => head[offset + index] === value)
/** ISO media files (MP4, MOV, M4A, AVIF) name their brand after "ftyp" at byte 4. */
const isoBrand = (head: Uint8Array, brands: string[]) =>
  ascii(head, 4, 'ftyp') && brands.some(brand => ascii(head, 8, brand))

/**
 * The types Deyslide keeps: images, video and audio a slide can show.
 * SVG is left out, since it can carry scripts. Every upload's first bytes
 * must match its type, so a renamed file of another kind is not kept.
 */
export const MEDIA_KINDS: Record<string, MediaKind> = {
  'image/png': { label: 'a PNG image', matches: head => bytes(head, 0, [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]) },
  'image/jpeg': { label: 'a JPEG image', matches: head => bytes(head, 0, [0xFF, 0xD8, 0xFF]) },
  'image/gif': { label: 'a GIF image', matches: head => ascii(head, 0, 'GIF87a') || ascii(head, 0, 'GIF89a') },
  'image/webp': { label: 'a WebP image', matches: head => ascii(head, 0, 'RIFF') && ascii(head, 8, 'WEBP') },
  'image/avif': { label: 'an AVIF image', matches: head => isoBrand(head, ['avif', 'avis']) },
  'video/mp4': { label: 'an MP4 video', matches: head => ascii(head, 4, 'ftyp') && !isoBrand(head, ['avif', 'avis', 'qt  ']) },
  'video/webm': { label: 'a WebM video', matches: head => bytes(head, 0, [0x1A, 0x45, 0xDF, 0xA3]) },
  'video/quicktime': { label: 'a MOV video', matches: head => isoBrand(head, ['qt  ']) || ascii(head, 4, 'moov') || ascii(head, 4, 'mdat') || ascii(head, 4, 'wide') },
  'audio/mpeg': { label: 'an MP3 audio file', matches: head => ascii(head, 0, 'ID3') || (head[0] === 0xFF && ((head[1] ?? 0) & 0xE0) === 0xE0) },
  'audio/mp4': { label: 'an M4A audio file', matches: head => isoBrand(head, ['M4A ', 'M4B ', 'mp42', 'isom']) },
  'audio/ogg': { label: 'an OGG audio file', matches: head => ascii(head, 0, 'OggS') },
  'audio/wav': { label: 'a WAV audio file', matches: head => ascii(head, 0, 'RIFF') && ascii(head, 8, 'WAVE') },
}

/** How many first bytes the checks read. */
export const HEAD_BYTES = 16

export const ACCEPTED_TYPES_MESSAGE = 'Upload an image, a video or an audio file: PNG, JPEG, GIF, WebP, AVIF, MP4, WebM, MOV, MP3, M4A, OGG or WAV.'

export function isMediaType(type: string): boolean {
  return Object.hasOwn(MEDIA_KINDS, type)
}
