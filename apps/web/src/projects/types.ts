import type { Deck } from '@deyslide/deck-model'
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
  readDeck: (deckId: string) => Promise<Deck>
  /** Replaces a deck's content, for example after editing its Markdown. */
  saveDeck: (projectId: string, deckId: string, deck: Deck) => Promise<void>
  deckMarkdown: (deckId: string) => Promise<string>
  /** Sharing, for signed in people only. */
  sharing?: SharingApi
}

/** A browser project with each deck's Yjs document in base64, ready to move into an account. */
export interface ExportedProject {
  id: string
  name: string
  createdAt: number
  updatedAt: number
  decks: { id: string, name: string, createdAt: number, updatedAt: number, state: string }[]
}
