import type { Deck } from '@deyslide/deck-model'
import type { DeckTemplate } from './templates'
import type { DeckSummary, GuestIndex, GuestStorage, Project } from './types'
import { deckFromTemplate } from './templates'

/** The deck model is large, so it loads the first time a deck is touched. */
const loadModel = () => import('@deyslide/deck-model')

export const NAME_MAX_LENGTH = 80

export class GuestStoreError extends Error {}

function cleanName(name: string, kind: string) {
  const trimmed = name.trim()
  if (!trimmed)
    throw new GuestStoreError(`A ${kind} needs a name`)
  if (trimmed.length > NAME_MAX_LENGTH)
    throw new GuestStoreError(`A ${kind} name can have at most ${NAME_MAX_LENGTH} characters`)
  return trimmed
}

export interface GuestStoreOptions {
  now?: () => number
  newId?: () => string
}

/**
 * A guest's projects and decks. Keeps the index in memory, writes every
 * change through to storage, and tells listeners so the UI can refresh.
 */
export class GuestStore {
  private index: GuestIndex = { version: 1, projects: [] }
  private readonly listeners = new Set<() => void>()
  private readonly now: () => number
  private readonly newId: () => string

  private constructor(private readonly storage: GuestStorage, options: GuestStoreOptions) {
    this.now = options.now ?? Date.now
    this.newId = options.newId ?? (() => crypto.randomUUID())
  }

  static async open(storage: GuestStorage, options: GuestStoreOptions = {}) {
    const store = new GuestStore(storage, options)
    store.index = (await storage.loadIndex()) ?? store.index
    return store
  }

  onChange(listener: () => void) {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** Projects, most recently changed first. */
  listProjects(): Project[] {
    return [...this.index.projects].sort((a, b) => b.updatedAt - a.updatedAt)
  }

  getProject(projectId: string): Project | undefined {
    return this.index.projects.find(project => project.id === projectId)
  }

  getDeck(projectId: string, deckId: string): DeckSummary | undefined {
    return this.getProject(projectId)?.decks.find(deck => deck.id === deckId)
  }

  async createProject(name: string): Promise<Project> {
    const time = this.now()
    const project: Project = { id: this.newId(), name: cleanName(name, 'project'), createdAt: time, updatedAt: time, decks: [] }
    this.index.projects.push(project)
    await this.commit()
    return project
  }

  async renameProject(projectId: string, name: string) {
    const project = this.requireProject(projectId)
    project.name = cleanName(name, 'project')
    project.updatedAt = this.now()
    await this.commit()
  }

  async deleteProject(projectId: string) {
    const project = this.requireProject(projectId)
    await Promise.all(project.decks.map(deck => this.storage.deleteDeck(deck.id)))
    this.index.projects = this.index.projects.filter(item => item.id !== projectId)
    await this.commit()
  }

  async createDeck(projectId: string, name: string, template: DeckTemplate): Promise<DeckSummary> {
    const project = this.requireProject(projectId)
    const deckName = cleanName(name, 'deck')
    const content = await deckFromTemplate(template, deckName)
    const { deckToYDoc } = await loadModel()
    const summary: DeckSummary = { id: this.newId(), name: deckName, slideCount: content.slides.length, createdAt: this.now(), updatedAt: this.now() }

    const open = await this.storage.openDeck(summary.id)
    try {
      deckToYDoc(content, open.doc)
    }
    finally {
      await open.close()
    }

    project.decks.push(summary)
    project.updatedAt = summary.updatedAt
    await this.commit()
    return summary
  }

  async renameDeck(projectId: string, deckId: string, name: string) {
    const deck = this.requireDeck(projectId, deckId)
    deck.name = cleanName(name, 'deck')
    deck.updatedAt = this.now()
    this.requireProject(projectId).updatedAt = deck.updatedAt
    await this.commit()
  }

  async deleteDeck(projectId: string, deckId: string) {
    const project = this.requireProject(projectId)
    this.requireDeck(projectId, deckId)
    await this.storage.deleteDeck(deckId)
    project.decks = project.decks.filter(deck => deck.id !== deckId)
    project.updatedAt = this.now()
    await this.commit()
  }

  async readDeck(deckId: string): Promise<Deck> {
    const { yDocToDeck } = await loadModel()
    const open = await this.storage.openDeck(deckId)
    try {
      return yDocToDeck(open.doc)
    }
    finally {
      await open.close()
    }
  }

  async deckMarkdown(deckId: string): Promise<string> {
    const { toMarkdown } = await loadModel()
    return toMarkdown(await this.readDeck(deckId))
  }

  private requireProject(projectId: string) {
    const project = this.getProject(projectId)
    if (!project)
      throw new GuestStoreError('That project no longer exists')
    return project
  }

  private requireDeck(projectId: string, deckId: string) {
    const deck = this.getDeck(projectId, deckId)
    if (!deck)
      throw new GuestStoreError('That deck no longer exists')
    return deck
  }

  private async commit() {
    await this.storage.saveIndex(this.index)
    for (const listener of this.listeners)
      listener()
  }
}
