import type { Account } from '../account/types'
import type { OfflineStorage, OpenCopy, PersonRecord } from './offline-cache'
import { clearDocument, IndexeddbPersistence } from 'y-indexeddb'
import * as Y from 'yjs'
import { copyPrefix } from './offline-cache'

const DB = 'deyslide-account'
const PEOPLE = 'people'
const META = 'meta'
const ACCOUNT_KEY = 'account'

function request<T>(req: IDBRequest<T>) {
  return new Promise<T>((resolve, reject) => {
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

function openDb() {
  const req = indexedDB.open(DB, 1)
  req.onupgradeneeded = () => {
    req.result.createObjectStore(PEOPLE)
    req.result.createObjectStore(META)
  }
  return request(req)
}

/** Runs one request in its own transaction and waits until the transaction is done. */
async function run<T>(store: string, mode: IDBTransactionMode, work: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openDb()
  try {
    const tx = db.transaction(store, mode)
    const result = request(work(tx.objectStore(store)))
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
      tx.onabort = () => reject(tx.error)
    })
    return await result
  }
  finally {
    db.close()
  }
}

/**
 * The browser's and the apps' webview storage. The records sit in one small
 * database; each deck copy is a Yjs document persisted by y-indexeddb in a
 * database of its own, named apart from the guest's decks.
 */
export class IndexedDbOfflineStorage implements OfflineStorage {
  async loadAccount() {
    return await run(META, 'readonly', store => store.get(ACCOUNT_KEY)) as Account | undefined
  }

  async saveAccount(account: Account | undefined) {
    if (account)
      await run(META, 'readwrite', store => store.put({ id: account.id, name: account.name, email: account.email }, ACCOUNT_KEY))
    else
      await run(META, 'readwrite', store => store.delete(ACCOUNT_KEY))
  }

  async loadPerson(userId: string) {
    return await run(PEOPLE, 'readonly', store => store.get(userId)) as PersonRecord | undefined
  }

  async savePerson(userId: string, record: PersonRecord) {
    await run(PEOPLE, 'readwrite', store => store.put(structuredClone(record), userId))
  }

  async deletePerson(userId: string) {
    await run(PEOPLE, 'readwrite', store => store.delete(userId))
  }

  openCopy(name: string, doc: Y.Doc): OpenCopy {
    const persistence = new IndexeddbPersistence(name, doc)
    let closed!: () => void
    const stopped = new Promise<void>(resolve => (closed = resolve))
    return {
      // A copy closed before it loaded never says it synced.
      loaded: Promise.race([persistence.whenSynced.then(() => {}), stopped]),
      origin: persistence,
      close: async () => {
        closed()
        await persistence.destroy()
      },
    }
  }

  async deleteCopies(names: string[], prefix?: string) {
    const all = new Set(names)
    // Copies the records lost track of, say when two tabs changed them at once.
    if (prefix && typeof indexedDB.databases === 'function') {
      for (const { name } of await indexedDB.databases().catch(() => [])) {
        if (name?.startsWith(prefix))
          all.add(name)
      }
    }
    await Promise.all([...all].map(name => clearDocument(name)))
  }
}

/** Keeps everything in memory: tests, and browsers without IndexedDB, where nothing outlasts the tab. */
export class MemoryOfflineStorage implements OfflineStorage {
  private account: Account | undefined
  private readonly people = new Map<string, PersonRecord>()
  readonly copies = new Map<string, Uint8Array>()

  async loadAccount() {
    return this.account && { ...this.account }
  }

  async saveAccount(account: Account | undefined) {
    this.account = account && { ...account }
  }

  async loadPerson(userId: string) {
    const record = this.people.get(userId)
    return record && structuredClone(record)
  }

  async savePerson(userId: string, record: PersonRecord) {
    this.people.set(userId, structuredClone(record))
  }

  async deletePerson(userId: string) {
    this.people.delete(userId)
  }

  /** Whether anything at all is kept for this person: a record or a deck copy. */
  keepsAnythingFor(userId: string) {
    return this.people.has(userId) || [...this.copies.keys()].some(name => name.startsWith(copyPrefix(userId)))
  }

  openCopy(name: string, doc: Y.Doc): OpenCopy {
    const origin = Symbol(name)
    const stored = this.copies.get(name)
    if (stored)
      Y.applyUpdate(doc, stored, origin)
    // Every change is kept at once, like y-indexeddb does.
    const store = () => {
      this.copies.set(name, Y.encodeStateAsUpdate(doc))
    }
    store()
    doc.on('update', store)
    return {
      loaded: Promise.resolve(),
      origin,
      close: async () => {
        doc.off('update', store)
      },
    }
  }

  async deleteCopies(names: string[], prefix?: string) {
    for (const name of [...this.copies.keys()]) {
      if (names.includes(name) || (prefix && name.startsWith(prefix)))
        this.copies.delete(name)
    }
  }
}
