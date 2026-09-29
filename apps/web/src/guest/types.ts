import type * as Y from 'yjs'

/** What someone may do with a project or deck: owners do everything, editors add and change, viewers look. */
export type Role = 'owner' | 'editor' | 'viewer'
export type SharedRole = Exclude<Role, 'owner'>

export interface DeckSummary {
  id: string
  name: string
  slideCount: number
  createdAt: number
  updatedAt: number
  /** Only on decks someone else owns. */
  role?: SharedRole
}

export interface Person {
  name: string
  email: string
}

export interface Project {
  id: string
  name: string
  createdAt: number
  updatedAt: number
  decks: DeckSummary[]
  /** Only on projects someone else owns and shared with the signed in person. */
  shared?: {
    owner: Person
    /** The role on the whole project, or null when only some of its decks are shared. */
    role: SharedRole | null
  }
}

/** Everything a guest owns, apart from deck content. */
export interface GuestIndex {
  version: 1
  projects: Project[]
}

/** An open deck document. Call `close` when done so storage can let go of it. */
export interface OpenDeck {
  doc: Y.Doc
  /** Waits until every change so far is stored. */
  flush: () => Promise<void>
  close: () => Promise<void>
}

/**
 * Where a guest's work lives. The browser uses IndexedDB; tests can use the
 * in-memory version. Phase 3 adds a server-backed one for signed-in users.
 */
export interface GuestStorage {
  loadIndex: () => Promise<GuestIndex | undefined>
  saveIndex: (index: GuestIndex) => Promise<void>
  openDeck: (deckId: string) => Promise<OpenDeck>
  deleteDeck: (deckId: string) => Promise<void>
}
