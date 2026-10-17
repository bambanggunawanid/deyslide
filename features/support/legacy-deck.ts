import type { Deck } from '../../packages/deck-model/src'
import * as Y from 'yjs'

/**
 * A live document the way decks were stored before settings were split:
 * each slide's frontmatter and each block's props as one plain value.
 */
export function legacyDoc(deck: Deck): Y.Doc {
  const doc = new Y.Doc()
  doc.transact(() => {
    const root = doc.getMap<unknown>('deck')
    root.set('version', deck.version)
    const slides = new Y.Array<Y.Map<unknown>>()
    slides.push(deck.slides.map((slide) => {
      const map = new Y.Map<unknown>()
      map.set('id', slide.id)
      map.set('frontmatter', slide.frontmatter)
      map.set('notes', new Y.Text(slide.notes ?? ''))
      const elements = new Y.Array<Y.Map<unknown>>()
      elements.push(slide.elements.map((element) => {
        const item = new Y.Map<unknown>()
        for (const [key, value] of Object.entries(element)) {
          if (key === 'pos') {
            const pos = new Y.Map<unknown>()
            for (const [field, number] of Object.entries(value as object))
              pos.set(field, number)
            item.set(key, pos)
          }
          else {
            item.set(key, key === 'markdown' ? new Y.Text(value as string) : value)
          }
        }
        return item
      }))
      map.set('elements', elements)
      return map
    }))
    root.set('slides', slides)
  })
  return doc
}
