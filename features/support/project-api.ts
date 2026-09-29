import type { DeckSummary, Project } from '../../apps/web/src/guest/types'
import type { ProjectApi } from '../../apps/web/src/projects/api'
import type { ExportedProject } from '../../apps/web/src/projects/types'
import * as Y from 'yjs'
import { StoreError } from '../../apps/web/src/projects/names'

/** An in-memory stand in for the project API, for page scenarios. The API has its own scenarios. */
export class FakeProjectApi implements ProjectApi {
  readonly projects: Project[] = []
  private readonly states = new Map<string, Uint8Array>()
  private nextId = 1
  /** When set, every call fails with this message, like a server that is down. */
  failWith = ''
  /** When true, only imports fail, like a server that refuses them. */
  failImports = false

  private check() {
    if (this.failWith)
      throw new StoreError(this.failWith)
  }

  private find(projectId: string) {
    const project = this.projects.find(item => item.id === projectId)
    if (!project)
      throw new StoreError('That project or deck no longer exists.')
    return project
  }

  private slides(state: Uint8Array) {
    const doc = new Y.Doc()
    Y.applyUpdate(doc, state)
    return (doc.getMap('deck').get('slides') as Y.Array<unknown>).length
  }

  async list() {
    this.check()
    return structuredClone(this.projects)
  }

  async createProject(name: string) {
    this.check()
    const project: Project = { id: `cloud-${this.nextId++}`, name, createdAt: Date.now(), updatedAt: Date.now(), decks: [] }
    this.projects.push(project)
    return structuredClone(project)
  }

  async renameProject(projectId: string, name: string) {
    this.check()
    this.find(projectId).name = name
  }

  async deleteProject(projectId: string) {
    this.check()
    this.projects.splice(this.projects.indexOf(this.find(projectId)), 1)
  }

  async createDeck(projectId: string, name: string, state: Uint8Array) {
    this.check()
    const deck: DeckSummary = { id: `cloud-${this.nextId++}`, name, slideCount: this.slides(state), createdAt: Date.now(), updatedAt: Date.now() }
    this.find(projectId).decks.push(deck)
    this.states.set(deck.id, state)
    return structuredClone(deck)
  }

  async renameDeck(deckId: string, name: string) {
    this.check()
    const deck = this.projects.flatMap(project => project.decks).find(item => item.id === deckId)
    if (deck)
      deck.name = name
  }

  async deleteDeck(deckId: string) {
    this.check()
    for (const project of this.projects)
      project.decks = project.decks.filter(deck => deck.id !== deckId)
  }

  async deckState(deckId: string) {
    this.check()
    const state = this.states.get(deckId)
    if (!state)
      throw new StoreError('That project or deck no longer exists.')
    return state
  }

  async importProjects(projects: ExportedProject[]) {
    this.check()
    if (this.failImports)
      throw new StoreError('Deyslide could not do that. Try again.')
    for (const project of projects) {
      const decks = project.decks.map((deck) => {
        const state = new Uint8Array(Buffer.from(deck.state, 'base64'))
        this.states.set(deck.id, state)
        return { id: deck.id, name: deck.name, slideCount: this.slides(state), createdAt: deck.createdAt, updatedAt: deck.updatedAt }
      })
      this.projects.push({ id: project.id, name: project.name, createdAt: project.createdAt, updatedAt: project.updatedAt, decks })
    }
    return projects.length
  }
}
