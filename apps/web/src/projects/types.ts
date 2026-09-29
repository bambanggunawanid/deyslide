import type { Deck } from '@deyslide/deck-model'
import type { DeckTemplate } from '../guest/templates'
import type { DeckSummary, Project } from '../guest/types'

/**
 * Where the pages read and write projects. Guests use the browser store;
 * signed in people use the cloud store. Both keep a cached project list
 * and call `onChange` listeners after every change.
 */
export interface ProjectStore {
  onChange: (listener: () => void) => () => void
  listProjects: () => Project[]
  getProject: (projectId: string) => Project | undefined
  getDeck: (projectId: string, deckId: string) => DeckSummary | undefined
  createProject: (name: string) => Promise<Project>
  renameProject: (projectId: string, name: string) => Promise<void>
  deleteProject: (projectId: string) => Promise<void>
  createDeck: (projectId: string, name: string, template: DeckTemplate) => Promise<DeckSummary>
  renameDeck: (projectId: string, deckId: string, name: string) => Promise<void>
  deleteDeck: (projectId: string, deckId: string) => Promise<void>
  readDeck: (deckId: string) => Promise<Deck>
  deckMarkdown: (deckId: string) => Promise<string>
}

/** A browser project with each deck's Yjs document in base64, ready to move into an account. */
export interface ExportedProject {
  id: string
  name: string
  createdAt: number
  updatedAt: number
  decks: { id: string, name: string, createdAt: number, updatedAt: number, state: string }[]
}
