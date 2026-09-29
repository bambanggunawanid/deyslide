import type { DeckSummary, Project, SharedRole } from '../../apps/web/src/guest/types'
import type { ProjectApi } from '../../apps/web/src/projects/api'
import type { ListEntry, ShareList, ShareTarget } from '../../apps/web/src/projects/sharing'
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

  async saveDeckState(deckId: string, state: Uint8Array) {
    this.check()
    const deck = this.projects.flatMap(project => project.decks).find(item => item.id === deckId)
    if (!deck)
      throw new StoreError('That project or deck no longer exists.')
    deck.slideCount = this.slides(state)
    this.states.set(deckId, state)
  }

  /** Stores a deck's content directly, for decks scenarios set up by hand. */
  putDeckState(deckId: string, state: Uint8Array) {
    this.states.set(deckId, state)
  }

  /** Projects other people shared with the signed in person. Scenarios put them here. */
  readonly sharedProjects: Project[] = []
  /** Who has access to each project or deck, by target id. Scenarios set the starting lists. */
  readonly shareLists = new Map<string, ShareList>()
  /** Accounts that exist, so sharing with them adds a member instead of an invite. */
  readonly accounts = new Map<string, string>()

  async shared() {
    this.check()
    return structuredClone(this.sharedProjects)
  }

  private shareList(target: ShareTarget) {
    const list = this.shareLists.get(target.id)
    if (!list)
      throw new StoreError('That project or deck no longer exists.')
    return list
  }

  async members(target: ShareTarget) {
    this.check()
    return structuredClone(this.shareList(target))
  }

  async share(target: ShareTarget, email: string, role: SharedRole) {
    this.check()
    const list = this.shareList(target)
    if (list.role === 'viewer')
      throw new StoreError('Only the owner and editors can share.')
    if (list.members.some(member => member.email === email) || list.invites.some(invite => invite.email === email))
      throw new StoreError(`${email} already has access. Change the role in the list instead.`)
    const name = this.accounts.get(email)
    if (name)
      list.members.push({ userId: `user-${email}`, name, email, role })
    else
      list.invites.push({ id: `invite-${this.nextId++}`, email, role })
    return structuredClone(list)
  }

  async changeRole(target: ShareTarget, entry: ListEntry, role: SharedRole) {
    this.check()
    const list = this.shareList(target)
    if (list.role !== 'owner')
      throw new StoreError('Only the owner can change roles.')
    const found = 'userId' in entry ? list.members.find(member => member.userId === entry.userId) : list.invites.find(invite => invite.id === entry.inviteId)
    if (found)
      found.role = role
  }

  async remove(target: ShareTarget, entry: ListEntry) {
    this.check()
    const list = this.shareList(target)
    list.members = list.members.filter(member => !('userId' in entry && member.userId === entry.userId))
    list.invites = list.invites.filter(invite => !('inviteId' in entry && invite.id === entry.inviteId))
    // Leaving a shared project takes it off the list.
    const index = this.sharedProjects.findIndex(project => project.id === target.id)
    if (index !== -1)
      this.sharedProjects.splice(index, 1)
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
