import type { AppDb, Role, SharedRole } from './db.ts'
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

const RANK: Record<Role, number> = { viewer: 1, editor: 2, owner: 3 }

/** True when `role` allows at least what `needed` allows. */
export function atLeast(role: Role | undefined, needed: Role) {
  return role !== undefined && RANK[role] >= RANK[needed]
}

/** The higher of two roles. */
export function higher(a: Role | undefined, b: Role | undefined): Role | undefined {
  if (!a)
    return b
  if (!b)
    return a
  return RANK[a] >= RANK[b] ? a : b
}

/** The person can see this, but their role does not allow the change. The message says why. */
export class ForbiddenError extends Error {}

export interface Person {
  name: string
  email: string
}

/** A deck someone else owns, with the role the signed in person has on it. */
export interface SharedDeckSummary extends DeckSummary {
  role: SharedRole
}

/** A project someone else owns, holding the decks shared with the signed in person. */
export interface SharedProject {
  id: string
  name: string
  createdAt: number
  updatedAt: number
  owner: Person
  /** The person's role on the whole project, or null when only some of its decks are shared. */
  role: SharedRole | null
  decks: SharedDeckSummary[]
}

/**
 * Projects and decks in Postgres. Every method takes the signed in user and
 * only touches what that user owns or what is shared with them, within their
 * role. Anything else reads as missing.
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

  /**
   * What other people shared with the user: whole projects, and single decks
   * grouped under their project. A deck's role is the higher of its own and
   * its project's.
   */
  async shared(userId: string): Promise<SharedProject[]> {
    const projectRoles = new Map((await this.db.selectFrom('project_member')
      .select(['project_id', 'role'])
      .where('user_id', '=', userId)
      .execute()).map(row => [row.project_id, row.role]))
    const deckRoles = new Map((await this.db.selectFrom('deck_member')
      .select(['deck_id', 'role'])
      .where('user_id', '=', userId)
      .execute()).map(row => [row.deck_id, row.role]))
    if (projectRoles.size === 0 && deckRoles.size === 0)
      return []

    const decks = await this.db.selectFrom('deck')
      .select(['id', 'project_id', 'name', 'slide_count', 'created_at', 'updated_at'])
      .where(eb => eb.or([
        ...(projectRoles.size ? [eb('project_id', 'in', [...projectRoles.keys()])] : []),
        ...(deckRoles.size ? [eb('id', 'in', [...deckRoles.keys()])] : []),
      ]))
      .orderBy('created_at', 'asc')
      .execute()
    const projectIds = [...new Set([...projectRoles.keys(), ...decks.map(deck => deck.project_id)])]
    const projects = await this.db.selectFrom('project')
      .innerJoin('user', 'user.id', 'project.owner_id')
      .select(['project.id', 'project.name', 'project.created_at', 'project.updated_at', 'user.name as owner_name', 'user.email as owner_email'])
      .where('project.id', 'in', projectIds)
      // Someone can be invited to their own project through a deck; that is not "shared with you".
      .where('project.owner_id', '!=', userId)
      .orderBy('project.updated_at', 'desc')
      .execute()

    return projects.map((project) => {
      const role = projectRoles.get(project.id) ?? null
      return {
        id: project.id,
        name: project.name,
        createdAt: time(project.created_at),
        updatedAt: time(project.updated_at),
        owner: { name: project.owner_name, email: project.owner_email },
        role,
        decks: decks
          .filter(deck => deck.project_id === project.id)
          .map(deck => ({ deck, role: higher(role ?? undefined, deckRoles.get(deck.id)) as SharedRole | undefined }))
          .filter((item): item is { deck: typeof decks[number], role: SharedRole } => item.role !== undefined)
          .map(({ deck, role: deckRole }) => ({
            id: deck.id,
            name: deck.name,
            slideCount: deck.slide_count,
            createdAt: time(deck.created_at),
            updatedAt: time(deck.updated_at),
            role: deckRole,
          })),
      }
    })
  }

  /** The user's role on a project, or undefined when they have no access. */
  async projectRole(userId: string, projectId: string): Promise<Role | undefined> {
    const row = await this.db.selectFrom('project')
      .leftJoin('project_member', join => join.onRef('project_member.project_id', '=', 'project.id').on('project_member.user_id', '=', userId))
      .select(['project.owner_id', 'project_member.role'])
      .where('project.id', '=', projectId)
      .executeTakeFirst()
    if (!row)
      return undefined
    return row.owner_id === userId ? 'owner' : row.role ?? undefined
  }

  /** The user's role on a deck, the higher of its own and its project's, with the deck's project. */
  async deckAccess(userId: string, deckId: string): Promise<{ role: Role, projectId: string } | undefined> {
    const row = await this.db.selectFrom('deck')
      .innerJoin('project', 'project.id', 'deck.project_id')
      .leftJoin('project_member', join => join.onRef('project_member.project_id', '=', 'project.id').on('project_member.user_id', '=', userId))
      .leftJoin('deck_member', join => join.onRef('deck_member.deck_id', '=', 'deck.id').on('deck_member.user_id', '=', userId))
      .select(['project.id as project_id', 'project.owner_id', 'project_member.role as project_role', 'deck_member.role as deck_role'])
      .where('deck.id', '=', deckId)
      .executeTakeFirst()
    if (!row)
      return undefined
    const role = row.owner_id === userId ? 'owner' : higher(row.project_role ?? undefined, row.deck_role ?? undefined)
    return role && { role, projectId: row.project_id }
  }

  async createProject(userId: string, name: string): Promise<Project> {
    const now = new Date()
    const project = { id: this.newId(), owner_id: userId, name, created_at: now, updated_at: now }
    await this.db.insertInto('project').values(project).execute()
    return { id: project.id, name, createdAt: time(now), updatedAt: time(now), decks: [] }
  }

  /** Owners and editors. Returns false when the project is missing or not shared with the user. */
  async renameProject(userId: string, projectId: string, name: string) {
    const role = await this.projectRole(userId, projectId)
    if (!role)
      return false
    if (!atLeast(role, 'editor'))
      throw new ForbiddenError('You can view this project but not rename it.')
    await this.db.updateTable('project').set({ name, updated_at: new Date() }).where('id', '=', projectId).execute()
    return true
  }

  /** The owner only. Sharing and pending invites for the project and its decks go with it. */
  async deleteProject(userId: string, projectId: string) {
    const role = await this.projectRole(userId, projectId)
    if (!role)
      return false
    if (role !== 'owner')
      throw new ForbiddenError('Only the owner can delete this project.')
    await this.db.transaction().execute(async (trx) => {
      const deckIds = (await trx.selectFrom('deck').select('id').where('project_id', '=', projectId).execute()).map(row => row.id)
      await trx.deleteFrom('invite').where(eb => eb.or([
        eb.and([eb('target_type', '=', 'project'), eb('target_id', '=', projectId)]),
        ...(deckIds.length ? [eb.and([eb('target_type', '=', 'deck'), eb('target_id', 'in', deckIds)])] : []),
      ])).execute()
      await trx.deleteFrom('project').where('id', '=', projectId).execute()
    })
    return true
  }

  /** Owners and editors of the project. Returns undefined when the project is missing or not shared with the user. */
  async createDeck(userId: string, projectId: string, name: string, state: Uint8Array): Promise<DeckSummary | undefined> {
    const { slideCount } = readDeckState(state)
    const role = await this.projectRole(userId, projectId)
    if (!role)
      return undefined
    if (!atLeast(role, 'editor'))
      throw new ForbiddenError('You can view this project but not add decks to it.')
    const now = new Date()
    const deck = { id: this.newId(), project_id: projectId, name, state, slide_count: slideCount, created_at: now, updated_at: now }
    await this.db.transaction().execute(async (trx) => {
      await trx.insertInto('deck').values(deck).execute()
      await trx.updateTable('project').set({ updated_at: now }).where('id', '=', projectId).execute()
    })
    return { id: deck.id, name, slideCount, createdAt: time(now), updatedAt: time(now) }
  }

  /** Owners and editors of the deck. */
  async renameDeck(userId: string, deckId: string, name: string) {
    const access = await this.editableDeck(userId, deckId, 'You can view this deck but not rename it.')
    if (!access)
      return false
    const now = new Date()
    await this.db.transaction().execute(async (trx) => {
      await trx.updateTable('deck').set({ name, updated_at: now }).where('id', '=', deckId).execute()
      await trx.updateTable('project').set({ updated_at: now }).where('id', '=', access.projectId).execute()
    })
    return true
  }

  /** The project's owner only. */
  async deleteDeck(userId: string, deckId: string) {
    const access = await this.deckAccess(userId, deckId)
    if (!access)
      return false
    if (access.role !== 'owner')
      throw new ForbiddenError('Only the owner can delete this deck.')
    await this.db.transaction().execute(async (trx) => {
      await trx.deleteFrom('invite').where('target_type', '=', 'deck').where('target_id', '=', deckId).execute()
      await trx.deleteFrom('deck').where('id', '=', deckId).execute()
      await trx.updateTable('project').set({ updated_at: new Date() }).where('id', '=', access.projectId).execute()
    })
    return true
  }

  /** Replaces a deck's content. Owners and editors. Returns false when the deck is missing or not shared with the user. */
  async saveDeckState(userId: string, deckId: string, state: Uint8Array) {
    const { slideCount } = readDeckState(state)
    const access = await this.editableDeck(userId, deckId, 'You can view this deck but not change it.')
    if (!access)
      return false
    const now = new Date()
    await this.db.transaction().execute(async (trx) => {
      await trx.updateTable('deck').set({ state, slide_count: slideCount, updated_at: now }).where('id', '=', deckId).execute()
      await trx.updateTable('project').set({ updated_at: now }).where('id', '=', access.projectId).execute()
    })
    return true
  }

  /** Anyone the deck is shared with can read it. */
  async deckState(userId: string, deckId: string): Promise<Uint8Array | undefined> {
    if (!(await this.deckAccess(userId, deckId)))
      return undefined
    const row = await this.db.selectFrom('deck').select('state').where('id', '=', deckId).executeTakeFirst()
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

  /** Undefined when the deck is missing or not shared with the user. Throws when they may only view it. */
  private async editableDeck(userId: string, deckId: string, viewOnly: string) {
    const access = await this.deckAccess(userId, deckId)
    if (access && !atLeast(access.role, 'editor'))
      throw new ForbiddenError(viewOnly)
    return access
  }
}
