import type { AppDb } from './db.ts'
import { yDocToDeck } from '@deyslide/deck-model'
import * as Y from 'yjs'
import { z } from 'zod'

export const NAME_MAX_LENGTH = 80
/** A deck document larger than this is refused. Media lives in R2, not in the deck. */
export const DECK_MAX_BYTES = 5 * 1024 * 1024

export const NameSchema = z.string().trim()
  .min(1, 'A name is required')
  .max(NAME_MAX_LENGTH, `A name can have at most ${NAME_MAX_LENGTH} characters`)

/** The same shapes the web app uses for browser projects, so both stores look alike. */
export interface DeckSummary {
  id: string
  name: string
  slideCount: number
  createdAt: number
  updatedAt: number
}

export interface Project {
  id: string
  name: string
  createdAt: number
  updatedAt: number
  decks: DeckSummary[]
}

export class DeckContentError extends Error {
  constructor() {
    super('The deck content is not a valid deck')
  }
}

/** Checks that `state` is a Yjs document holding a valid deck, and counts its slides. */
export function readDeckState(state: Uint8Array): { slideCount: number } {
  if (state.byteLength === 0 || state.byteLength > DECK_MAX_BYTES)
    throw new DeckContentError()
  const doc = new Y.Doc()
  try {
    Y.applyUpdate(doc, state)
    return { slideCount: yDocToDeck(doc).slides.length }
  }
  catch {
    throw new DeckContentError()
  }
  finally {
    doc.destroy()
  }
}

export interface ImportedDeck {
  id: string
  name: string
  createdAt: number
  updatedAt: number
  state: Uint8Array
}

export interface ImportedProject {
  id: string
  name: string
  createdAt: number
  updatedAt: number
  decks: ImportedDeck[]
}

const time = (date: Date) => date.getTime()

/**
 * Projects and decks in Postgres. Every method takes the signed in user and
 * only touches what that user owns; anything else reads as missing.
 */
export class ProjectStore {
  private readonly db: AppDb
  private readonly newId: () => string

  constructor(db: AppDb, newId: () => string = () => crypto.randomUUID()) {
    this.db = db
    this.newId = newId
  }

  async list(userId: string): Promise<Project[]> {
    const projects = await this.db.selectFrom('project')
      .select(['id', 'name', 'created_at', 'updated_at'])
      .where('owner_id', '=', userId)
      .orderBy('updated_at', 'desc')
      .execute()
    if (projects.length === 0)
      return []
    const decks = await this.db.selectFrom('deck')
      .select(['id', 'project_id', 'name', 'slide_count', 'created_at', 'updated_at'])
      .where('project_id', 'in', projects.map(project => project.id))
      .orderBy('created_at', 'asc')
      .execute()
    return projects.map(project => ({
      id: project.id,
      name: project.name,
      createdAt: time(project.created_at),
      updatedAt: time(project.updated_at),
      decks: decks.filter(deck => deck.project_id === project.id).map(deck => ({
        id: deck.id,
        name: deck.name,
        slideCount: deck.slide_count,
        createdAt: time(deck.created_at),
        updatedAt: time(deck.updated_at),
      })),
    }))
  }

  async get(userId: string, projectId: string): Promise<Project | undefined> {
    return (await this.list(userId)).find(project => project.id === projectId)
  }

  async createProject(userId: string, name: string): Promise<Project> {
    const now = new Date()
    const project = { id: this.newId(), owner_id: userId, name, created_at: now, updated_at: now }
    await this.db.insertInto('project').values(project).execute()
    return { id: project.id, name, createdAt: time(now), updatedAt: time(now), decks: [] }
  }

  /** Returns false when the project is missing or not the user's. */
  async renameProject(userId: string, projectId: string, name: string) {
    const result = await this.db.updateTable('project')
      .set({ name, updated_at: new Date() })
      .where('id', '=', projectId)
      .where('owner_id', '=', userId)
      .executeTakeFirst()
    return result.numUpdatedRows > 0n
  }

  async deleteProject(userId: string, projectId: string) {
    const result = await this.db.deleteFrom('project')
      .where('id', '=', projectId)
      .where('owner_id', '=', userId)
      .executeTakeFirst()
    return result.numDeletedRows > 0n
  }

  /** Returns undefined when the project is missing or not the user's. */
  async createDeck(userId: string, projectId: string, name: string, state: Uint8Array): Promise<DeckSummary | undefined> {
    const { slideCount } = readDeckState(state)
    if (!(await this.ownsProject(userId, projectId)))
      return undefined
    const now = new Date()
    const deck = { id: this.newId(), project_id: projectId, name, state, slide_count: slideCount, created_at: now, updated_at: now }
    await this.db.transaction().execute(async (trx) => {
      await trx.insertInto('deck').values(deck).execute()
      await trx.updateTable('project').set({ updated_at: now }).where('id', '=', projectId).execute()
    })
    return { id: deck.id, name, slideCount, createdAt: time(now), updatedAt: time(now) }
  }

  async renameDeck(userId: string, deckId: string, name: string) {
    const projectId = await this.ownedDeckProject(userId, deckId)
    if (!projectId)
      return false
    const now = new Date()
    await this.db.transaction().execute(async (trx) => {
      await trx.updateTable('deck').set({ name, updated_at: now }).where('id', '=', deckId).execute()
      await trx.updateTable('project').set({ updated_at: now }).where('id', '=', projectId).execute()
    })
    return true
  }

  async deleteDeck(userId: string, deckId: string) {
    const projectId = await this.ownedDeckProject(userId, deckId)
    if (!projectId)
      return false
    await this.db.transaction().execute(async (trx) => {
      await trx.deleteFrom('deck').where('id', '=', deckId).execute()
      await trx.updateTable('project').set({ updated_at: new Date() }).where('id', '=', projectId).execute()
    })
    return true
  }

  async deckState(userId: string, deckId: string): Promise<Uint8Array | undefined> {
    const row = await this.db.selectFrom('deck')
      .innerJoin('project', 'project.id', 'deck.project_id')
      .select('deck.state')
      .where('deck.id', '=', deckId)
      .where('project.owner_id', '=', userId)
      .executeTakeFirst()
    return row && new Uint8Array(row.state)
  }

  /**
   * Adds projects made in a browser before signing in, keeping their names,
   * times and ids. Running it again adds nothing. An id someone else already
   * uses gets a new one, so an import can never touch another account.
   * Returns how many projects were added.
   */
  async import(userId: string, projects: ImportedProject[]): Promise<number> {
    const checked = projects.map(project => ({
      ...project,
      decks: project.decks.map(deck => ({ ...deck, ...readDeckState(deck.state) })),
    }))

    return this.db.transaction().execute(async (trx) => {
      let added = 0
      for (const project of checked) {
        const existing = await trx.selectFrom('project').select('owner_id').where('id', '=', project.id).executeTakeFirst()
        if (existing?.owner_id === userId)
          continue
        const projectId = existing ? this.newId() : project.id
        await trx.insertInto('project').values({
          id: projectId,
          owner_id: userId,
          name: project.name,
          created_at: new Date(project.createdAt),
          updated_at: new Date(project.updatedAt),
        }).execute()
        for (const deck of project.decks) {
          const taken = await trx.selectFrom('deck').select('id').where('id', '=', deck.id).executeTakeFirst()
          await trx.insertInto('deck').values({
            id: taken ? this.newId() : deck.id,
            project_id: projectId,
            name: deck.name,
            state: deck.state,
            slide_count: deck.slideCount,
            created_at: new Date(deck.createdAt),
            updated_at: new Date(deck.updatedAt),
          }).execute()
        }
        added++
      }
      return added
    })
  }

  private async ownsProject(userId: string, projectId: string) {
    const row = await this.db.selectFrom('project').select('id').where('id', '=', projectId).where('owner_id', '=', userId).executeTakeFirst()
    return Boolean(row)
  }

  private async ownedDeckProject(userId: string, deckId: string) {
    const row = await this.db.selectFrom('deck')
      .innerJoin('project', 'project.id', 'deck.project_id')
      .select('project.id')
      .where('deck.id', '=', deckId)
      .where('project.owner_id', '=', userId)
      .executeTakeFirst()
    return row?.id
  }
}
