import type * as Y from 'yjs'
import { deckSlideTexts, joinSlides, readDeckDoc, splitSlides } from '@deyslide/deck-model'

/** A slide as presenting shows it: what the preview draws, and the speaker's notes. */
export interface PresentSlide {
  id: string
  frontmatter: Record<string, unknown>
  /** Slidev Markdown without frontmatter and notes, as the preview takes it. */
  content: string
  notes: string
  /** Its first heading, else its first line of text. */
  title: string
}

/** The first heading of a slide's Markdown, else its first line of text, without Markdown and tags. */
export function slideTitle(content: string): string {
  const lines = content.split('\n').map(line => line.trim())
  const heading = lines.find(line => /^#{1,6}\s/.test(line))
  const line = heading ?? lines.find(line => line && !line.startsWith('<') && !line.startsWith('```') && !line.startsWith('::'))
  return (line ?? '')
    .replace(/^#{1,6}\s+/, '')
    .replace(/<[^>]*>/g, '')
    .replace(/[*_`~]/g, '')
    .trim()
}

/** Every slide of a live deck, read the way the editor's preview reads it. */
export function readPresentSlides(doc: Y.Doc): PresentSlide[] {
  const deck = readDeckDoc(doc)
  const texts = deckSlideTexts(deck, { ids: false })
  let split = splitSlides(joinSlides(texts))
  // Each slide's Markdown reads as exactly that slide, so read them one by one if the whole deck reads otherwise.
  if (split.length !== deck.slides.length)
    split = texts.map(text => splitSlides(text)[0])
  return deck.slides.map((slide, index) => {
    const content = split[index]?.content ?? ''
    return {
      id: slide.id,
      frontmatter: split[index]?.frontmatter ?? {},
      content,
      notes: slide.notes ?? '',
      title: slideTitle(content),
    }
  })
}
