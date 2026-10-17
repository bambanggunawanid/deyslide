import type { Awareness } from 'y-protocols/awareness'
import type { SessionStatus } from '../../apps/web/src/deck/session'
import type { DeckSummary, Project, Role, SharedRole } from '../../apps/web/src/guest/types'
import type { DeckConnection, ProjectApi } from '../../apps/web/src/projects/api'
import type { ListEntry, ShareList, ShareTarget } from '../../apps/web/src/projects/sharing'
import type { ExportedProject } from '../../apps/web/src/projects/types'
import { ref } from 'vue'
import { applyAwarenessUpdate, encodeAwarenessUpdate, removeAwarenessStates } from 'y-protocols/awareness'
import * as Y from 'yjs'
import type { DeckFailure } from '../../apps/web/src/projects/collab'
import { NO_ACCESS, SIGNED_OUT, VIEW_ONLY_NOW } from '../../apps/web/src/projects/collab'
import { StoreError } from '../../apps/web/src/projects/names'
import { deckRole } from '../../apps/web/src/projects/roles'
import { applyDeck, readDeckDoc } from '../../packages/deck-model/src'

/** The origin a write from "Claude Code" (or any server writer) has on the server's document. */
export const SERVER_WRITER = Symbol('server writer')

/**
 * One page's live connection to a deck's room. Like Hocuspocus, it relays
 * changes both ways while online, and the page's document gets the room's
 * changes with the connection as their origin.
 */
class FakeConnection {
  readonly status = ref<SessionStatus>('connecting')
  readonly synced = ref(false)
  readonly readOnly = ref(true)
  readonly error = ref('')
  readonly unsaved = ref(false)
  readonly failure = ref<DeckFailure>()
  /** Changes the room has not confirmed yet, while the server is slow to confirm. */
  readonly unconfirmed: Uint8Array[] = []
  /** The page changed its deck while the connection was down. */
  changedOffline = false
  live = false
  failed = false
  viewer = false
  /** The server closed the connection after a role change; the page joins again. */
  rejoining = false
  /** The role a scenario gave this page's person, over what the projects say. */
  role?: Role
  closed = false
  /** The token the page last connected with, which says whose page it is. */
  lastToken?: string

  constructor(
    readonly api: FakeProjectApi,
    readonly deckId: string,
    readonly doc: Y.Doc,
    readonly awareness: Awareness,
    readonly token: () => Promise<string>,
  ) {}

  update() {
    this.unsaved.value = this.synced.value && !this.failed && !this.viewer && (this.unconfirmed.length > 0 || this.changedOffline)
    if (this.failed) {
      this.status.value = 'failed'
      this.readOnly.value = true
      return
    }
    this.readOnly.value = !this.synced.value || this.viewer || this.rejoining
    if (!this.live)
      this.status.value = this.api.reaches(this.lastToken) || this.rejoining ? 'connecting' : 'offline'
    else
      this.status.value = this.unconfirmed.length > 0 && !this.viewer ? 'saving' : 'saved'
  }
}

/** An in-memory stand in for the project API, for page scenarios. The API has its own scenarios. */
export class FakeProjectApi implements ProjectApi {
  readonly projects: Project[] = []
  private readonly states = new Map<string, Uint8Array>()
  private nextId = 1
  /** When set, every call fails with this message, like a server that is down. */
  failWith = ''
  /** When true, only imports fail, like a server that refuses them. */
  failImports = false
  /** False while the connection to the server is down. Change it with `goOffline` and `goOnline`. */
  online = true
  /** When true, the server takes its time to confirm changes. `confirmChanges` confirms them. */
  slowToConfirm = false
  /** Each deck's live document on the server, while it is open or after it was. */
  readonly rooms = new Map<string, Y.Doc>()
  private readonly connections = new Set<FakeConnection>()
  /** Why the server refuses every connection from now on, once it does. */
  private refusal = ''
  /** Tokens pages sent when they connected, in order. */
  readonly tokens: string[] = []

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
    const room = this.rooms.get(deckId)
    const state = room ? Y.encodeStateAsUpdate(room) : this.states.get(deckId)
    if (!state)
      throw new StoreError('That project or deck no longer exists.')
    return state
  }

  /**
   * Saves a whole deck, as Claude Code or an older page does. Like the
   * server, it changes only what differs in the deck's live room, so pages
   * with the deck open see the change at once.
   */
  async saveDeckState(deckId: string, state: Uint8Array) {
    this.check()
    const deck = this.projects.flatMap(project => project.decks).find(item => item.id === deckId)
    if (!deck)
      throw new StoreError('That project or deck no longer exists.')
    deck.slideCount = this.slides(state)
    const room = this.rooms.get(deckId)
    if (!room) {
      this.states.set(deckId, state)
      return
    }
    const saved = new Y.Doc()
    Y.applyUpdate(saved, state)
    applyDeck(room, readDeckDoc(saved), SERVER_WRITER)
    saved.destroy()
  }

  /** Changes a deck's live room directly, as another server writer would. */
  changeRoom(deckId: string, change: (doc: Y.Doc) => void) {
    const room = this.room(deckId)
    if (!room)
      throw new Error(`No deck ${deckId}`)
    room.transact(() => change(room), SERVER_WRITER)
  }

  // Live editing -------------------------------------------------------------

  connectDeck(deckId: string, doc: Y.Doc, awareness: Awareness, token: () => Promise<string>): DeckConnection {
    const connection = new FakeConnection(this, deckId, doc, awareness, token)
    this.connections.add(connection)
    doc.on('update', (update: Uint8Array, origin: unknown) => {
      if (origin === connection)
        return
      if (!connection.live)
        connection.changedOffline = true
      this.send(connection, update)
    })
    // The page's own presence goes to everyone else; what it received from them does not go back.
    awareness.on('update', ({ added, updated, removed }: { added: number[], updated: number[], removed: number[] }, origin: unknown) => {
      const own = [...added, ...updated, ...removed].filter(client => client === doc.clientID)
      if (!(origin instanceof FakeConnection) && connection.live && own.length > 0)
        this.relayPresence(connection, own)
    })
    connection.update()
    // Like a socket, the connection opens a moment later.
    queueMicrotask(() => void this.connect(connection))
    return {
      status: connection.status,
      synced: connection.synced,
      readOnly: connection.readOnly,
      error: connection.error,
      unsaved: connection.unsaved,
      failure: connection.failure,
      flush: async () => {},
      destroy: () => this.disconnect(connection, true),
    }
  }

  /** Pages whose connection is down while everyone else stays online, by the token they connect with. */
  private readonly down = new Set<string>()

  /** Whether a page that connects with this token reaches the server. */
  reaches(token?: string) {
    return this.online && !(token !== undefined && this.down.has(token))
  }

  /** The connection drops only for the pages that connect with this token, such as one person's. */
  goOfflineFor(token: string) {
    this.down.add(token)
    for (const connection of this.connections) {
      if (connection.lastToken === token)
        this.disconnect(connection, false)
    }
  }

  /** The connection comes back for the pages that connect with this token, and they join their decks again. */
  goOnlineFor(token: string) {
    this.down.delete(token)
    for (const connection of this.connections) {
      if (connection.lastToken === token)
        void this.connect(connection)
    }
  }

  /** The connection to the server drops for every page. */
  goOffline() {
    this.online = false
    for (const connection of this.connections)
      this.disconnect(connection, false)
  }

  /** The connection comes back, and every page joins its deck again. */
  goOnline() {
    this.online = true
    for (const connection of this.connections)
      void this.connect(connection)
  }

  /** The server refuses the person from now on, like after they were removed from the deck. */
  failAuth(message = NO_ACCESS) {
    this.refusal = message
    for (const connection of this.connections) {
      this.disconnect(connection, false)
      this.stop(connection, message, 'refused')
    }
  }

  /** Sign ins the server no longer takes, by the token pages connect with. */
  private readonly signedOut = new Set<string>()
  /** Tokens whose next access check fails on the server (its database, say), once each. */
  private readonly checkFails = new Map<string, number>()

  /**
   * The sign in behind this token ended on the server (it expired, or ended
   * elsewhere). Like the server, open connections close and joining again
   * is refused as signed out.
   */
  endSignIn(token: string) {
    this.signedOut.add(token)
    for (const connection of this.connections) {
      if (connection.lastToken === token && connection.live) {
        this.disconnect(connection, false)
        this.stop(connection, SIGNED_OUT, 'signed-out')
      }
    }
  }

  /** The server takes this token again, after the person signed in again. */
  signInAgain(token: string) {
    this.signedOut.delete(token)
  }

  /** The next `times` access checks for this token fail on the server, which asks the page to try again later. */
  failAccessChecks(token: string, times = 1) {
    this.checkFails.set(token, times)
  }

  /** The connection stops for good. */
  private stop(connection: FakeConnection, message: string, kind: DeckFailure) {
    connection.failed = true
    connection.failure.value = kind
    connection.error.value = message
    connection.update()
  }

  /**
   * The person's role changes, on the page holding `target` (a document) or
   * on every page with the deck `target` open. Like the real server, this
   * closes those connections, and each page joins again with the new role.
   */
  rejoinAs(target: Y.Doc | string, role: Role) {
    for (const connection of this.connections) {
      if ((connection.doc !== target && connection.deckId !== target) || !connection.live)
        continue
      connection.role = role
      this.disconnect(connection, false)
      connection.rejoining = true
      connection.update()
      void this.connect(connection)
    }
  }

  /** The server confirms every change it holds back while it is slow to confirm. */
  confirmChanges() {
    for (const connection of this.connections) {
      const updates = connection.unconfirmed.splice(0)
      const room = this.rooms.get(connection.deckId)
      if (room && connection.live) {
        for (const update of updates)
          Y.applyUpdate(room, update, connection)
      }
      connection.update()
    }
  }

  /** What the person may do with a deck, as the server would decide. */
  private role(deckId: string): Role | undefined {
    if (this.projects.some(project => project.decks.some(deck => deck.id === deckId)))
      return 'owner'
    for (const project of this.sharedProjects) {
      const deck = project.decks.find(item => item.id === deckId)
      if (deck)
        return deckRole(project, deck)
    }
    return undefined
  }

  private room(deckId: string) {
    let room = this.rooms.get(deckId)
    const state = this.states.get(deckId)
    if (!room && state) {
      room = new Y.Doc()
      Y.applyUpdate(room, state)
      const opened = room
      opened.on('update', (update: Uint8Array, origin: unknown) => {
        const deck = this.projects.flatMap(project => project.decks).find(item => item.id === deckId)
        if (deck)
          deck.slideCount = readDeckDoc(opened).slides.length
        for (const connection of this.connections) {
          if (connection.deckId === deckId && connection.live && origin !== connection)
            Y.applyUpdate(connection.doc, update, connection)
        }
      })
      this.rooms.set(deckId, room)
    }
    return room
  }

  private async connect(connection: FakeConnection) {
    if (connection.closed || connection.live || connection.failed)
      return
    const token = await connection.token()
    this.tokens.push(token)
    connection.lastToken = token
    if (connection.closed || connection.live || connection.failed || !this.reaches(token)) {
      connection.update()
      return
    }
    const fails = this.checkFails.get(token) ?? 0
    if (fails > 0) {
      // Not a refusal: the page joins again a moment later.
      this.checkFails.set(token, fails - 1)
      connection.update()
      setTimeout(() => void this.connect(connection), 10)
      return
    }
    if (this.signedOut.has(token)) {
      this.stop(connection, SIGNED_OUT, 'signed-out')
      return
    }
    const access = this.role(connection.deckId)
    // A role a scenario gave the page counts while the person has access at all.
    const role = access && (connection.role ?? access)
    const room = role && !this.refusal ? this.room(connection.deckId) : undefined
    if (!role || !room) {
      this.stop(connection, this.refusal || NO_ACCESS, 'refused')
      return
    }
    connection.viewer = role === 'viewer'
    connection.rejoining = false
    // Like the server, a viewer's changes are turned down, and the page is told.
    if (connection.viewer && this.adds(connection.doc, room)) {
      this.refuse(connection)
      return
    }
    connection.live = true
    // Sync: the page gets what the room has, and the room what the page changed meanwhile.
    Y.applyUpdate(connection.doc, Y.encodeStateAsUpdate(room, Y.encodeStateVector(connection.doc)), connection)
    if (!connection.viewer) {
      Y.applyUpdate(room, Y.encodeStateAsUpdate(connection.doc, Y.encodeStateVector(room)), connection)
      connection.changedOffline = false
    }
    connection.synced.value = true
    // Presence both ways: the page's own, and everyone else's.
    for (const other of this.connections) {
      if (other !== connection && other.deckId === connection.deckId && other.live) {
        const clients = [...other.awareness.getStates().keys()].filter(client => client === other.doc.clientID)
        if (clients.length)
          applyAwarenessUpdate(connection.awareness, encodeAwarenessUpdate(other.awareness, clients), connection)
      }
    }
    this.relayPresence(connection, [connection.doc.clientID])
    connection.update()
  }

  private disconnect(connection: FakeConnection, closing: boolean) {
    if (closing) {
      connection.closed = true
      this.connections.delete(connection)
    }
    if (!connection.live) {
      connection.update()
      return
    }
    connection.live = false
    // Others stop seeing this page, and this page stops seeing them.
    for (const other of this.connections) {
      if (other !== connection && other.deckId === connection.deckId) {
        removeAwarenessStates(other.awareness, [connection.doc.clientID], connection)
        removeAwarenessStates(connection.awareness, [other.doc.clientID], connection)
      }
    }
    connection.update()
  }

  /** Whether `doc` holds changes `room` does not have. */
  private adds(doc: Y.Doc, room: Y.Doc) {
    const known = Y.encodeStateVector(room)
    const missing = Y.decodeStateVector(Y.encodeStateVectorFromUpdate(Y.encodeStateAsUpdate(doc, known)))
    const has = Y.decodeStateVector(known)
    return [...missing].some(([client, clock]) => clock > (has.get(client) ?? 0))
  }

  /** A viewer's page sent a change: the server turns it down and the page stops. */
  private refuse(connection: FakeConnection) {
    this.disconnect(connection, false)
    this.stop(connection, VIEW_ONLY_NOW, 'turned-down')
  }

  /** Sends a page's change to the room, unless it is offline, a viewer, or the room is slow to confirm. */
  private send(connection: FakeConnection, update: Uint8Array) {
    const room = this.rooms.get(connection.deckId)
    if (connection.live && connection.viewer) {
      this.refuse(connection)
      return
    }
    if (!connection.live || !room) {
      connection.update()
      return
    }
    if (this.slowToConfirm)
      connection.unconfirmed.push(update)
    else
      Y.applyUpdate(room, update, connection)
    connection.update()
  }

  private relayPresence(from: FakeConnection, clients: number[]) {
    const update = encodeAwarenessUpdate(from.awareness, clients)
    for (const other of this.connections) {
      if (other !== from && other.deckId === from.deckId && other.live)
        applyAwarenessUpdate(other.awareness, update, from)
    }
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
