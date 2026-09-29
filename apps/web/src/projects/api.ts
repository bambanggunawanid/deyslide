import type { DeckSummary, Person, Project, SharedRole } from '../guest/types'
import type { ListEntry, SharingApi, ShareList, ShareTarget } from './sharing'
import type { ExportedProject } from './types'
import { toBase64 } from './base64'
import { StoreError } from './names'

/** The Deyslide API for the signed in person's projects. */
export interface ProjectApi extends SharingApi {
  list: () => Promise<Project[]>
  /** Projects and decks other people shared with the person. */
  shared: () => Promise<Project[]>
  createProject: (name: string) => Promise<Project>
  renameProject: (projectId: string, name: string) => Promise<void>
  deleteProject: (projectId: string) => Promise<void>
  createDeck: (projectId: string, name: string, state: Uint8Array) => Promise<DeckSummary>
  renameDeck: (deckId: string, name: string) => Promise<void>
  deleteDeck: (deckId: string) => Promise<void>
  deckState: (deckId: string) => Promise<Uint8Array>
  saveDeckState: (deckId: string, state: Uint8Array) => Promise<void>
  /** Returns how many projects were added. */
  importProjects: (projects: ExportedProject[]) => Promise<number>
}

const MESSAGES: Record<number, string> = {
  401: 'You are signed out. Sign in again to keep working.',
  404: 'That project or deck no longer exists.',
  413: 'That deck is too large to save.',
}

/** A shared project as the API sends it. */
interface SharedProjectResponse extends Omit<Project, 'shared'> {
  owner: Person
  role: SharedRole | null
}

const targetPath = (target: ShareTarget) => `/${target.type === 'project' ? 'projects' : 'decks'}/${encodeURIComponent(target.id)}/sharing`
const entryPath = (entry: ListEntry) => 'userId' in entry ? `/members/${encodeURIComponent(entry.userId)}` : `/invites/${encodeURIComponent(entry.inviteId)}`

export class HttpProjectApi implements ProjectApi {
  private readonly fetchImpl: typeof fetch

  constructor(fetchImpl: typeof fetch = (...args) => fetch(...args)) {
    this.fetchImpl = fetchImpl
  }

  list() {
    return this.json<Project[]>('GET', '/projects')
  }

  async shared() {
    const projects = await this.json<SharedProjectResponse[]>('GET', '/shared')
    return projects.map(({ owner, role, ...project }) => ({ ...project, shared: { owner, role } }))
  }

  members(target: ShareTarget) {
    return this.json<ShareList>('GET', targetPath(target))
  }

  share(target: ShareTarget, email: string, role: SharedRole) {
    return this.json<ShareList>('POST', targetPath(target), { email, role })
  }

  async changeRole(target: ShareTarget, entry: ListEntry, role: SharedRole) {
    await this.send('PATCH', `${targetPath(target)}${entryPath(entry)}`, { role })
  }

  async remove(target: ShareTarget, entry: ListEntry) {
    await this.send('DELETE', `${targetPath(target)}${entryPath(entry)}`)
  }

  createProject(name: string) {
    return this.json<Project>('POST', '/projects', { name })
  }

  async renameProject(projectId: string, name: string) {
    await this.send('PATCH', `/projects/${encodeURIComponent(projectId)}`, { name })
  }

  async deleteProject(projectId: string) {
    await this.send('DELETE', `/projects/${encodeURIComponent(projectId)}`)
  }

  createDeck(projectId: string, name: string, state: Uint8Array) {
    return this.json<DeckSummary>('POST', `/projects/${encodeURIComponent(projectId)}/decks`, { name, state: toBase64(state) })
  }

  async renameDeck(deckId: string, name: string) {
    await this.send('PATCH', `/decks/${encodeURIComponent(deckId)}`, { name })
  }

  async deleteDeck(deckId: string) {
    await this.send('DELETE', `/decks/${encodeURIComponent(deckId)}`)
  }

  async deckState(deckId: string) {
    const response = await this.send('GET', `/decks/${encodeURIComponent(deckId)}/state`)
    return new Uint8Array(await response.arrayBuffer())
  }

  async saveDeckState(deckId: string, state: Uint8Array) {
    await this.send('PUT', `/decks/${encodeURIComponent(deckId)}/state`, { state: toBase64(state) })
  }

  async importProjects(projects: ExportedProject[]) {
    return (await this.json<{ imported: number }>('POST', '/import', { projects })).imported
  }

  private async json<T>(method: string, path: string, body?: unknown): Promise<T> {
    return await (await this.send(method, path, body)).json() as T
  }

  private async send(method: string, path: string, body?: unknown): Promise<Response> {
    let response: Response
    try {
      response = await this.fetchImpl(`/api${path}`, {
        method,
        credentials: 'same-origin',
        headers: body === undefined ? undefined : { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
    }
    catch {
      throw new StoreError('Deyslide is unreachable. Check your connection and try again.')
    }
    if (response.ok)
      return response
    const reason = await response.json().then((data: { error?: string }) => data.error, () => undefined)
    // The server words refusals for people: bad input, and changes a role does not allow.
    const explained = response.status === 400 || response.status === 403 ? reason : undefined
    throw new StoreError(MESSAGES[response.status] ?? explained ?? 'Deyslide could not do that. Try again.')
  }
}
