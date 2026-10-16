import type { MergeWriter, ParsedDeck, SourceSlide } from '@deyslide/deck-model'
import type { DeckDocuments } from '../collab/documents.ts'
import type { DeckSummary, Project, ProjectStore, SharedProject } from '../projects.ts'
import { applyDeck, deckMarkdown, DeckMarkdownError, frontmatterErrors, mergeMarkdown, newMergeWriter, parseMarkdown, readDeckDoc, splitSlides } from '@deyslide/deck-model'
import * as Y from 'yjs'
import { DeckDraft, MARKDOWN_MAX_LENGTH } from '../assistant/draft.ts'
import { DeckNotSavedError } from '../collab/documents.ts'
import { DeckGoneError } from '../collab/hocuspocus.ts'
import { DECK_MAX_SLIDES } from '../projects.ts'

/** A problem an agent can fix. The message says what went wrong and how to fix it. */
export class DeckInputError extends Error {}

/** Checks Markdown before it is saved: size, frontmatter YAML, the deck format and the slide count. */
export function checkMarkdown(markdown: string): ParsedDeck {
  if (markdown.length > MARKDOWN_MAX_LENGTH)
    throw new DeckInputError(`The deck is ${markdown.length} characters long. The limit is ${MARKDOWN_MAX_LENGTH}. Split it into several decks.`)
  const problems = frontmatterErrors(markdown)
  if (problems.length > 0)
    throw new DeckInputError(`The frontmatter is not valid YAML. ${problems.join(' ')}`)
  let parsed: ParsedDeck
  try {
    parsed = parseMarkdown(markdown)
  }
  catch (error) {
    throw new DeckInputError(error instanceof DeckMarkdownError ? error.message : `Deyslide cannot read this deck: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (parsed.deck.slides.length > DECK_MAX_SLIDES)
    throw new DeckInputError(`The deck has ${parsed.deck.slides.length} slides. The limit is ${DECK_MAX_SLIDES}. Split it into several decks.`)
  return parsed
}

const VIEW_ONLY = 'You can view this deck but not change it.'

/** How many reads the server remembers, and for how long, in all and for each person. */
export interface BaseLimits {
  lifetimeMs: number
  count: number
  bytes: number
  personCount: number
  personBytes: number
}

export const BASE_LIMITS: BaseLimits = {
  lifetimeMs: 60 * 60 * 1000,
  count: 1000,
  bytes: 100 * 1024 * 1024,
  // A share for each person, so nobody's reads push out everyone else's.
  personCount: 50,
  personBytes: 20 * 1024 * 1024,
}

interface Base {
  person: string
  state: Uint8Array
  until: number
}

/**
 * The deck state each Claude Code session last read or wrote, per deck. A
 * write merges Claude's Markdown against it, so what people changed in the
 * meantime survives. The least recently used entries go first: a person's
 * own when they hold more than their share, and past the total, those of
 * whoever holds the most.
 */
export class RecentBases {
  private readonly limits: BaseLimits
  private readonly entries = new Map<string, Base>()
  private readonly people = new Map<string, { count: number, bytes: number }>()
  private bytes = 0

  constructor(limits: BaseLimits = BASE_LIMITS) {
    this.limits = limits
  }

  get(key: string): Uint8Array | undefined {
    const entry = this.entries.get(key)
    if (!entry)
      return undefined
    this.forget(key)
    if (entry.until <= Date.now())
      return undefined
    // Back at the end, as the most recently used.
    this.add(key, entry)
    return entry.state
  }

  set(person: string, key: string, state: Uint8Array) {
    this.forget(key)
    this.add(key, { person, state, until: Date.now() + this.limits.lifetimeMs })
    const { personCount, personBytes, count, bytes } = this.limits
    while (this.usage(person).count > personCount || this.usage(person).bytes > personBytes)
      this.forgetOldest(person)
    while (this.entries.size > count || this.bytes > bytes)
      this.forgetOldest(this.largest())
  }

  private add(key: string, entry: Base) {
    this.entries.set(key, entry)
    const usage = this.usage(entry.person)
    this.people.set(entry.person, { count: usage.count + 1, bytes: usage.bytes + entry.state.byteLength })
    this.bytes += entry.state.byteLength
  }

  private forget(key: string) {
    const entry = this.entries.get(key)
    if (!entry)
      return
    this.entries.delete(key)
    this.bytes -= entry.state.byteLength
    const usage = this.usage(entry.person)
    if (usage.count <= 1)
      this.people.delete(entry.person)
    else
      this.people.set(entry.person, { count: usage.count - 1, bytes: usage.bytes - entry.state.byteLength })
  }

  private usage(person: string) {
    return this.people.get(person) ?? { count: 0, bytes: 0 }
  }

  private forgetOldest(person: string) {
    for (const [key, entry] of this.entries) {
      if (entry.person === person) {
        this.forget(key)
        return
      }
    }
  }

  /** The person whose remembered reads take the most bytes. */
  private largest() {
    let largest = ''
    let most = -1
    for (const [person, usage] of this.people) {
      if (usage.bytes > most) {
        largest = person
        most = usage.bytes
      }
    }
    return largest
  }
}

/** The deck as Markdown at an earlier state. */
function markdownAt(state: Uint8Array) {
  const doc = new Y.Doc()
  try {
    Y.applyUpdate(doc, state)
    return deckMarkdown(doc)
  }
  finally {
    doc.destroy()
  }
}

/** The slide ids of the deck at an earlier state, in order. */
function slideIdsAt(state: Uint8Array) {
  const doc = new Y.Doc()
  try {
    Y.applyUpdate(doc, state)
    return readDeckDoc(doc).slides.map(slide => slide.id)
  }
  finally {
    doc.destroy()
  }
}

/** The live deck: its Markdown, and each slide's text and id in order. */
interface LiveSlides {
  markdown: string
  slides: SourceSlide[]
  ids: string[]
}

function liveSlides(doc: Y.Doc): LiveSlides {
  const markdown = deckMarkdown(doc)
  return { markdown, slides: splitSlides(markdown), ids: readDeckDoc(doc).slides.map(slide => slide.id) }
}

/**
 * The live deck's slides, numbered the way one Claude Code session knows
 * the deck: by the version it last read or wrote. Its slide numbers then
 * keep meaning the slides it was shown, whatever people add, delete or
 * move meanwhile, until it reads the deck again.
 */
export interface SlideNumbering {
  /** The live slide for each number Claude knows, or undefined when someone deleted it. */
  slides: (SourceSlide | undefined)[]
  /** Live slides Claude has not read, which people added since. */
  added: SourceSlide[]
  /** True when the numbers are the live deck's own: nothing was added, deleted or moved. */
  same: boolean
  /** The live deck's first slide, whose frontmatter holds the deck settings. */
  first?: SourceSlide
}

function numberSlides(live: LiveSlides, known: Uint8Array | undefined): SlideNumbering {
  const own = { slides: live.slides, added: [], same: true, first: live.slides[0] }
  // Slides the Markdown split and the document disagree on are numbered as they stand.
  if (!known || live.ids.length !== live.slides.length)
    return own
  const ids = slideIdsAt(known)
  if (ids.length === live.ids.length && ids.every((id, index) => id === live.ids[index]))
    return own
  const byId = new Map(live.ids.map((id, index) => [id, live.slides[index]!]))
  const shown = new Set(ids)
  return {
    slides: ids.map(id => byId.get(id)),
    added: live.ids.filter(id => !shown.has(id)).map(id => byId.get(id)!),
    same: false,
    first: live.slides[0],
  }
}

/** Undefined when the deck was deleted while the call ran. */
async function unlessGone<T>(work: Promise<T>): Promise<T | undefined> {
  try {
    return await work
  }
  catch (error) {
    if (error instanceof DeckGoneError)
      return undefined
    throw error
  }
}

/** Who reads or writes: a person, and the Claude Code session they work in when it is known. */
export interface Reader {
  userId: string
  session?: string
}

function baseKey({ userId, session = '' }: Reader, deckId: string) {
  return `${userId}\n${session}\n${deckId}`
}

/** What a write did. */
export interface DeckWrite {
  /** The deck as it is now, with what people changed while Claude worked. */
  markdown: string
  /** Its slides, numbered the way the session that wrote now knows the deck. */
  numbering: SlideNumbering
  /**
   * True when Claude's Markdown replaced the deck instead of being merged
   * with a version Claude read: there was no read on record, or the deck
   * no longer holds that version.
   */
  replaced: boolean
}

/** A change made inside a deck's live room, and the state Claude's text now corresponds to. */
interface Change {
  textBase: Uint8Array
  replaced: boolean
  live: LiveSlides
}

/**
 * Decks as Slidev Markdown, for MCP clients. It goes through the same store
 * as the web app, so every call only reaches the signed in person's decks,
 * and through each deck's live room, so Claude reads what people see now
 * and its writes reach open editors at once.
 */
export class MarkdownDecks {
  private readonly projects: ProjectStore
  private readonly documents: DeckDocuments
  private readonly publicUrl: string
  private readonly bases: RecentBases
  /** One merge writer per deck, so Claude's writes do not grow the deck's state vector. */
  private readonly writers = new Map<string, MergeWriter>()

  constructor(projects: ProjectStore, documents: DeckDocuments, publicUrl: string, bases = new RecentBases()) {
    this.projects = projects
    this.documents = documents
    this.publicUrl = publicUrl
    this.bases = bases
  }

  /** Where the deck opens in the web editor. */
  editorUrl(projectId: string, deckId: string) {
    return `${this.publicUrl}/p/${encodeURIComponent(projectId)}/d/${encodeURIComponent(deckId)}`
  }

  list(userId: string): Promise<Project[]> {
    return this.projects.list(userId)
  }

  /** Projects and decks other people shared with the person. */
  shared(userId: string): Promise<SharedProject[]> {
    return this.projects.shared(userId)
  }

  createProject(userId: string, name: string) {
    return this.projects.createProject(userId, name)
  }

  /** The deck's summary and project, or undefined when it is neither the person's nor shared with them. */
  async find(userId: string, deckId: string): Promise<{ project: Project | SharedProject, deck: DeckSummary } | undefined> {
    for (const project of [...await this.projects.list(userId), ...await this.projects.shared(userId)]) {
      const deck = project.decks.find(item => item.id === deckId)
      if (deck)
        return { project, deck }
    }
    return undefined
  }

  /**
   * The deck's Markdown as people edit it, without internal slide ids. With
   * `remember`, the server keeps what this session saw, so its next write
   * keeps what people change meanwhile.
   */
  async read(reader: Reader, deckId: string, { remember = false } = {}): Promise<string | undefined> {
    if (!(await this.projects.deckAccess(reader.userId, deckId)))
      return undefined
    const read = await unlessGone(this.documents.read(deckId, doc => ({
      markdown: deckMarkdown(doc),
      state: remember ? Y.encodeStateAsUpdate(doc) : undefined,
    }), { userId: reader.userId }))
    if (read?.state)
      this.bases.set(reader.userId, baseKey(reader, deckId), read.state)
    return read?.markdown
  }

  /**
   * Makes the deck hold `markdown`. When this session read or wrote the
   * deck before, the Markdown is merged against that version, so what
   * people changed since stays. Without one, the deck becomes exactly this
   * Markdown, and the result says so. Returns undefined when the deck is not
   * the person's.
   */
  async write(writer: Reader, deckId: string, markdown: string): Promise<DeckWrite | undefined> {
    const parsed = checkMarkdown(markdown)
    if (!(await this.projects.editableDeck(writer.userId, deckId, VIEW_ONLY)))
      return undefined
    const base = this.bases.get(baseKey(writer, deckId))
    const mergeWriter = this.writerOf(deckId)
    return this.change(writer, deckId, (doc) => {
      if (base) {
        const { textBase, fallback } = mergeMarkdown(doc, base, markdown, undefined, { writer: mergeWriter })
        return { textBase, replaced: fallback, live: liveSlides(doc) }
      }
      applyDeck(doc, parsed)
      return { textBase: Y.encodeStateAsUpdate(doc), replaced: true, live: liveSlides(doc) }
    })
  }

  /**
   * Changes the deck with `edit`, which throws to save nothing. When this
   * session read or wrote the deck before, the edits apply to that version,
   * so slide numbers mean what Claude saw, and the result is merged into
   * the deck as it is now. Without one, they apply to the deck as it is now.
   * Returns undefined when the deck is not the person's.
   */
  async edit(writer: Reader, deckId: string, edit: (draft: DeckDraft) => void): Promise<DeckWrite | undefined> {
    if (!(await this.projects.editableDeck(writer.userId, deckId, VIEW_ONLY)))
      return undefined
    const base = this.bases.get(baseKey(writer, deckId))
    const mergeWriter = this.writerOf(deckId)
    let edited: string | undefined
    if (base) {
      const draft = new DeckDraft(markdownAt(base))
      edit(draft)
      checkMarkdown(draft.markdown)
      edited = draft.markdown
    }
    return this.change(writer, deckId, (doc) => {
      if (edited !== undefined) {
        const { textBase, fallback } = mergeMarkdown(doc, base!, edited, undefined, { writer: mergeWriter })
        return { textBase, replaced: fallback, live: liveSlides(doc) }
      }
      // Read, edit and write in one step, so no other change lands in between.
      const draft = new DeckDraft(deckMarkdown(doc))
      edit(draft)
      applyDeck(doc, checkMarkdown(draft.markdown))
      return { textBase: Y.encodeStateAsUpdate(doc), replaced: false, live: liveSlides(doc) }
    })
  }

  /** Returns undefined when the project is not the person's. */
  async create(writer: Reader, projectId: string, name: string, markdown: string) {
    const doc = new Y.Doc()
    try {
      applyDeck(doc, checkMarkdown(markdown), undefined, { create: true })
      const state = Y.encodeStateAsUpdate(doc)
      const deck = await this.projects.createDeck(writer.userId, projectId, name, state)
      // Claude knows what it just wrote, so its next write merges against it.
      if (deck)
        this.bases.set(writer.userId, baseKey(writer, deck.id), state)
      return deck
    }
    finally {
      doc.destroy()
    }
  }

  /**
   * Makes a change in the deck's live room, then remembers what Claude's
   * text now corresponds to. A change whose save failed counts as well,
   * since the room keeps it and saves it later.
   */
  private async change(writer: Reader, deckId: string, change: (doc: Y.Doc) => Change): Promise<DeckWrite | undefined> {
    const attempt: { made?: Change } = {}
    let made: Change | undefined
    try {
      made = await unlessGone(this.documents.change(deckId, doc => (attempt.made = change(doc)), { userId: writer.userId }))
    }
    catch (error) {
      if (error instanceof DeckNotSavedError && attempt.made)
        this.remember(writer, deckId, attempt.made)
      throw error
    }
    if (!made)
      return undefined
    const known = this.remember(writer, deckId, made)
    return { markdown: made.live.markdown, numbering: numberSlides(made.live, known), replaced: made.replaced }
  }

  /**
   * The deck's slides numbered the way this session knows the deck (see
   * `SlideNumbering`), or as they stand when it read or wrote nothing yet.
   * Undefined when the deck is not the person's.
   */
  async numbered(reader: Reader, deckId: string): Promise<SlideNumbering | undefined> {
    if (!(await this.projects.deckAccess(reader.userId, deckId)))
      return undefined
    const live = await unlessGone(this.documents.read(deckId, liveSlides, { userId: reader.userId }))
    return live && numberSlides(live, this.bases.get(baseKey(reader, deckId)))
  }

  /**
   * Remembers the state Claude's text corresponds to after a write. It adds
   * to what the session knew before, so when one session sends several
   * writes at once, its next write repeats none of them.
   */
  private remember(writer: Reader, deckId: string, { textBase, replaced }: Change) {
    const key = baseKey(writer, deckId)
    const known = this.bases.get(key)
    const now = known && !replaced ? Y.mergeUpdates([known, textBase]) : textBase
    this.bases.set(writer.userId, key, now)
    return now
  }

  private writerOf(deckId: string) {
    let writer = this.writers.get(deckId)
    if (!writer) {
      writer = newMergeWriter()
      this.writers.set(deckId, writer)
      for (const oldest of this.writers.keys()) {
        if (this.writers.size <= BASE_LIMITS.count)
          break
        this.writers.delete(oldest)
      }
    }
    return writer
  }
}
