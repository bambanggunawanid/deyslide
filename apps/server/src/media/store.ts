import type { AppDb, MediaTable } from '../db.ts'
import type { MediaStorage } from './storage.ts'
import { ACCEPTED_TYPES_MESSAGE, HEAD_BYTES, isMediaType, MEDIA_KINDS } from './kinds.ts'

/** The largest file anyone can upload: 100 MB. */
export const MEDIA_MAX_BYTES = 100 * 1024 * 1024
/** How long an upload link works. */
export const UPLOAD_LINK_SECONDS = 15 * 60
/** How long a download link works. */
export const DOWNLOAD_LINK_SECONDS = 60 * 60
/** Uploads never finished within this time are cleaned up. */
const PENDING_MAX_MS = 24 * 60 * 60 * 1000

/** A request that cannot go through. The message says why. */
export class MediaError extends Error {}

export interface MediaFile {
  id: string
  name: string
  type: string
  size: number
  createdAt: number
}

export interface UploadTicket {
  media: MediaFile
  upload: { method: 'PUT', url: string, headers: { 'content-type': string }, expiresAt: string }
}

const toFile = (row: Pick<MediaTable, 'id' | 'name' | 'type' | 'size'> & { created_at: Date }): MediaFile =>
  ({ id: row.id, name: row.name, type: row.type, size: row.size, createdAt: row.created_at.getTime() })

/** Keeps names readable and safe to show: no folders, no control characters. */
function cleanName(name: string) {
  const base = name.split(/[\\/]/).pop() ?? ''
  return base.replace(/[\u0000-\u001F\u007F]/g, '').trim().slice(0, 200)
}

/**
 * Each person's own media files. Uploading is two steps: ask for a link
 * and PUT the file straight to storage, then finish, which checks the size
 * and the first bytes before the file counts. Only the owner can list,
 * open or delete a file.
 */
export class MediaStore {
  private readonly db: AppDb
  private readonly storage: MediaStorage
  private readonly newId: () => string
  private readonly now: () => Date

  constructor(db: AppDb, storage: MediaStorage, { newId = () => crypto.randomUUID(), now = () => new Date() } = {}) {
    this.db = db
    this.storage = storage
    this.newId = newId
    this.now = now
  }

  async startUpload(userId: string, input: { name: string, type: string, size: number }): Promise<UploadTicket> {
    const name = cleanName(input.name)
    if (!name)
      throw new MediaError('Give the file a name.')
    if (!isMediaType(input.type))
      throw new MediaError(ACCEPTED_TYPES_MESSAGE)
    if (!Number.isInteger(input.size) || input.size < 1)
      throw new MediaError('The file is empty.')
    if (input.size > MEDIA_MAX_BYTES)
      throw new MediaError('A file can be at most 100 MB.')

    await this.forgetAbandoned(userId)
    const id = this.newId()
    const key = `users/${userId}/${id}`
    const created_at = this.now()
    await this.db.insertInto('media').values({ id, owner_id: userId, key, name, type: input.type, size: input.size, status: 'pending', created_at }).execute()
    const url = await this.storage.uploadUrl(key, input.type, input.size, UPLOAD_LINK_SECONDS)
    return {
      media: toFile({ id, name, type: input.type, size: input.size, created_at }),
      upload: {
        method: 'PUT',
        url,
        headers: { 'content-type': input.type },
        expiresAt: new Date(created_at.getTime() + UPLOAD_LINK_SECONDS * 1000).toISOString(),
      },
    }
  }

  /** Checks the stored file and keeps it. Undefined when the upload is not the person's. */
  async finishUpload(userId: string, mediaId: string): Promise<MediaFile | undefined> {
    const row = await this.row(userId, mediaId)
    if (!row)
      return undefined
    if (row.status === 'ready')
      return toFile(row)
    const size = await this.storage.size(row.key)
    if (size === undefined)
      throw new MediaError('The file has not arrived yet. Upload it, then finish again.')
    const kind = MEDIA_KINDS[row.type]
    const fits = size === row.size && size <= MEDIA_MAX_BYTES
    if (!fits || !kind.matches(await this.storage.head(row.key, HEAD_BYTES))) {
      await this.storage.delete(row.key)
      await this.db.deleteFrom('media').where('id', '=', row.id).execute()
      throw new MediaError(fits
        ? `That file is not ${kind.label}, so it was not kept.`
        : 'The file is not the size given when the upload started, so it was not kept.')
    }
    await this.db.updateTable('media').set({ status: 'ready' }).where('id', '=', row.id).execute()
    return toFile(row)
  }

  async list(userId: string): Promise<MediaFile[]> {
    const rows = await this.db.selectFrom('media')
      .select(['id', 'name', 'type', 'size', 'created_at'])
      .where('owner_id', '=', userId)
      .where('status', '=', 'ready')
      .orderBy('created_at', 'desc')
      .execute()
    return rows.map(toFile)
  }

  /** A download link for the owner. Undefined for anyone else. */
  async link(userId: string, mediaId: string): Promise<{ media: MediaFile, url: string, expiresAt: string } | undefined> {
    const row = await this.row(userId, mediaId)
    if (!row || row.status !== 'ready')
      return undefined
    const url = await this.storage.downloadUrl(row.key, DOWNLOAD_LINK_SECONDS)
    return { media: toFile(row), url, expiresAt: new Date(this.now().getTime() + DOWNLOAD_LINK_SECONDS * 1000).toISOString() }
  }

  async delete(userId: string, mediaId: string): Promise<boolean> {
    const row = await this.row(userId, mediaId)
    if (!row)
      return false
    await this.storage.delete(row.key)
    await this.db.deleteFrom('media').where('id', '=', row.id).execute()
    return true
  }

  private row(userId: string, mediaId: string) {
    return this.db.selectFrom('media').selectAll().where('id', '=', mediaId).where('owner_id', '=', userId).executeTakeFirst()
  }

  /** Removes the person's uploads that were started long ago and never finished. */
  private async forgetAbandoned(userId: string) {
    const before = new Date(this.now().getTime() - PENDING_MAX_MS)
    const rows = await this.db.selectFrom('media').select(['id', 'key'])
      .where('owner_id', '=', userId)
      .where('status', '=', 'pending')
      .where('created_at', '<', before)
      .execute()
    for (const row of rows) {
      await this.storage.delete(row.key)
      await this.db.deleteFrom('media').where('id', '=', row.id).execute()
    }
  }
}
