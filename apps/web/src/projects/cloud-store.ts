import type { Deck } from '@deyslide/deck-model'
import type { DeckTemplate } from '../guest/templates'
import type { DeckSummary, Project } from '../guest/types'
import type { ProjectApi } from './api'
import type { SharingApi } from './sharing'
import type { ExportedProject, ProjectStore } from './types'
import * as Y from 'yjs'
import { deckFromTemplate } from '../guest/templates'
import { cleanName } from './names'

/** The deck model is large, so it loads the first time a deck is touched. */
const loadModel = () => import('@deyslide/deck-model')

/** Projects saved to the signed in person's account, through the API. */
export class CloudStore implements ProjectStore {
  private projects: Project[] = []
  private shared: Project[] = []
  private readonly listeners = new Set<() => void>()
  private readonly api: ProjectApi
  readonly sharing: SharingApi

  private constructor(api: ProjectApi) {
    this.api = api
    this.sharing = {
      members: target => api.members(target),
      share: async (target, email, role) => {
        const list = await api.share(target, email, role)
        await this.refresh()
        return list
      },
      changeRole: async (target, entry, role) => {
        await api.changeRole(target, entry, role)
        await this.refresh()
      },
      remove: async (target, entry) => {
        await api.remove(target, entry)
        await this.refresh()
      },
    }
  }

  static async open(api: ProjectApi) {
    const store = new CloudStore(api)
    await store.refresh()
    return store
  }

  onChange(listener: () => void) {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** Reloads the project list from the server. */
  async refresh() {
    const [projects, shared] = await Promise.all([this.api.list(), this.api.shared()])
    this.projects = projects
    this.shared = shared
    for (const listener of this.listeners)
      listener()
  }

  listProjects() {
    return [...this.projects].sort((a, b) => b.updatedAt - a.updatedAt)
  }

  listShared() {
    return [...this.shared].sort((a, b) => b.updatedAt - a.updatedAt)
  }

  getProject(projectId: string) {
    return this.projects.find(project => project.id === projectId) ?? this.shared.find(project => project.id === projectId)
  }

  getDeck(projectId: string, deckId: string) {
    return this.getProject(projectId)?.decks.find(deck => deck.id === deckId)
  }

  async createProject(name: string) {
    const project = await this.api.createProject(cleanName(name, 'project'))
    await this.refresh()
    return project
  }

  async renameProject(projectId: string, name: string) {
    await this.api.renameProject(projectId, cleanName(name, 'project'))
    await this.refresh()
  }

  async deleteProject(projectId: string) {
    await this.api.deleteProject(projectId)
    await this.refresh()
  }

  async createDeck(projectId: string, name: string, template: DeckTemplate): Promise<DeckSummary> {
    const deckName = cleanName(name, 'deck')
    const [content, { deckToYDoc }] = await Promise.all([deckFromTemplate(template, deckName), loadModel()])
    const doc = deckToYDoc(content)
    const deck = await this.api.createDeck(projectId, deckName, Y.encodeStateAsUpdate(doc))
    doc.destroy()
    await this.refresh()
    return deck
  }

  async renameDeck(_projectId: string, deckId: string, name: string) {
    await this.api.renameDeck(deckId, cleanName(name, 'deck'))
    await this.refresh()
  }

  async deleteDeck(_projectId: string, deckId: string) {
    await this.api.deleteDeck(deckId)
    await this.refresh()
  }

  async readDeck(deckId: string): Promise<Deck> {
    const [state, { yDocToDeck }] = await Promise.all([this.api.deckState(deckId), loadModel()])
    const doc = new Y.Doc()
    try {
      Y.applyUpdate(doc, state)
      return yDocToDeck(doc)
    }
    finally {
      doc.destroy()
    }
  }

  async saveDeck(_projectId: string, deckId: string, deck: Deck) {
    const { deckToYDoc } = await loadModel()
    const doc = deckToYDoc(deck)
    try {
      await this.api.saveDeckState(deckId, Y.encodeStateAsUpdate(doc))
    }
    finally {
      doc.destroy()
    }
    await this.refresh()
  }

  async deckMarkdown(deckId: string) {
    const { toMarkdown } = await loadModel()
    return toMarkdown(await this.readDeck(deckId))
  }

  /** Adds browser projects to the account. Returns how many were added. */
  async importProjects(projects: ExportedProject[]) {
    const added = await this.api.importProjects(projects)
    await this.refresh()
    return added
  }
}
