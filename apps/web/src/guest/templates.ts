import type { Deck } from '@deyslide/deck-model'

export type DeckTemplate = 'blank' | 'demo'

export const TEMPLATES: { id: DeckTemplate, label: string, description: string }[] = [
  { id: 'blank', label: 'Blank', description: 'One title slide to start from.' },
  { id: 'demo', label: 'Demo deck', description: 'The Deyslide demo: 3D zoom, code morphing, an algorithm animation and a live sandbox.' },
]

export function blankDeck(title: string): Deck {
  return {
    version: 1,
    slides: [{
      id: 'slide-1',
      frontmatter: { theme: 'default', title, layout: 'cover' },
      elements: [{
        id: 'title',
        type: 'text',
        pos: { x: 80, y: 200, w: 820, h: null, rotate: 0 },
        markdown: `# ${title}`,
      }],
    }],
  }
}

/**
 * The demo template needs the Markdown parser, so it loads on first use and
 * the home page stays small.
 */
export async function deckFromTemplate(template: DeckTemplate, title: string): Promise<Deck> {
  if (template === 'demo')
    return (await import('./demo-template')).demoDeck()
  return blankDeck(title)
}
