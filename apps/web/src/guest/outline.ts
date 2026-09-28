import type { Deck, DeckElement } from '@deyslide/deck-model'

const HEADING = /^#{1,6}\s+(.+)$/m

const TYPE_LABELS: Record<DeckElement['type'], string> = {
  'text': 'text',
  'image': 'image',
  'shape': 'shape',
  'code': 'code',
  'scene3d': '3D scene',
  'algo-player': 'animation',
  'sandbox': 'sandbox',
  'raw': 'Markdown',
}

export interface SlideOutline {
  number: number
  title: string
  summary: string
  hasNotes: boolean
}

function slideTitle(frontmatter: Record<string, unknown>, elements: DeckElement[], number: number) {
  for (const element of elements) {
    if (element.type !== 'text' && element.type !== 'raw')
      continue
    const heading = element.markdown.match(HEADING)?.[1]
    if (heading)
      return heading.replace(/<[^>]+>/g, '').trim()
  }
  if (number === 1 && typeof frontmatter.title === 'string')
    return frontmatter.title
  return `Slide ${number}`
}

/** A short, readable list of what each slide holds, until the editor exists. */
export function deckOutline(deck: Deck): SlideOutline[] {
  return deck.slides.map((slide, index) => {
    const counts = new Map<string, number>()
    for (const element of slide.elements) {
      const label = TYPE_LABELS[element.type]
      counts.set(label, (counts.get(label) ?? 0) + 1)
    }
    const summary = [...counts].map(([label, count]) => `${count} ${label}`).join(', ') || 'Empty'
    return {
      number: index + 1,
      title: slideTitle(slide.frontmatter, slide.elements, index + 1),
      summary,
      hasNotes: Boolean(slide.notes),
    }
  })
}
