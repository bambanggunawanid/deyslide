import type { Deck } from '@deyslide/deck-model'
import type { DeckSession, OpenDeckOptions } from '../deck/session'
import type { DeckTemplate } from '../guest/templates'
import type { DeckSummary, Project } from '../guest/types'
import type { SharingApi } from './sharing'

/**
 * Where the pages read and write projects. Guests use the browser store;
 * signed in people use the cloud store. Both keep a cached project list
 * and call `onChange` listeners after every change.
 */
export interface ProjectStore {
  onChange: (listener: () => void) => () => void
  listProjects: () => Project[]
  /** Projects and decks other people shared with the signed in person. Always empty for guests. */
  listShared: () => Project[]
  /** Finds a project among the person's own and the shared ones. */
  getProject: (projectId: string) => Project | undefined
  getDeck: (projectId: string, deckId: string) => DeckSummary | undefined
  createProject: (name: string) => Promise<Project>
  renameProject: (projectId: string, name: string) => Promise<void>
  deleteProject: (projectId: string) => Promise<void>
  createDeck: (projectId: string, name: string, template: DeckTemplate) => Promise<DeckSummary>
  renameDeck: (projectId: string, deckId: string, name: string) => Promise<void>
  deleteDeck: (projectId: string, deckId: string) => Promise<void>
  /**
   * Opens a deck live, for editing or following along. Close the session
   * when done. While a deck is open, the methods below read and change its
   * live document.
   */
  openDeck: (projectId: string, deckId: string, options?: OpenDeckOptions) => Promise<DeckSession>
  readDeck: (deckId: string) => Promise<Deck>
  /** Makes a deck hold this content, changing only what differs. */
  saveDeck: (projectId: string, deckId: string, deck: Deck) => Promise<void>
  deckMarkdown: (deckId: string) => Promise<string>
  /** Sharing, for signed in people only. */
  sharing?: SharingApi
  /**
   * Sends every open deck's changes on now, typing in open pages included,
   * as the app's window closes or goes out of sight. Resolves with the
   * names of the decks whose last changes are still not saved. Stores that
   * save at once have none.
   */
  flushAll?: () => Promise<string[]>
}

/** A browser project with each deck's Yjs document in base64, ready to move into an account. */
export interface ExportedProject {
  id: string
  name: string
  createdAt: number
  updatedAt: number
  decks: { id: string, name: string, createdAt: number, updatedAt: number, state: string }[]
}
