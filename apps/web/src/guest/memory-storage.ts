import type { GuestIndex, GuestStorage, OpenDeck } from './types'
import * as Y from 'yjs'

/** Keeps everything in memory. Used in tests and as a fallback without IndexedDB. */
export class MemoryGuestStorage implements GuestStorage {
  private index: GuestIndex | undefined
  private readonly decks = new Map<string, Uint8Array>()

  async loadIndex() {
    return this.index && structuredClone(this.index)
  }

  async saveIndex(index: GuestIndex) {
    this.index = structuredClone(index)
  }

  async openDeck(deckId: string): Promise<OpenDeck> {
    const doc = new Y.Doc()
    const stored = this.decks.get(deckId)
    if (stored)
      Y.applyUpdate(doc, stored)
    const store = () => {
      this.decks.set(deckId, Y.encodeStateAsUpdate(doc))
    }
    // Every change is kept at once, like y-indexeddb does.
    doc.on('update', store)
    const flush = async () => store()
    return {
      doc,
      flush,
      close: async () => {
        doc.off('update', store)
        store()
        doc.destroy()
      },
    }
  }

  async deleteDeck(deckId: string) {
    this.decks.delete(deckId)
  }
}
