import type { Deck } from '@deyslide/deck-model'
import type { Ref } from 'vue'
import type { DeckSession, OpenDeckOptions } from '../deck/session'
import type { DeckTemplate } from '../guest/templates'
import type { DeckSummary, Project } from '../guest/types'
import type { DeckConnection, ProjectApi } from './api'
import type { DeckFailure } from './collab'
import type { DeckCopy, OfflineCache } from './offline-cache'
import type { SharingApi } from './sharing'
import type { ExportedProject, ProjectStore } from './types'
import { computed, ref, shallowRef, watch } from 'vue'
import { Awareness } from 'y-protocols/awareness'
import * as Y from 'yjs'
import { createDeckSession, EXTERNAL_ORIGIN, holdsDeck } from '../deck/session'
import { deckFromTemplate } from '../guest/templates'
import { cleanName, StoreError } from './names'
import { canEdit, deckRole } from './roles'

/** The deck model is large, so it loads the first time a deck is touched. */
const loadModel = () => import('@deyslide/deck-model')

export interface CloudStoreOptions {
  /**
   * The token live editing sends on every connect. Browsers send `cookie`,
   * so the server reads the session cookie instead.
   */
  token?: () => Promise<string>
  /**
   * Keeps the person's decks and project lists on this device, so they
   * open and change without a connection. Needs `userId`.
   */
  cache?: OfflineCache
  /** Whose decks the cache keeps. */
  userId?: string
  /** How often the store asks the server again while it is out of reach. */
  retryMs?: number
}

/** What the page adds to a failure once the deck's copy on this device is gone. */
export const COPY_DELETED = 'Its copy on this device was deleted.'
/** Added when that copy held changes the server never got: the open page still has them. */
export const DOWNLOAD_TO_KEEP = 'Download the Markdown to keep your changes.'
/** Added when the sign in ended and the deck's copy keeps the changes for the next sign in. */
export const KEPT_UNTIL_SIGN_IN = 'They stay on this device until then.'

/** How often the store asks the server again while it is out of reach, by default. */
const RETRY_MS = 30_000

/**
 * A deck's live document in this page, shared by every session that has it
 * open and by the store's own reads and saves.
 */
interface LiveDeck {
  id: string
  /** Sessions using it. */
  users: number
  doc: Y.Doc
  awareness: Awareness
  connection: DeckConnection
  /** The document holds the deck: it synced once, or its copy on this device brought it. */
  loaded: Ref<boolean>
  /** Changes would not be kept. Before the first sync, a deck from its copy is read only only for viewers and after a failure. */
  readOnly: Readonly<Ref<boolean>>
  error: Readonly<Ref<string>>
  /** Changes made here wait for the server, also those made from the copy before any sync. */
  unsaved: Readonly<Ref<boolean>>
  /** Sessions showing the deck to the person, apart from sending changes in the background. */
  shown: Ref<number>
  /** The deck's copy on this device, when the store keeps copies. */
  copy?: DeckCopy
  /** What the copy holds is in the document (true at once without a copy). */
  copyLoaded: Ref<boolean>
  /** Stops following the document and the connection. */
  stop: () => void
  /** Set while nobody uses it but the server still waits for changes made here. */
  stopWaiting?: () => void
}

/** Projects saved to the signed in person's account, through the API. */
export class CloudStore implements ProjectStore {
  private projects: Project[] = []
  private shared: Project[] = []
  private readonly listeners = new Set<() => void>()
  private readonly api: ProjectApi
  private readonly token: () => Promise<string>
  /** Decks open live in this page, by id. Reads and saves go through their documents. */
  private readonly live = new Map<string, LiveDeck>()
  /** Decks nobody has open whose changes still wait for the server. */
  private readonly waiting = new Set<LiveDeck>()
  /** Open sessions and the deck each one shows. */
  private readonly sessions = new Map<DeckSession, string>()
  private readonly warnOnClose = (event: BeforeUnloadEvent) => event.preventDefault()
  /** The device's cache and whose decks it keeps, when the store keeps copies. */
  private readonly kept?: { cache: OfflineCache, userId: string }
  private readonly retryMs: number
  private readonly offlineState = ref(false)
  /** True while the lists shown are the ones kept on this device, because the server is out of reach. */
  readonly offline: Readonly<Ref<boolean>> = computed(() => this.offlineState.value)
  /** Decks with a copy on this device. */
  private readonly copies = shallowRef<ReadonlySet<string>>(new Set())
  private stopRetrying?: () => void
  private closed = false
  /** The browser says the network went away: the lists shown are now the last ones read. */
  private readonly wentOffline = () => {
    if (this.closed)
      return
    this.offlineState.value = true
    this.retryWhileOffline()
  }
  readonly sharing: SharingApi

  private constructor(api: ProjectApi, options: CloudStoreOptions) {
    this.api = api
    this.token = options.token ?? (async () => 'cookie')
    this.kept = options.cache && options.userId ? { cache: options.cache, userId: options.userId } : undefined
    this.retryMs = options.retryMs ?? RETRY_MS
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

  /**
   * Reads the person's projects. When the server is out of reach, the lists
   * kept on this device stand in, marked offline, until it answers again.
   * Without kept lists, that fails.
   */
  static async open(api: ProjectApi, options: CloudStoreOptions = {}) {
    const store = new CloudStore(api, options)
    await store.start()
    return store
  }

  private async start() {
    try {
      await this.refresh()
    }
    catch (error) {
      const lists = this.kept && await this.kept.cache.lists(this.kept.userId)
      if (!lists)
        throw error
      this.projects = lists.projects
      this.shared = lists.shared
      this.offlineState.value = true
      this.retryWhileOffline()
    }
    if (!this.kept)
      return
    if (typeof window !== 'undefined')
      window.addEventListener('offline', this.wentOffline)
    // Copies in memory go with the page, so they do not count as kept.
    if (this.kept.cache.durable)
      this.copies.value = new Set([...this.copies.value, ...await this.kept.cache.decks(this.kept.userId)])
    if (!this.offlineState.value)
      void this.sendPending()
  }

  /** Whether the deck has a copy on this device that outlasts the page, so it opens and changes offline. */
  keptOnDevice(deckId: string) {
    return this.copies.value.has(deckId)
  }

  /** Asks the server again now and then, and as soon as the browser says it is back online. */
  private retryWhileOffline() {
    if (this.stopRetrying)
      return
    const retry = () => {
      void this.refresh().catch(() => {})
    }
    const timer = setInterval(retry, this.retryMs)
    if (typeof window !== 'undefined')
      window.addEventListener('online', retry)
    this.stopRetrying = () => {
      clearInterval(timer)
      if (typeof window !== 'undefined')
        window.removeEventListener('online', retry)
      this.stopRetrying = undefined
    }
  }

  onChange(listener: () => void) {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** Reloads the project list from the server. */
  async refresh() {
    const [projects, shared] = await Promise.all([this.api.list(), this.api.shared()])
    if (this.closed)
      return
    this.projects = projects
    this.shared = shared
    const wasOffline = this.offlineState.value
    this.offlineState.value = false
    this.stopRetrying?.()
    if (this.kept)
      void this.kept.cache.saveLists(this.kept.userId, { projects, shared })
    for (const listener of this.listeners)
      listener()
    if (wasOffline)
      void this.sendPending()
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

  async openDeck(_projectId: string, deckId: string, options: OpenDeckOptions = {}): Promise<DeckSession> {
    const deck = this.hold(deckId)
    const { connection } = deck
    let closed = false
    const session = createDeckSession(deck.doc, deck.awareness, {
      status: connection.status,
      error: deck.error,
      ready: computed(() => deck.loaded.value),
      readOnly: deck.readOnly,
      flush: () => connection.flush(),
      close: () => {
        if (closed)
          return
        closed = true
        deck.shown.value--
        this.sessions.delete(session)
        this.letGo(deckId, deck)
      },
    }, options)
    this.sessions.set(session, deckId)
    deck.shown.value++
    return session
  }

  /**
   * Sends every deck's changes to the server now, typing in open pages
   * included, as the app's window closes. Resolves with the names of the
   * decks whose last changes the server does not have yet: offline, say,
   * or typing held back by a problem in its Markdown.
   */
  async flushAll(): Promise<string[]> {
    await Promise.all([...this.sessions.keys()].map(session => session.flush().catch(() => {})))
    await Promise.all([...this.live.values()].map(deck => deck.connection.flush().catch(() => {})))
    // A deck kept on this device loses nothing: its changes go out the next time Deyslide is online.
    const left = new Set([...this.live].filter(([deckId, deck]) => deck.unsaved.value && !this.keptOnDevice(deckId)).map(([deckId]) => deckId))
    for (const [session, deckId] of this.sessions) {
      if (session.typingPending.value)
        left.add(deckId)
    }
    const names = new Map([...this.projects, ...this.shared].flatMap(project => project.decks.map(deck => [deck.id, deck.name] as const)))
    return [...left].map(deckId => names.get(deckId) ?? 'a deck')
  }

  /** The deck's live document, joined for the first user and shared after that. */
  private hold(deckId: string): LiveDeck {
    const held = this.live.get(deckId)
    if (held) {
      held.users++
      held.stopWaiting?.()
      // Presence was cleared when the last session let go.
      if (held.awareness.getLocalState() === null)
        held.awareness.setLocalState({})
      return held
    }
    const doc = new Y.Doc()
    const awareness = new Awareness(doc)
    // The copy loads first where there is one; the connection syncs whenever it can.
    const copy = this.kept?.cache.followDeck(this.kept.userId, deckId, doc)
    const connection = this.api.connectDeck(deckId, doc, awareness, this.token)
    /** The copy on this device brought the deck, so it can be read and changed before the first sync. */
    const fromCopy = ref(false)
    /** Changed here after the copy loaded and before the first sync. */
    const changedBeforeSync = ref(false)
    // Viewers stay viewers offline: the role comes from the lists kept with the copy.
    const viewer = this.viewerOf(deckId)
    // The document holds the deck once the first sync or the copy brought it.
    const loaded = ref(false)
    const check = () => {
      loaded.value = (connection.synced.value || fromCopy.value) && holdsDeck(doc)
      if (loaded.value)
        doc.off('update', check)
    }
    const noteChange = (_update: Uint8Array, origin: unknown) => {
      if (fromCopy.value && !connection.synced.value && origin !== copy?.origin)
        changedBeforeSync.value = true
    }
    doc.on('update', check)
    doc.on('update', noteChange)
    const copyLoaded = ref(!copy)
    void copy?.loaded.then(() => {
      fromCopy.value = copy.holdsDeck
      copyLoaded.value = true
      check()
    })
    const stopChecking = watch(connection.synced, check, { immediate: true })
    const failed = computed(() => connection.status.value === 'failed')
    /** What the page adds to the failure once the copy was deleted: what happened to the copy and its changes. */
    const dropped = ref('')
    const shown = ref(0)
    const readOnlyNow = computed(() => connection.synced.value || !fromCopy.value
      ? connection.readOnly.value
      : failed.value || viewer)
    const unsaved = computed(() => connection.synced.value
      ? connection.unsaved.value
      : changedBeforeSync.value && !failed.value)
    // What the person may do changed (the server let them in again after a
    // role change): the project list says so too.
    const stopFollowing = watch(() => connection.synced.value && connection.readOnly.value, () => {
      void this.refresh().catch(() => {})
    })
    const stopKeeping = this.kept ? this.keep(deckId, { unsaved, connection, dropped, copy, copyLoaded, shown }) : () => {}
    const error = computed(() => {
      const message = connection.error.value
      if (dropped.value)
        return `${message} ${dropped.value}`
      // The sign in ended: the copy keeps the changes for the next one.
      if (connection.failure.value === 'signed-out' && this.keptOnDevice(deckId))
        return `${message} ${KEPT_UNTIL_SIGN_IN}`
      return message
    })
    const deck: LiveDeck = {
      id: deckId,
      users: 1,
      doc,
      awareness,
      connection,
      loaded,
      readOnly: readOnlyNow,
      error,
      unsaved,
      shown,
      copy,
      copyLoaded,
      stop: () => {
        stopChecking()
        stopFollowing()
        stopKeeping()
        doc.off('update', check)
        doc.off('update', noteChange)
      },
    }
    this.live.set(deckId, deck)
    return deck
  }

  /** Whether the person may only view the deck, as the lists say. */
  private viewerOf(deckId: string) {
    for (const project of [...this.projects, ...this.shared]) {
      const deck = project.decks.find(item => item.id === deckId)
      if (deck)
        return !canEdit(deckRole(project, deck))
    }
    return false
  }

  /**
   * Follows a deck's copy on this device: counts it as kept once it is
   * written where it outlasts the page, notes when it holds changes the
   * server does not have yet, so they go out the next time Deyslide is
   * online, and deletes it when the server refuses the deck for good.
   * Returns a function that stops following.
   */
  private keep(deckId: string, deck: { unsaved: Readonly<Ref<boolean>>, connection: DeckConnection, dropped: Ref<string>, copy?: DeckCopy, copyLoaded: Ref<boolean>, shown: Ref<number> }) {
    const { cache, userId } = this.kept!
    const { connection } = deck
    let following = true
    let deleting = false
    void deck.copy?.stored.then((stored) => {
      if (!stored || !following || deleting || this.copies.value.has(deckId))
        return
      this.copies.value = new Set([...this.copies.value, deckId])
      // Its changes are safe now: closing the tab need not ask.
      this.warnWhileWaiting()
    })
    // Changes wait for the server, or the server has everything the copy holds.
    // Until either is known, and after a failure, the mark stays as it is.
    const pending = () => connection.failure.value
      ? undefined
      : deck.unsaved.value || (deck.copyLoaded.value && connection.synced.value ? false : undefined)
    const stopNoting = watch(pending, (waiting) => {
      if (waiting !== undefined)
        void cache.markPending(userId, deckId, waiting)
    }, { immediate: true })
    // What becomes of the copy once the connection stopped for good.
    const fate = (failure: DeckFailure | undefined, shown: number) => {
      // Access removed or the deck deleted: the copy has nothing left to sync with.
      if (failure === 'refused')
        return 'delete'
      // Changes turned down (view only now, too big) would only be turned
      // down again. The copy goes once the person saw why, with the page
      // still open to download them; sent in the background, it waits for that.
      if (failure === 'turned-down')
        return shown > 0 ? 'delete' : 'hold'
      // A sign in that ended, a page or app out of date, or still working: the copy stays.
      return undefined
    }
    const stopRefusing = watch(() => fate(connection.failure.value, deck.shown.value), async (action) => {
      if (action === 'hold') {
        // Not sent again in the background.
        void cache.markPending(userId, deckId, false)
        return
      }
      if (action !== 'delete' || deleting)
        return
      deleting = true
      const hadChanges = connection.failure.value === 'turned-down' || (await cache.pending(userId)).includes(deckId)
      const copies = new Set(this.copies.value)
      const hadCopy = copies.delete(deckId) || Boolean(deck.copy?.holdsDeck) || (await cache.decks(userId)).includes(deckId)
      this.copies.value = copies
      if (hadCopy)
        deck.dropped.value = hadChanges ? `${COPY_DELETED} ${DOWNLOAD_TO_KEEP}` : COPY_DELETED
      await deck.copy?.close()
      await cache.deleteDeck(userId, deckId)
      void this.refresh().catch(() => {})
    }, { immediate: true })
    return () => {
      following = false
      stopNoting()
      stopRefusing()
    }
  }

  /**
   * Sends the changes kept on this device that the server does not have
   * yet, made offline before the page last closed. Each deck joins its
   * room in the background and lets go once the server has them.
   */
  private async sendPending() {
    if (!this.kept)
      return
    for (const deckId of await this.kept.cache.pending(this.kept.userId)) {
      if (this.closed || this.live.has(deckId))
        continue
      const deck = this.hold(deckId)
      // The copy's changes reach the connection as the copy loads, so the server has them once it confirmed everything after that.
      const done = () => deck.connection.status.value === 'failed' || (deck.copyLoaded.value && deck.connection.synced.value && !deck.unsaved.value)
      const stop = watch(done, (finished) => {
        if (!finished)
          return
        // After this change has run its course, not in the middle of it.
        queueMicrotask(() => {
          stop()
          this.letGo(deckId, deck)
        })
      })
    }
  }

  /** Lets go of every deck and stops asking the server, as the account leaves this page. Nothing is sent after this. */
  async close() {
    this.closed = true
    this.stopRetrying?.()
    if (typeof window !== 'undefined')
      window.removeEventListener('offline', this.wentOffline)
    const decks = [...this.live.values()]
    this.live.clear()
    this.sessions.clear()
    this.waiting.clear()
    this.warnWhileWaiting()
    for (const deck of decks) {
      deck.stopWaiting?.()
      deck.stop()
      deck.connection.destroy()
      deck.awareness.destroy()
      await deck.copy?.close()
      deck.doc.destroy()
    }
  }

  /**
   * Closes the deck's document once no session uses it. Changes made here
   * that the server does not have yet (made offline, say) keep it open until
   * they reach the server, so leaving the deck never drops them.
   */
  private letGo(deckId: string, deck: LiveDeck) {
    if (--deck.users > 0)
      return
    // Others stop seeing this page at once.
    deck.awareness.setLocalState(null)
    const close = () => {
      if (deck.users > 0)
        return
      deck.stopWaiting?.()
      this.live.delete(deckId)
      deck.stop()
      deck.connection.destroy()
      deck.awareness.destroy()
      void deck.copy?.close()
      deck.doc.destroy()
    }
    if (!deck.unsaved.value) {
      close()
      return
    }
    const stop = watch(deck.unsaved, (unsaved) => {
      if (!unsaved)
        close()
    })
    deck.stopWaiting = () => {
      stop()
      deck.stopWaiting = undefined
      this.waiting.delete(deck)
      this.warnWhileWaiting()
    }
    this.waiting.add(deck)
    this.warnWhileWaiting()
  }

  /**
   * Closing the tab would drop changes that wait for the server, so the
   * browser asks first. Decks with a copy on this device lose nothing.
   */
  private warnWhileWaiting() {
    if (typeof window === 'undefined')
      return
    if ([...this.waiting].some(deck => !this.keptOnDevice(deck.id)))
      window.addEventListener('beforeunload', this.warnOnClose)
    else
      window.removeEventListener('beforeunload', this.warnOnClose)
  }

  /** The deck's document in this page, once it holds the deck. */
  private loadedDeck(deckId: string) {
    const deck = this.live.get(deckId)
    return deck?.loaded.value ? deck : undefined
  }

  async readDeck(deckId: string): Promise<Deck> {
    const { readDeckDoc } = await loadModel()
    const live = this.loadedDeck(deckId)
    if (live)
      return readDeckDoc(live.doc)
    const state = await this.api.deckState(deckId)
    const doc = new Y.Doc()
    try {
      Y.applyUpdate(doc, state)
      return readDeckDoc(doc)
    }
    finally {
      doc.destroy()
    }
  }

  async saveDeck(_projectId: string, deckId: string, deck: Deck) {
    const { applyDeck, deckToYDoc } = await loadModel()
    const live = this.loadedDeck(deckId)
    if (live) {
      const { connection } = live
      // The server would turn the change down, or never get it.
      if (live.readOnly.value)
        throw new StoreError(live.error.value || 'This deck can only be viewed here right now, so the change was not saved.')
      // The open deck syncs the change to the server and everyone else.
      applyDeck(live.doc, deck, EXTERNAL_ORIGIN)
      await connection.flush()
      return
    }
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
