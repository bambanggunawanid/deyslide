import type * as Y from 'yjs'
import type { Account } from '../account/types'
import type { Project } from '../guest/types'
import { holdsDeck } from '../deck/session'

// Account decks kept on this device, so they open and change without a
// connection. Each deck's live document is kept as it changes, apart from
// the guest's browser decks, and so are the project lists last read from
// the server. Signing out deletes all of it.
//
// A copy is only ever started from a document that already holds the deck,
// so it shares the deck's history with the server: changes made offline
// merge with everyone else's. An empty document must never be changed
// before its first sync (see `holdsDeck`), and a deck with no copy keeps
// waiting for that sync.

/** The account's projects and the ones shared with it, as last read from the server. */
export interface ProjectLists {
  projects: Project[]
  shared: Project[]
}

/** What the device keeps for one person, apart from the deck copies themselves. */
export interface PersonRecord {
  lists?: ProjectLists
  /** Decks with a copy on this device. */
  decks: string[]
  /** Decks whose copy holds changes the server does not have yet. */
  pending: string[]
}

/** A deck's copy, open in a document: every change to the document is kept. */
export interface OpenCopy {
  /** Resolves once what the copy holds is in the document. */
  loaded: Promise<void>
  /**
   * Resolves true once the copy is written to storage that outlasts the
   * page, and false when it is not (no IndexedDB, say, or closed first).
   */
  stored: Promise<boolean>
  /** The origin of the changes the copy brings into the document. */
  readonly origin: unknown
  /** Stops keeping the document's changes. The copy stays. */
  close: () => Promise<void>
}

/** Where the copies and records live: IndexedDB in browsers and the apps, memory in tests. */
export interface OfflineStorage {
  /** Whether what it keeps outlasts the page. Memory storage does not. */
  readonly durable: boolean
  loadAccount: () => Promise<Account | undefined>
  saveAccount: (account: Account | undefined) => Promise<void>
  loadPerson: (userId: string) => Promise<PersonRecord | undefined>
  savePerson: (userId: string, record: PersonRecord) => Promise<void>
  deletePerson: (userId: string) => Promise<void>
  openCopy: (name: string, doc: Y.Doc) => OpenCopy
  /** Deletes these copies, and, with a prefix, any other copy whose name starts with it. */
  deleteCopies: (names: string[], prefix?: string) => Promise<void>
}

/** A deck's copy as the store sees it. */
export interface DeckCopy {
  /** Resolves once the copy's content is in the document, at once for a deck the device has no copy of. */
  loaded: Promise<void>
  /** True when the copy holds the deck: it can be read and changed before any sync. */
  readonly holdsDeck: boolean
  /**
   * Resolves true once the copy is written where it outlasts the page, so
   * closing the page loses nothing. False when it never is: no lasting
   * storage, storage that failed, or the copy closed first.
   */
  stored: Promise<boolean>
  /** The origin of the changes the copy brings into the document. */
  readonly origin: unknown
  /** Stops following the document. The copy stays on the device. */
  close: () => Promise<void>
}

/** The prefix of every deck copy's name for one person, apart from the guest decks' `deyslide-deck-`. */
export const copyPrefix = (userId: string) => `deyslide-account-${userId}-`

/** The name of a deck's copy: its own IndexedDB database. */
export const copyName = (userId: string, deckId: string) => `${copyPrefix(userId)}${deckId}`

/** How long deleting copies waits for another tab that still has one open. */
const DELETE_WAIT_MS = 2000

const emptyRecord = (): PersonRecord => ({ decks: [], pending: [] })

/** Waits for `promise`, or `ms` at most. */
function atMost(promise: Promise<unknown>, ms: number) {
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, ms)
  })
  return Promise.race([promise.then(() => {}), late]).finally(() => clearTimeout(timer))
}

/**
 * Account decks and project lists kept on this device. Every method keeps
 * the page working when storage fails (a full disk, a private window): a
 * failed read answers nothing kept, and a failed write is dropped.
 */
export class OfflineCache {
  /** Changes to the records, one at a time, so none overwrites another. */
  private queue: Promise<unknown> = Promise.resolve()
  private readonly storage: OfflineStorage

  constructor(storage: OfflineStorage) {
    this.storage = storage
  }

  /** Whether copies outlast the page. */
  get durable() {
    return this.storage.durable
  }

  /** The person signed in last on this device, so their projects show while the server is out of reach. */
  async lastAccount(): Promise<Account | undefined> {
    return this.storage.loadAccount().catch(() => undefined)
  }

  async rememberAccount(account: Account) {
    await this.storage.saveAccount(account).catch(() => {})
  }

  /**
   * Forgets the person signed in last, once the server said nobody is: the
   * next offline start shows no account. Their copies stay for their next
   * sign in.
   */
  async forgetLastAccount() {
    await this.storage.saveAccount(undefined).catch(() => {})
  }

  async lists(userId: string): Promise<ProjectLists | undefined> {
    return (await this.record(userId))?.lists
  }

  async saveLists(userId: string, lists: ProjectLists) {
    await this.change(userId, record => ({ ...record, lists: structuredClone(lists) }))
  }

  /** Ids of the decks with a copy on this device. */
  async decks(userId: string): Promise<string[]> {
    return (await this.record(userId))?.decks ?? []
  }

  /** Decks whose copy holds changes the server does not have yet. */
  async pending(userId: string): Promise<string[]> {
    return (await this.record(userId))?.pending ?? []
  }

  async markPending(userId: string, deckId: string, pending: boolean) {
    await this.change(userId, record => ({
      ...record,
      pending: pending
        ? [...new Set([...record.pending, deckId])]
        : record.pending.filter(id => id !== deckId),
    }))
  }

  /**
   * Keeps a copy of the deck's live document on this device. A copy the
   * device has already is loaded into `doc` first. Without one, the copy
   * starts once `doc` holds the deck, which only a sync with the server
   * brings, so a copy never starts from an empty document.
   */
  followDeck(userId: string, deckId: string, doc: Y.Doc): DeckCopy {
    const name = copyName(userId, deckId)
    let open: OpenCopy | undefined
    let closed = false
    let holds = false
    let settle!: (stored: boolean) => void
    const stored = new Promise<boolean>(resolve => (settle = resolve))
    const follow = (copy: OpenCopy) => {
      open = copy
      copy.stored.then(settle, () => settle(false))
    }
    const startWhenItHoldsDeck = () => {
      if (closed || open || !holdsDeck(doc))
        return
      doc.off('update', startWhenItHoldsDeck)
      follow(this.storage.openCopy(name, doc))
      void this.change(userId, record => ({ ...record, decks: [...new Set([...record.decks, deckId])] }))
    }
    const loaded = this.decks(userId).then(async (decks) => {
      if (closed)
        return
      if (decks.includes(deckId)) {
        follow(this.storage.openCopy(name, doc))
        await open!.loaded.catch(() => {})
        holds = holdsDeck(doc)
        return
      }
      doc.on('update', startWhenItHoldsDeck)
      startWhenItHoldsDeck()
    })
    return {
      loaded,
      stored,
      get holdsDeck() {
        return holds
      },
      get origin() {
        return open?.origin
      },
      close: async () => {
        closed = true
        doc.off('update', startWhenItHoldsDeck)
        if (!open)
          settle(false)
        await open?.close().catch(() => {})
      },
    }
  }

  /** Deletes a deck's copy. Close the copy first. */
  async deleteDeck(userId: string, deckId: string) {
    await this.change(userId, record => ({
      ...record,
      decks: record.decks.filter(id => id !== deckId),
      pending: record.pending.filter(id => id !== deckId),
    }))
    await atMost(this.storage.deleteCopies([copyName(userId, deckId)]).catch(() => {}), DELETE_WAIT_MS)
  }

  /** Deletes every deck copy and list kept for this person, and forgets them as the last account. Close their copies first. */
  async forget(userId: string) {
    const decks = await this.decks(userId)
    await this.enqueue(() => this.storage.deletePerson(userId))
    if ((await this.lastAccount())?.id === userId)
      await this.storage.saveAccount(undefined).catch(() => {})
    await atMost(this.storage.deleteCopies(decks.map(deckId => copyName(userId, deckId)), copyPrefix(userId)).catch(() => {}), DELETE_WAIT_MS)
  }

  private async record(userId: string) {
    await this.queue.catch(() => {})
    return this.storage.loadPerson(userId).catch(() => undefined)
  }

  private enqueue(work: () => Promise<unknown>) {
    const next = this.queue.catch(() => {}).then(work)
    this.queue = next
    return next.then(() => {}, () => {})
  }

  private change(userId: string, update: (record: PersonRecord) => PersonRecord) {
    return this.enqueue(async () => {
      const record = (await this.storage.loadPerson(userId)) ?? emptyRecord()
      await this.storage.savePerson(userId, update(record))
    })
  }
}
