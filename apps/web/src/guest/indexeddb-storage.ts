import type { GuestIndex, GuestStorage, OpenDeck } from './types'
import { IndexeddbPersistence, storeState } from 'y-indexeddb'
import * as Y from 'yjs'

const INDEX_DB = 'deyslide-guest'
const INDEX_STORE = 'meta'
const INDEX_KEY = 'index'
const DECK_DB_PREFIX = 'deyslide-deck-'

function request<T>(req: IDBRequest<T>) {
  return new Promise<T>((resolve, reject) => {
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

function openIndexDb() {
  const req = indexedDB.open(INDEX_DB, 1)
  req.onupgradeneeded = () => req.result.createObjectStore(INDEX_STORE)
  return request(req)
}

/**
 * The project index sits in its own small database. Each deck is a Yjs
 * document persisted by y-indexeddb, so it syncs to the server unchanged
 * once the guest signs up.
 */
export class IndexedDbGuestStorage implements GuestStorage {
  async loadIndex() {
    const db = await openIndexDb()
    try {
      const store = db.transaction(INDEX_STORE, 'readonly').objectStore(INDEX_STORE)
      return (await request(store.get(INDEX_KEY))) as GuestIndex | undefined
    }
    finally {
      db.close()
    }
  }

  async saveIndex(index: GuestIndex) {
    const db = await openIndexDb()
    try {
      const tx = db.transaction(INDEX_STORE, 'readwrite')
      tx.objectStore(INDEX_STORE).put(structuredClone(index), INDEX_KEY)
      await new Promise<void>((resolve, reject) => {
        tx.oncomplete = () => resolve()
        tx.onerror = () => reject(tx.error)
      })
    }
    finally {
      db.close()
    }
  }

  async openDeck(deckId: string): Promise<OpenDeck> {
    const doc = new Y.Doc()
    const persistence = new IndexeddbPersistence(DECK_DB_PREFIX + deckId, doc)
    await persistence.whenSynced
    const flush = () => storeState(persistence, true)
    return {
      doc,
      flush,
      close: async () => {
        await flush()
        await persistence.destroy()
        doc.destroy()
      },
    }
  }

  async deleteDeck(deckId: string) {
    const doc = new Y.Doc()
    const persistence = new IndexeddbPersistence(DECK_DB_PREFIX + deckId, doc)
    await persistence.whenSynced
    await persistence.clearData()
    doc.destroy()
  }
}
