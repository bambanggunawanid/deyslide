import type { AppDb, MediaTable } from '../db.ts'
import type { ProjectStore } from '../projects.ts'
import type { MediaStorage } from './storage.ts'
import { toMarkdown, yDocToDeck } from '@deyslide/deck-model'
import { sql } from 'kysely'
import * as Y from 'yjs'
import { atLeast, ForbiddenError } from '../projects.ts'
import { ACCEPTED_TYPES_MESSAGE, HEAD_BYTES, isMediaType, MEDIA_KINDS } from './kinds.ts'

/** The largest file anyone can upload: 100 MB. */
export const MEDIA_MAX_BYTES = 100 * 1024 * 1024
/** Storage for each account's projects, unless the settings say otherwise: 1 GB. */
export const DEFAULT_ACCOUNT_LIMIT_BYTES = 1024 * 1024 * 1024
/** How long an upload link works. */
export const UPLOAD_LINK_SECONDS = 15 * 60
/** How long a download link works. Short, so removing someone from a project soon ends their access. */
export const DOWNLOAD_LINK_SECONDS = 15 * 60
/** Uploads never finished within this time are cleaned up. */
const PENDING_MAX_MS = 24 * 60 * 60 * 1000

/** A request that cannot go through. The message says why. */
export class MediaError extends Error {}

export interface MediaFile {
  id: string
  projectId: string
  name: string
  type: string
  size: number
  createdAt: number
}

export interface UploadTicket {
  media: MediaFile
  upload: { method: 'PUT', url: string, headers: { 'content-type': string }, expiresAt: string }
}

/** How much of the project owner's storage is used. */
export interface Usage {
  usedBytes: number
  limitBytes: number
}

/** The address slides use for a file. Anyone given a single deck can open the files it names this way. */
export function mediaAddress(mediaId: string) {
  return `/api/media/${mediaId}/file`
}

type Row = Pick<MediaTable, 'id' | 'project_id' | 'name' | 'type' | 'size'> & { created_at: Date }

const toFile = (row: Row): MediaFile =>
  ({ id: row.id, projectId: row.project_id, name: row.name, type: row.type, size: row.size, createdAt: row.created_at.getTime() })

/** Keeps names readable and safe to show: no folders, no control characters. */
function cleanName(name: string) {
  const base = name.split(/[\\/]/).pop() ?? ''
  return base.replace(/[\u0000-\u001F\u007F]/g, '').trim().slice(0, 200)
}

function megabytes(bytes: number) {
  return bytes >= 1024 ** 3 ? `${Math.round(bytes / 1024 ** 3 * 10) / 10} GB` : `${Math.round(bytes / 1024 ** 2)} MB`
}

export interface MediaStoreOptions {
  /** Storage for all of one account's projects. */
  accountLimitBytes?: number
  newId?: () => string
  now?: () => Date
}

/**
 * Each project's media library. Files live under the project in a private
 * bucket and are opened only through short signed links. Everyone the
 * project is shared with can open its files, editors add files, and only
 * the owner deletes them. Someone given a single deck can open the files
 * that deck's slides use. Files count toward the project owner's storage.
 *
 * Uploading is two steps: ask for a link and PUT the file straight to
 * storage, then finish, which checks the size and the first bytes.
 */
export class MediaStore {
  private readonly db: AppDb
  private readonly storage: MediaStorage
  private readonly projects: ProjectStore
  private readonly limit: number
  private readonly newId: () => string
  private readonly now: () => Date

  constructor(db: AppDb, storage: MediaStorage, projects: ProjectStore, { accountLimitBytes = DEFAULT_ACCOUNT_LIMIT_BYTES, newId = () => crypto.randomUUID(), now = () => new Date() }: MediaStoreOptions = {}) {
    this.db = db
    this.storage = storage
    this.projects = projects
    this.limit = accountLimitBytes
    this.newId = newId
    this.now = now
  }

  /** Undefined when the project is not the person's to see. */
  async startUpload(userId: string, projectId: string, input: { name: string, type: string, size: number }): Promise<UploadTicket | undefined> {
    const role = await this.projects.projectRole(userId, projectId)
    if (!role)
      return undefined
    if (!atLeast(role, 'editor'))
      throw new ForbiddenError('You can view this project but not add files to it.')
    const name = cleanName(input.name)
    if (!name)
      throw new MediaError('Give the file a name.')
    if (!isMediaType(input.type))
      throw new MediaError(ACCEPTED_TYPES_MESSAGE)
    if (!Number.isInteger(input.size) || input.size < 1)
      throw new MediaError('The file is empty.')
    if (input.size > MEDIA_MAX_BYTES)
      throw new MediaError('A file can be at most 100 MB.')

    await this.forgetAbandoned(projectId)
    const id = this.newId()
    const key = `projects/${projectId}/${id}`
    const created_at = this.now()
    await this.db.transaction().execute(async (trx) => {
      const ownerId = await this.ownerOf(projectId, trx)
      // One upload at a time per owner, so uploads started together cannot pass the limit between them.
      await sql`select pg_advisory_xact_lock(hashtext(${ownerId}))`.execute(trx)
      const used = await this.usedBy(ownerId, trx)
      if (used + input.size > this.limit) {
        throw new MediaError(role === 'owner'
          ? `This file does not fit in your ${megabytes(this.limit)} of storage, which has ${megabytes(Math.max(0, this.limit - used))} left. Delete some files first.`
          : `This file does not fit in the project owner's ${megabytes(this.limit)} of storage. Ask them to delete some files first.`)
      }
      await trx.insertInto('media').values({ id, project_id: projectId, uploaded_by: userId, key, name, type: input.type, size: input.size, status: 'pending', created_at }).execute()
    })
    const url = await this.storage.uploadUrl(key, input.type, input.size, UPLOAD_LINK_SECONDS)
    return {
      media: toFile({ id, project_id: projectId, name, type: input.type, size: input.size, created_at }),
      upload: {
        method: 'PUT',
        url,
        headers: { 'content-type': input.type },
        expiresAt: new Date(created_at.getTime() + UPLOAD_LINK_SECONDS * 1000).toISOString(),
      },
    }
  }

  /** Checks the stored file and keeps it. Owners and editors of its project. */
  async finishUpload(userId: string, mediaId: string): Promise<MediaFile | undefined> {
    const row = await this.row(mediaId)
    const role = row && await this.projects.projectRole(userId, row.project_id)
    if (!row || !role)
      return undefined
    if (!atLeast(role, 'editor'))
      throw new ForbiddenError('You can view this project but not add files to it.')
    if (row.status === 'ready')
      return toFile(row)
    const size = await this.storage.size(row.key)
    if (size === undefined)
      throw new MediaError('The file has not arrived yet. Upload it, then finish again.')
    const kind = MEDIA_KINDS[row.type]
    const fits = size === row.size && size <= MEDIA_MAX_BYTES
    if (!fits || !kind.matches(await this.storage.head(row.key, HEAD_BYTES))) {
      await this.remove(row)
      throw new MediaError(fits
        ? `That file is not ${kind.label}, so it was not kept.`
        : 'The file is not the size given when the upload started, so it was not kept.')
    }
    await this.db.updateTable('media').set({ status: 'ready' }).where('id', '=', row.id).execute()
    return toFile(row)
  }

  /** A project's files and its owner's storage. Anyone the whole project is shared with. */
  async list(userId: string, projectId: string): Promise<{ files: MediaFile[], usage: Usage } | undefined> {
    if (!(await this.projects.projectRole(userId, projectId)))
      return undefined
    const rows = await this.db.selectFrom('media')
      .select(['id', 'project_id', 'name', 'type', 'size', 'created_at'])
      .where('project_id', '=', projectId)
      .where('status', '=', 'ready')
      .orderBy('created_at', 'desc')
      .execute()
    return { files: rows.map(toFile), usage: { usedBytes: await this.usedBy(await this.ownerOf(projectId, this.db), this.db), limitBytes: this.limit } }
  }

  /** A short lived download link, for anyone who may open the file. */
  async link(userId: string, mediaId: string): Promise<{ media: MediaFile, url: string, expiresAt: string } | undefined> {
    const row = await this.row(mediaId)
    if (!row || row.status !== 'ready' || !(await this.canOpen(userId, row.project_id, mediaId)))
      return undefined
    const url = await this.storage.downloadUrl(row.key, DOWNLOAD_LINK_SECONDS)
    return { media: toFile(row), url, expiresAt: new Date(this.now().getTime() + DOWNLOAD_LINK_SECONDS * 1000).toISOString() }
  }

  /** The project owner only. */
  async delete(userId: string, mediaId: string): Promise<boolean> {
    const row = await this.row(mediaId)
    const role = row && await this.projects.projectRole(userId, row.project_id)
    if (!row || !role)
      return false
    if (role !== 'owner')
      throw new ForbiddenError('Only the owner can delete files.')
    await this.remove(row)
    return true
  }

  /** Where a project's files are stored, read before the project is deleted so they can go too. */
  async keysOf(projectId: string): Promise<string[]> {
    return (await this.db.selectFrom('media').select('key').where('project_id', '=', projectId).execute()).map(row => row.key)
  }

  /** Deletes stored files whose project is gone. The project is already deleted, so a failure is logged, not thrown. */
  async deleteStored(keys: string[]) {
    for (const key of keys) {
      try {
        await this.storage.delete(key)
      }
      catch (error) {
        console.error(`Could not delete the stored file ${key}:`, error)
      }
    }
  }

  /**
   * Anyone the project is shared with. Someone given only single decks may
   * open a file that one of those decks' slides uses.
   */
  private async canOpen(userId: string, projectId: string, mediaId: string) {
    if (await this.projects.projectRole(userId, projectId))
      return true
    const decks = await this.db.selectFrom('deck')
      .innerJoin('deck_member', 'deck_member.deck_id', 'deck.id')
      .select('deck.state')
      .where('deck.project_id', '=', projectId)
      .where('deck_member.user_id', '=', userId)
      .execute()
    return decks.some(deck => this.deckUses(new Uint8Array(deck.state), mediaId))
  }

  private deckUses(state: Uint8Array, mediaId: string) {
    const doc = new Y.Doc()
    try {
      Y.applyUpdate(doc, state)
      return toMarkdown(yDocToDeck(doc), { ids: false }).includes(mediaAddress(mediaId))
    }
    catch {
      return false
    }
    finally {
      doc.destroy()
    }
  }

  private row(mediaId: string) {
    return this.db.selectFrom('media').selectAll().where('id', '=', mediaId).executeTakeFirst()
  }

  private async ownerOf(projectId: string, db: AppDb) {
    return (await db.selectFrom('project').select('owner_id').where('id', '=', projectId).executeTakeFirstOrThrow()).owner_id
  }

  /** Bytes in all of an account's projects, unfinished uploads included so they cannot race past the limit. */
  private async usedBy(ownerId: string, db: AppDb) {
    const row = await db.selectFrom('media')
      .innerJoin('project', 'project.id', 'media.project_id')
      .select(eb => eb.fn.sum<string | number | null>('media.size').as('total'))
      .where('project.owner_id', '=', ownerId)
      .executeTakeFirst()
    return Number(row?.total ?? 0)
  }

  private async remove(row: Pick<MediaTable, 'id' | 'key'>) {
    await this.storage.delete(row.key)
    await this.db.deleteFrom('media').where('id', '=', row.id).execute()
  }

  /** Removes a project's uploads that were started long ago and never finished. */
  private async forgetAbandoned(projectId: string) {
    const before = new Date(this.now().getTime() - PENDING_MAX_MS)
    const rows = await this.db.selectFrom('media').select(['id', 'key'])
      .where('project_id', '=', projectId)
      .where('status', '=', 'pending')
      .where('created_at', '<', before)
      .execute()
    for (const row of rows)
      await this.remove(row)
  }
}
