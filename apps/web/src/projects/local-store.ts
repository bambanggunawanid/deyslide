import type { Deck } from '@deyslide/deck-model'
import type { Router } from 'vue-router'
import type { DeckSession, OpenDeckOptions, SessionStatus } from '../deck/session'
import type { DeckTemplate } from '../guest/templates'
import type { DeckSummary, Project } from '../guest/types'
import type { LocalDeckInfo, LocalProjectInfo, WriteDeckResult } from '../platform/native'
import type { ProjectStore } from './types'
import { applyDeck, applyMarkdown, DeckMarkdownError, deckMarkdown, mergeMarkdown, newMergeWriter, parseMarkdown, readDeckDoc, repairDeckDoc, toMarkdown } from '@deyslide/deck-model'
import { computed, ref, shallowRef } from 'vue'
import { Awareness } from 'y-protocols/awareness'
import * as Y from 'yjs'
import { createDeckSession, EXTERNAL_ORIGIN } from '../deck/session'
import { deckFromTemplate } from '../guest/templates'
import {
  libraryCreateDeck,
  libraryCreateProject,
  libraryDeleteDeck,
  libraryDeleteProject,
  libraryList,
  libraryReadDeck,
  libraryRenameDeck,
  libraryRenameProject,
  libraryWriteDeck,
  onDeckChanged,
  onLibraryChanged,
} from '../platform/native'
import { cleanName, StoreError } from './names'

// Decks saved as Markdown files in the app's library folder, where Claude
// Code edits them too (through `deyslide mcp`). The app lists the folder,
// reads and writes files with compare and swap, and says when a file
// changes on disk. An open deck is a live document like any other: what
// the person does is written to its file a moment later, and changes made
// to the file meanwhile are merged in, so neither side loses work.

/** How long after a change in the page its deck file is written. */
const WRITE_DELAY_MS = 400

/** Writes in a row that may find the file changed again before writing tries again later. */
const WRITE_ATTEMPTS = 5

/** The longest wait before a write that failed is tried again. Each failure doubles the wait, from the write delay up. */
const RETRY_MAX_MS = 30_000

const MOVED = 'This deck was moved or renamed on disk.'

const brokenFile = (message: string) => `The file on disk has an error: ${message}`

/** The app's commands fail with a message already written for people. */
function messageOf(error: unknown) {
  if (typeof error === 'string' && error)
    return error
  return error instanceof Error ? error.message : 'The Deyslide folder could not be read or changed.'
}

async function command<T>(call: Promise<T>): Promise<T> {
  try {
    return await call
  }
  catch (error) {
    throw error instanceof StoreError ? error : new StoreError(messageOf(error))
  }
}

/** The deck as people edit it, for an encoded state. */
function markdownOf(state: Uint8Array) {
  const doc = new Y.Doc()
  try {
    Y.applyUpdate(doc, state)
    return deckMarkdown(doc)
  }
  finally {
    doc.destroy()
  }
}

function toSummary(deck: LocalDeckInfo): DeckSummary {
  return { id: deck.id, name: deck.name, slideCount: deck.slideCount, createdAt: deck.createdAt, updatedAt: deck.updatedAt }
}

function toProject(project: LocalProjectInfo): Project {
  return {
    id: project.id,
    name: project.name,
    createdAt: project.createdAt,
    // A folder's time changes when files come and go, not when a deck in it is edited.
    updatedAt: Math.max(project.updatedAt, ...project.decks.map(deck => deck.updatedAt)),
    decks: project.decks.map(toSummary),
  }
}

/** Old ids and the new ids they became, after a rename in the app. */
export interface LocalMove {
  projects: Record<string, string>
  decks: Record<string, string>
}

export interface LocalStoreOptions {
  /** How long after a change in the page its deck file is written. */
  writeDelayMs?: number
}

/**
 * An open deck's file and its live document, shared by every session that
 * has it open and by the store's own reads and saves. It outlives its last
 * session while it holds changes the file does not have yet (the file had
 * an error, the deck went missing, or writing failed), so leaving a deck
 * never drops them: they are written once the file can take them.
 *
 * `base` is the document's state when it last matched the file, and
 * `content` the text the file held then. Changes in the page are written
 * against `content` (compare and swap); when the file holds something else,
 * that text is merged in as a change made since `base`, and the write goes
 * again. The file is only written when the deck says something other than
 * the file: a write that only changed formatting would make Claude Code
 * read the deck again.
 */
class DeckFile {
  /** Changes when the deck is renamed in the app. */
  id: string
  readonly doc = new Y.Doc()
  /** Sessions and store calls using it. */
  users = 0
  /** The document holds the deck: the file was read once. */
  readonly ready = ref(false)
  /** True while the deck is missing from the library. Nothing is written then. */
  readonly gone = ref(false)
  /** The deck and project as last listed, so the page can still show a deck that went missing. */
  listed?: { project: Project, deck: DeckSummary }
  readonly error = computed(() => {
    if (this.gone.value)
      return MOVED
    return this.broken.value ? brokenFile(this.broken.value) : this.writeError.value
  })

  readonly status = computed<SessionStatus>(() => {
    if (this.error.value)
      return 'failed'
    return this.unsaved.value || this.writing.value ? 'saving' : 'saved'
  })

  readonly readOnly = computed(() => this.gone.value)
  /** The first read of the file. Fails when the deck cannot be read at all. */
  readonly opened: Promise<void>
  /** Changes in the page that are not in the file yet. */
  private readonly unsaved = ref(false)
  private readonly writing = ref(false)
  /** Why the file on disk cannot be read as a deck, while it cannot. Writing waits meanwhile. */
  private readonly broken = ref('')
  private readonly writeError = ref('')
  private content: string | null = null
  private base?: Uint8Array
  private baseMarkdown = ''
  /** One fork writer for every merge from the file, so the document gains one client, not one per merge. */
  private readonly writer = newMergeWriter()
  private timer: ReturnType<typeof setTimeout> | undefined
  /** The next try of a write that failed or kept finding the file changed. */
  private retryTimer: ReturnType<typeof setTimeout> | undefined
  /** Failed writes in a row, which make the next try wait longer. */
  private retries = 0
  /** File work runs one step at a time. */
  private line: Promise<unknown> = Promise.resolve()
  private destroyed = false

  constructor(
    id: string,
    private readonly delay: number,
    private readonly lost: () => Promise<void>,
    /** Every change made so far is in the file. */
    private readonly written: (file: DeckFile) => void,
  ) {
    this.id = id
    this.doc.on('update', this.changed)
    this.opened = this.run(async () => this.load(await libraryReadDeck(this.id)))
  }

  /** Runs `task` after every file step before it. */
  run<T>(task: () => Promise<T> | T): Promise<T> {
    const result = this.line.then(task)
    this.line = result.catch(() => {})
    return result
  }

  /** Changes made in the page that are not in the file yet, a write on its way included. */
  get unwritten() {
    return this.unsaved.value || this.writing.value
  }

  /** Writes the changes made in the page now, rather than a moment later. */
  save() {
    return this.run(() => this.write())
  }

  /** Writes pending changes, then runs `task` before any other file step, such as a rename. */
  exclusive<T>(task: () => Promise<T>): Promise<T> {
    return this.run(async () => {
      await this.write()
      return task()
    })
  }

  /** The file changed on disk: reads it and merges what changed. */
  fileChanged() {
    return this.run(async () => {
      if (this.destroyed || this.gone.value)
        return
      let current: string
      try {
        current = await libraryReadDeck(this.id)
      }
      catch {
        // Gone or unreadable: the next listing of the library says which.
        return
      }
      if (current === this.content)
        return
      if (!this.ready.value) {
        this.load(current)
        return
      }
      if (this.takeIn(current))
        await this.write()
    })
  }

  /** Makes the deck hold `deck`, then writes it. */
  replace(deck: Deck) {
    return this.run(async () => {
      if (!this.ready.value || this.broken.value)
        throw new StoreError(this.error.value || 'The deck is not loaded yet.')
      if (this.gone.value)
        throw new StoreError(MOVED)
      applyDeck(this.doc, deck, EXTERNAL_ORIGIN)
      await this.write()
    })
  }

  /** The library listed the deck, or no longer does. */
  present(here: boolean) {
    if (!here) {
      this.gone.value = true
      return
    }
    if (!this.gone.value)
      return
    this.gone.value = false
    // Back, say after switching branches: read it, then write what waited.
    void this.fileChanged().then(() => {
      if (this.unsaved.value)
        return this.save()
    })
  }

  destroy() {
    if (this.destroyed)
      return
    this.destroyed = true
    clearTimeout(this.timer)
    clearTimeout(this.retryTimer)
    this.timer = undefined
    this.retryTimer = undefined
    this.doc.off('update', this.changed)
    this.doc.destroy()
  }

  /** Every change except loads and merges from the file is the person's, so it is written. */
  private readonly changed = (_update: Uint8Array, origin: unknown) => {
    if (origin === EXTERNAL_ORIGIN || !this.ready.value || this.destroyed)
      return
    this.unsaved.value = true
    this.timer ??= setTimeout(() => {
      this.timer = undefined
      void this.save()
    }, this.delay)
  }

  /** Fills the document from the file's first readable content. */
  private load(content: string) {
    try {
      applyMarkdown(this.doc, content, EXTERNAL_ORIGIN, { create: true })
    }
    catch (error) {
      if (!(error instanceof DeckMarkdownError))
        throw error
      // The same text is not read twice; a later change on disk tries again.
      this.content = content
      this.broken.value = error.message
      return
    }
    repairDeckDoc(this.doc, EXTERNAL_ORIGIN)
    this.base = Y.encodeStateAsUpdate(this.doc)
    this.baseMarkdown = deckMarkdown(this.doc)
    this.content = content
    this.broken.value = ''
    this.ready.value = true
  }

  /**
   * Merges what the file holds as a change made since `base`, keeping the
   * page's own changes. Returns false, changing nothing, when the file does
   * not read as a deck.
   */
  private takeIn(current: string) {
    try {
      const { textBase } = mergeMarkdown(this.doc, this.base!, current, EXTERNAL_ORIGIN, { writer: this.writer })
      this.base = textBase
      this.baseMarkdown = markdownOf(textBase)
    }
    catch (error) {
      if (!(error instanceof DeckMarkdownError))
        throw error
      this.content = current
      this.broken.value = error.message
      return false
    }
    this.content = current
    this.broken.value = ''
    return true
  }

  /** Writes the deck when it differs from the file. Waits while the file has an error or the deck is missing. */
  private async write() {
    clearTimeout(this.timer)
    clearTimeout(this.retryTimer)
    this.timer = undefined
    this.retryTimer = undefined
    if (!this.ready.value || this.broken.value || this.gone.value || this.destroyed)
      return
    await this.writeAttempts()
    if (this.unsaved.value)
      this.retryLater()
    else
      this.written(this)
  }

  /** Writes until the file takes the deck, it fails, or it keeps changing. Leaves `unsaved` set when the deck is not written. */
  private async writeAttempts() {
    for (let attempt = 0; attempt < WRITE_ATTEMPTS; attempt++) {
      // The text and the state it comes from, taken together.
      const markdown = deckMarkdown(this.doc)
      const state = Y.encodeStateAsUpdate(this.doc)
      this.unsaved.value = false
      if (markdown === this.baseMarkdown) {
        this.writeError.value = ''
        this.retries = 0
        return
      }
      this.writing.value = true
      let result: WriteDeckResult
      try {
        result = await libraryWriteDeck(this.id, markdown, this.content)
      }
      catch (error) {
        this.unsaved.value = true
        this.writeError.value = messageOf(error)
        // A deck renamed on disk fails to write: the listing says so.
        void this.lost()
        return
      }
      finally {
        this.writing.value = false
      }
      if ('ok' in result) {
        this.content = markdown
        this.base = state
        this.baseMarkdown = markdown
        this.writeError.value = ''
        this.retries = 0
        return
      }
      // Someone wrote the file since it was read: take that in, then write both.
      if (!this.takeIn(result.current)) {
        // The file now has an error. Its next change on disk brings the write back.
        this.unsaved.value = true
        return
      }
    }
    // The file kept changing under every write.
    this.unsaved.value = true
  }

  /** Tries a write that did not happen again, waiting longer after each failure in a row. */
  private retryLater() {
    if (this.broken.value || this.gone.value || this.destroyed)
      return
    const wait = Math.min(RETRY_MAX_MS, this.delay * 2 ** this.retries)
    this.retries++
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined
      void this.save()
    }, wait)
  }
}

/**
 * The projects and decks in the app's library folder: each project a
 * folder, each deck a Markdown file in it. Ids start with `local-` and
 * change when a project or deck is renamed.
 */
export class LocalStore implements ProjectStore {
  /** Why the library folder could not be listed, or empty when it could. */
  readonly problem = shallowRef('')
  private listed: Project[] = []
  private projects: Project[] = []
  private readonly listeners = new Set<() => void>()
  private readonly movers = new Set<(move: LocalMove) => void>()
  /** Decks open in this page, or holding changes not written yet, by id. Reads and saves go through their documents. */
  private readonly held = new Map<string, DeckFile>()
  /** Open sessions and the deck file each one shows. */
  private readonly sessions = new Map<DeckSession, DeckFile>()
  /** Counts listings, so an older one that answers late is dropped. */
  private listing = 0
  private readonly writeDelay: number
  private stopEvents: () => void = () => {}

  private constructor(options: LocalStoreOptions) {
    this.writeDelay = options.writeDelayMs ?? WRITE_DELAY_MS
  }

  /** Lists the library and follows its changes on disk. */
  static async open(options: LocalStoreOptions = {}) {
    const store = new LocalStore(options)
    const stopLibrary = await onLibraryChanged(() => void store.refresh())
    const stopDecks = await onDeckChanged(({ deckId }) => void store.held.get(deckId)?.fileChanged())
    store.stopEvents = () => {
      stopLibrary()
      stopDecks()
    }
    await store.refresh()
    return store
  }

  /** Stops following the library. Open decks stay as they are; changes kept for decks nobody has open are dropped. */
  close() {
    this.stopEvents()
    for (const file of [...this.held.values()])
      this.release(file, { drop: true })
  }

  /**
   * Writes every deck's changes now, typing in open pages included, as the
   * app's window closes. Resolves with the names of the decks whose last
   * changes are still not in their files.
   */
  async flushAll(): Promise<string[]> {
    await Promise.all([...this.sessions.keys()].map(session => session.flush().catch(() => {})))
    await Promise.all([...this.held.values()].map(file => file.save().catch(() => {})))
    const left = new Set([...this.held.values()].filter(file => file.unwritten))
    // Typing a Markdown view still has after the flush is held back by a problem in its Markdown.
    for (const [session, file] of this.sessions) {
      if (session.typingPending.value)
        left.add(file)
    }
    return [...left].map(file => file.listed?.deck.name ?? 'a deck')
  }

  onChange(listener: () => void) {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** Hears about projects and decks renamed in the app, with their new ids. */
  onMove(listener: (move: LocalMove) => void) {
    this.movers.add(listener)
    return () => this.movers.delete(listener)
  }

  /** Lists the library folder again. */
  async refresh() {
    const ticket = ++this.listing
    let list: LocalProjectInfo[]
    try {
      list = await libraryList()
    }
    catch (error) {
      if (ticket === this.listing) {
        this.problem.value = messageOf(error)
        this.notify()
      }
      return
    }
    if (ticket !== this.listing)
      return
    this.problem.value = ''
    this.listed = list.map(toProject)
    for (const file of this.held.values()) {
      const project = this.listed.find(item => item.decks.some(deck => deck.id === file.id))
      const deck = project?.decks.find(item => item.id === file.id)
      if (project && deck)
        file.listed = { project, deck }
      file.present(Boolean(deck))
    }
    this.notify()
  }

  /** Projects, most recently changed first. */
  listProjects(): Project[] {
    return [...this.projects].sort((a, b) => b.updatedAt - a.updatedAt)
  }

  /** Nothing on this device is shared. */
  listShared(): Project[] {
    return []
  }

  getProject(projectId: string) {
    return this.projects.find(project => project.id === projectId)
  }

  getDeck(projectId: string, deckId: string) {
    return this.getProject(projectId)?.decks.find(deck => deck.id === deckId)
  }

  async createProject(name: string): Promise<Project> {
    const created = await command(libraryCreateProject(cleanName(name, 'project')))
    await this.refresh()
    return this.getProject(created.id) ?? toProject(created)
  }

  async renameProject(projectId: string, name: string) {
    const project = this.requireProject(projectId)
    const projectName = cleanName(name, 'project')
    const open = [...this.held.values()].filter(file => project.decks.some(deck => deck.id === file.id))
    const move = await this.whileHeld(open, async () => {
      const renamed = await command(libraryRenameProject(projectId, projectName))
      // Deck files keep their names, so each deck's new id is found by name.
      const decks: Record<string, string> = {}
      for (const deck of project.decks) {
        const moved = renamed.decks.find(item => item.name === deck.name)
        if (moved)
          decks[deck.id] = moved.id
      }
      for (const [from, to] of Object.entries(decks))
        this.rekey(from, to)
      return { projects: { [projectId]: renamed.id }, decks }
    })
    await this.refresh()
    this.announce(move)
  }

  async deleteProject(projectId: string) {
    const project = this.requireProject(projectId)
    await command(libraryDeleteProject(projectId))
    // Changes kept for its decks go with them.
    for (const deck of project.decks) {
      const file = this.held.get(deck.id)
      if (file)
        this.release(file, { drop: true })
    }
    await this.refresh()
  }

  async createDeck(projectId: string, name: string, template: DeckTemplate): Promise<DeckSummary> {
    this.requireProject(projectId)
    const deckName = cleanName(name, 'deck')
    const content = await deckFromTemplate(template, deckName)
    // Files hold plain Slidev Markdown, without slide ids.
    const created = await command(libraryCreateDeck(projectId, deckName, toMarkdown(content, { ids: false })))
    await this.refresh()
    return this.getDeck(projectId, created.id) ?? toSummary(created)
  }

  async renameDeck(projectId: string, deckId: string, name: string) {
    this.requireDeck(projectId, deckId)
    const deckName = cleanName(name, 'deck')
    const open = this.held.get(deckId)
    const renamed = await this.whileHeld(open ? [open] : [], async () => {
      const deck = await command(libraryRenameDeck(deckId, deckName))
      this.rekey(deckId, deck.id)
      return deck
    })
    await this.refresh()
    this.announce({ projects: {}, decks: { [deckId]: renamed.id } })
  }

  async deleteDeck(projectId: string, deckId: string) {
    this.requireDeck(projectId, deckId)
    const file = this.held.get(deckId)
    // A deck that went missing on disk while it held changes is only in the app now: deleting it drops them.
    if (!file?.gone.value)
      await command(libraryDeleteDeck(deckId))
    if (file)
      this.release(file, { drop: true })
    await this.refresh()
  }

  async openDeck(projectId: string, deckId: string, options: OpenDeckOptions = {}): Promise<DeckSession> {
    this.requireDeck(projectId, deckId)
    const file = this.hold(deckId)
    try {
      await file.opened
    }
    catch (error) {
      this.letGo(file)
      throw new StoreError(messageOf(error))
    }
    // Presence stays on this page: nobody else sees a device's decks.
    const awareness = new Awareness(file.doc)
    let closed = false
    const session = createDeckSession(file.doc, awareness, {
      status: file.status,
      error: file.error,
      ready: file.ready,
      readOnly: file.readOnly,
      flush: () => file.save(),
      close: () => {
        if (closed)
          return
        closed = true
        this.sessions.delete(session)
        awareness.destroy()
        this.letGo(file)
      },
    }, options)
    this.sessions.set(session, file)
    return session
  }

  async readDeck(deckId: string): Promise<Deck> {
    const open = this.held.get(deckId)
    if (open?.ready.value)
      return readDeckDoc(open.doc)
    const content = await command(libraryReadDeck(deckId))
    try {
      return parseMarkdown(content).deck
    }
    catch (error) {
      if (error instanceof DeckMarkdownError)
        throw new StoreError(brokenFile(error.message))
      throw error
    }
  }

  async saveDeck(projectId: string, deckId: string, deck: Deck) {
    this.requireDeck(projectId, deckId)
    const file = this.hold(deckId)
    try {
      await command(file.opened)
      await file.replace(deck)
    }
    finally {
      this.letGo(file)
    }
  }

  /** The open deck's Markdown, or the file as it is on disk. */
  async deckMarkdown(deckId: string) {
    const open = this.held.get(deckId)
    if (open?.ready.value)
      return deckMarkdown(open.doc)
    return command(libraryReadDeck(deckId))
  }

  /** The deck's file, opened for the first user and shared after that. */
  private hold(deckId: string) {
    let file = this.held.get(deckId)
    if (!file) {
      file = new DeckFile(deckId, this.writeDelay, () => this.refresh(), (written) => {
        // Kept only for its changes, it goes once they are written.
        if (written.users === 0)
          void written.run(() => this.release(written))
      })
      this.held.set(deckId, file)
      // Known from the listing, in case the deck goes missing while open.
      const project = this.projects.find(item => item.decks.some(deck => deck.id === deckId))
      const deck = project?.decks.find(item => item.id === deckId)
      if (project && deck)
        file.listed = { project, deck }
    }
    file.users++
    return file
  }

  /**
   * Writes what is left once nobody uses the deck, then closes its
   * document, unless it holds changes the file could not take yet.
   */
  private letGo(file: DeckFile) {
    if (--file.users > 0)
      return
    void file.save().catch(() => {}).finally(() => this.release(file))
  }

  /** Closes a deck's document nobody uses, once its changes are written, or at once with `drop`. */
  private release(file: DeckFile, { drop = false } = {}) {
    if (file.users > 0 || (file.unwritten && !drop) || this.held.get(file.id) !== file)
      return
    this.held.delete(file.id)
    file.destroy()
    // A deck kept on show while missing goes away with it.
    if (file.gone.value)
      this.notify()
  }

  /** Runs `task` while none of `files` reads or writes, each with its changes written first. */
  private whileHeld<T>(files: DeckFile[], task: () => Promise<T>): Promise<T> {
    const [first, ...rest] = files
    return first ? first.exclusive(() => this.whileHeld(rest, task)) : task()
  }

  /** An open deck renamed in the app keeps its document under its new id. */
  private rekey(from: string, to: string) {
    const file = this.held.get(from)
    if (!file || from === to)
      return
    this.held.delete(from)
    file.id = to
    this.held.set(to, file)
    // A listing from before the rename would call the deck missing.
    this.listing++
  }

  private announce(move: LocalMove) {
    const changed = (ids: Record<string, string>) => Object.entries(ids).some(([from, to]) => from !== to)
    if (!changed(move.projects) && !changed(move.decks))
      return
    for (const listener of this.movers)
      listener(move)
  }

  /**
   * The listed projects, plus decks open in this page that went missing
   * from the library, so their page can say so rather than lose them.
   */
  private notify() {
    const projects = this.listed.map(project => ({ ...project, decks: [...project.decks] }))
    for (const file of this.held.values()) {
      if (!file.gone.value || !file.listed)
        continue
      const { project, deck } = file.listed
      let shown = projects.find(item => item.id === project.id)
      if (!shown) {
        shown = { ...project, decks: [] }
        projects.push(shown)
      }
      if (!shown.decks.some(item => item.id === deck.id))
        shown.decks.push(deck)
    }
    this.projects = projects
    for (const listener of this.listeners)
      listener()
  }

  private requireProject(projectId: string) {
    const project = this.getProject(projectId)
    if (!project)
      throw new StoreError('That project is no longer in the Deyslide folder')
    return project
  }

  private requireDeck(projectId: string, deckId: string) {
    const deck = this.getDeck(projectId, deckId)
    if (!deck)
      throw new StoreError('That deck is no longer in the Deyslide folder')
    return deck
  }
}

/**
 * Keeps the page on a project or deck the person renamed: renaming changes
 * its id, so the address moves to the new one.
 */
export function followMoves(store: LocalStore, router: Router) {
  return store.onMove((move) => {
    const route = router.currentRoute.value
    const params = { ...route.params }
    let moved = false
    for (const [key, ids] of [['projectId', move.projects], ['deckId', move.decks]] as const) {
      const current = params[key]
      const next = typeof current === 'string' ? ids[current] : undefined
      if (next && next !== current) {
        params[key] = next
        moved = true
      }
    }
    if (moved && route.name)
      void router.replace({ name: route.name, params, query: route.query, hash: route.hash })
  })
}
