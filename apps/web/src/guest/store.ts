import type { Deck } from '@deyslide/deck-model'
import type { DeckSession, OpenDeckOptions } from '../deck/session'
import type { ExportedProject, ProjectStore } from '../projects/types'
import type { DeckTemplate } from './templates'
import type { DeckSummary, GuestIndex, GuestStorage, OpenDeck, Project } from './types'
import { ref } from 'vue'
import { Awareness } from 'y-protocols/awareness'
import * as Y from 'yjs'
import { createDeckSession, EXTERNAL_ORIGIN, holdsDeck } from '../deck/session'
import { toBase64 } from '../projects/base64'
import { cleanName, StoreError } from '../projects/names'
import { deckFromTemplate } from './templates'

/** The deck model is large, so it loads the first time a deck is touched. */
const loadModel = () => import('@deyslide/deck-model')

/** How often an open deck's slide count and time of change reach the project list, at most. */
const SUMMARY_DELAY_MS = 500

export interface GuestStoreOptions {
  now?: () => number
  newId?: () => string
}

/** A deck document held open for everyone using it: sessions, reads and saves. */
interface HeldDeck {
  users: number
  opened: Promise<OpenDeck>
  /** Stops following the document's changes, writing the summary still due. */
  stop?: () => void
}

/**
 * A guest's projects and decks. Keeps the index in memory, writes every
 * change through to storage, and tells listeners so the UI can refresh.
 */
export class GuestStore implements ProjectStore {
  private index: GuestIndex = { version: 1, projects: [] }
  private readonly listeners = new Set<() => void>()
  private readonly now: () => number
  private readonly newId: () => string
  /** One document per open deck, shared by every caller until the last one lets go. */
  private readonly held = new Map<string, HeldDeck>()

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
  /** Guests have nothing shared with them. */
  listShared(): Project[] {
    return []
  }

  listProjects(): Project[] {
    // Copies: the store changes its own objects in place, and pages must see each listing as new.
    return this.index.projects
      .map(project => ({ ...project, decks: project.decks.map(deck => ({ ...deck })) }))
      .sort((a, b) => b.updatedAt - a.updatedAt)
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

  async openDeck(projectId: string, deckId: string, options: OpenDeckOptions = {}): Promise<DeckSession> {
    this.requireDeck(projectId, deckId)
    const open = await this.hold(deckId)
    if (!holdsDeck(open.doc)) {
      await this.letGo(deckId)
      throw new StoreError('This deck has no content in this browser')
    }
    // Presence stays on this page: nobody else sees a browser's decks.
    const awareness = new Awareness(open.doc)
    let closed = false
    return createDeckSession(open.doc, awareness, {
      // The document is in storage already, and every change is kept as it happens.
      status: ref('saved'),
      error: ref(''),
      ready: ref(true),
      readOnly: ref(false),
      flush: () => open.flush(),
      close: () => {
        if (closed)
          return
        closed = true
        awareness.destroy()
        void this.letGo(deckId)
      },
    }, options)
  }

  async readDeck(deckId: string): Promise<Deck> {
    const { readDeckDoc } = await loadModel()
    return this.withDeck(deckId, doc => readDeckDoc(doc))
  }

  async saveDeck(projectId: string, deckId: string, deck: Deck) {
    const summary = this.requireDeck(projectId, deckId)
    const { applyDeck } = await loadModel()
    // Only what differs changes, so an open session keeps its slides and typing.
    await this.withDeck(deckId, doc => applyDeck(doc, deck, EXTERNAL_ORIGIN, { create: !holdsDeck(doc) }))
    summary.slideCount = deck.slides.length
    summary.updatedAt = this.now()
    this.requireProject(projectId).updatedAt = summary.updatedAt
    await this.commit()
  }

  async deckMarkdown(deckId: string): Promise<string> {
    const { toMarkdown } = await loadModel()
    return toMarkdown(await this.readDeck(deckId))
  }

  /** Every project with its decks' content, for moving into an account. */
  async exportProjects(): Promise<ExportedProject[]> {
    const exported: ExportedProject[] = []
    for (const project of this.index.projects) {
      const decks = []
      for (const deck of project.decks) {
        const state = await this.withDeck(deck.id, doc => Y.encodeStateAsUpdate(doc))
        decks.push({ id: deck.id, name: deck.name, createdAt: deck.createdAt, updatedAt: deck.updatedAt, state: toBase64(state) })
      }
      exported.push({ id: project.id, name: project.name, createdAt: project.createdAt, updatedAt: project.updatedAt, decks })
    }
    return exported
  }

  /** Runs `read` on the deck's document, the open one when a session has it. */
  private async withDeck<T>(deckId: string, read: (doc: Y.Doc) => T): Promise<T> {
    const open = await this.hold(deckId)
    try {
      return read(open.doc)
    }
    finally {
      await this.letGo(deckId)
    }
  }

  /** The deck's shared document, opened from storage for the first user. */
  private async hold(deckId: string): Promise<OpenDeck> {
    let held = this.held.get(deckId)
    if (!held) {
      const created: HeldDeck = { users: 0, opened: this.storage.openDeck(deckId) }
      created.opened.then((open) => {
        created.stop = this.followSummary(deckId, open.doc)
      }, () => {})
      held = created
      this.held.set(deckId, held)
    }
    held.users++
    try {
      return await held.opened
    }
    catch (error) {
      await this.letGo(deckId)
      throw error
    }
  }

  /** Closes the deck's document once nobody uses it. */
  private async letGo(deckId: string) {
    const held = this.held.get(deckId)
    if (!held || --held.users > 0)
      return
    this.held.delete(deckId)
    const open = await held.opened.catch(() => undefined)
    held.stop?.()
    await open?.close()
  }

  /**
   * Keeps the deck's slide count and time of change in the project list up
   * to date while its document changes, a moment behind the changes.
   */
  private followSummary(deckId: string, doc: Y.Doc) {
    let timer: ReturnType<typeof setTimeout> | undefined
    const write = () => {
      timer = undefined
      const project = this.index.projects.find(item => item.decks.some(deck => deck.id === deckId))
      const summary = project?.decks.find(deck => deck.id === deckId)
      const slides = doc.getMap<unknown>('deck').get('slides')
      if (!project || !summary || !(slides instanceof Y.Array))
        return
      summary.slideCount = Math.max(1, slides.length)
      summary.updatedAt = this.now()
      project.updatedAt = summary.updatedAt
      void this.commit()
    }
    const changed = (_update: Uint8Array, origin: unknown) => {
      // A store save writes its own summary.
      if (origin !== EXTERNAL_ORIGIN && timer === undefined)
        timer = setTimeout(write, SUMMARY_DELAY_MS)
    }
    doc.on('update', changed)
    return () => {
      doc.off('update', changed)
      if (timer !== undefined) {
        clearTimeout(timer)
        write()
      }
    }
  }

  /** Removes every project and deck from the browser. */
  async clear() {
    await Promise.all(this.index.projects.flatMap(project => project.decks.map(deck => this.storage.deleteDeck(deck.id))))
    this.index.projects = []
    await this.commit()
  }

  private requireProject(projectId: string) {
    const project = this.getProject(projectId)
    if (!project)
      throw new StoreError('That project no longer exists')
    return project
  }

  private requireDeck(projectId: string, deckId: string) {
    const deck = this.getDeck(projectId, deckId)
    if (!deck)
      throw new StoreError('That deck no longer exists')
    return deck
  }

  private async commit() {
    await this.storage.saveIndex(this.index)
    for (const listener of this.listeners)
      listener()
  }
}
