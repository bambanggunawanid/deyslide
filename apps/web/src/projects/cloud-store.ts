import type { Deck } from '@deyslide/deck-model'
import type { Ref } from 'vue'
import type { DeckSession, OpenDeckOptions } from '../deck/session'
import type { DeckTemplate } from '../guest/templates'
import type { DeckSummary, Project } from '../guest/types'
import type { DeckConnection, ProjectApi } from './api'
import type { SharingApi } from './sharing'
import type { ExportedProject, ProjectStore } from './types'
import { computed, ref, watch } from 'vue'
import { Awareness } from 'y-protocols/awareness'
import * as Y from 'yjs'
import { createDeckSession, EXTERNAL_ORIGIN, holdsDeck } from '../deck/session'
import { deckFromTemplate } from '../guest/templates'
import { cleanName, StoreError } from './names'

/** The deck model is large, so it loads the first time a deck is touched. */
const loadModel = () => import('@deyslide/deck-model')

export interface CloudStoreOptions {
  /**
   * The token live editing sends on every connect. Browsers send `cookie`,
   * so the server reads the session cookie instead.
   */
  token?: () => Promise<string>
}

/**
 * A deck's live document in this page, shared by every session that has it
 * open and by the store's own reads and saves.
 */
interface LiveDeck {
  /** Sessions using it. */
  users: number
  doc: Y.Doc
  awareness: Awareness
  connection: DeckConnection
  /** The document holds the deck: it synced once. */
  loaded: Ref<boolean>
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
  private readonly warnOnClose = (event: BeforeUnloadEvent) => event.preventDefault()
  readonly sharing: SharingApi

  private constructor(api: ProjectApi, options: CloudStoreOptions) {
    this.api = api
    this.token = options.token ?? (async () => 'cookie')
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

  static async open(api: ProjectApi, options: CloudStoreOptions = {}) {
    const store = new CloudStore(api, options)
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

  async openDeck(_projectId: string, deckId: string, options: OpenDeckOptions = {}): Promise<DeckSession> {
    const deck = this.hold(deckId)
    const { connection } = deck
    let closed = false
    return createDeckSession(deck.doc, deck.awareness, {
      status: connection.status,
      error: connection.error,
      ready: computed(() => deck.loaded.value),
      readOnly: connection.readOnly,
      flush: () => connection.flush(),
      close: () => {
        if (closed)
          return
        closed = true
        this.letGo(deckId, deck)
      },
    }, options)
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
    const connection = this.api.connectDeck(deckId, doc, awareness, this.token)
    // The document holds the deck once the first sync brought it.
    const loaded = ref(false)
    const check = () => {
      loaded.value = connection.synced.value && holdsDeck(doc)
      if (loaded.value)
        doc.off('update', check)
    }
    doc.on('update', check)
    const stopChecking = watch(connection.synced, check, { immediate: true })
    // What the person may do changed (the server let them in again after a
    // role change): the project list says so too.
    const stopFollowing = watch(() => loaded.value && connection.readOnly.value, () => {
      void this.refresh().catch(() => {})
    })
    const deck: LiveDeck = {
      users: 1,
      doc,
      awareness,
      connection,
      loaded,
      stop: () => {
        stopChecking()
        stopFollowing()
        doc.off('update', check)
      },
    }
    this.live.set(deckId, deck)
    return deck
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
      deck.doc.destroy()
    }
    if (!deck.connection.unsaved.value) {
      close()
      return
    }
    const stop = watch(deck.connection.unsaved, (unsaved) => {
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

  /** Closing the tab would drop changes that wait for the server, so the browser asks first. */
  private warnWhileWaiting() {
    if (typeof window === 'undefined')
      return
    if (this.waiting.size > 0)
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
      if (connection.readOnly.value)
        throw new StoreError(connection.error.value || 'This deck can only be viewed here right now, so the change was not saved.')
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
