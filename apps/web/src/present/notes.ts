import MarkdownIt from 'markdown-it'

/** A part of a slide's speaker notes, and the click it belongs to. */
export interface NotePart {
  clicks: number
  /** The part as HTML, from Markdown with raw HTML turned off. */
  html: string
}

// Raw HTML stays text, so notes cannot run anything.
const markdown = new MarkdownIt({ html: false, linkify: true, breaks: true })
const renderLink = markdown.renderer.rules.link_open ?? ((tokens, index, options, _env, self) => self.renderToken(tokens, index, options))
// A link opens beside the presenter view, never in its place.
markdown.renderer.rules.link_open = (tokens, index, options, env, self) => {
  tokens[index].attrSet('target', '_blank')
  tokens[index].attrSet('rel', 'noopener noreferrer')
  return renderLink(tokens, index, options, env, self)
}

/**
 * Splits speaker notes at Slidev's click markers, as Slidev does: `[click]`
 * starts the part for the next click, and `[click:3]` the part three clicks
 * on. Text before the first marker belongs to click 0. Empty parts are left out.
 */
export function noteParts(notes: string): NotePart[] {
  const parts: NotePart[] = []
  let clicks = 0
  let start = 0
  const add = (text: string) => {
    if (text.trim())
      parts.push({ clicks, html: markdown.render(text.trim()) })
  }
  for (const marker of notes.matchAll(/\[click(?::(\d+))?\]/gi)) {
    add(notes.slice(start, marker.index))
    clicks += Number(marker[1] ?? 1)
    start = marker.index + marker[0].length
  }
  add(notes.slice(start))
  return parts
}

/** The part to point out at a click: the last one that click has reached, or none before the first. */
export function currentPart(parts: readonly NotePart[], clicks: number): NotePart | undefined {
  return parts.findLast(part => part.clicks <= clicks)
}
