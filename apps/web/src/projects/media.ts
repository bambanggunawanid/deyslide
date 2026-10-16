import type { InjectionKey } from 'vue'
import { apiFetch } from '../platform/platform'
import { StoreError } from './names'

/** A file in a project's media library, as the API describes it. */
export interface MediaFile {
  id: string
  projectId: string
  name: string
  /** Its media type, such as `image/png`. */
  type: string
  /** In bytes. */
  size: number
  createdAt: number
}

/** How much of the project owner's storage is used. */
export interface MediaUsage {
  usedBytes: number
  limitBytes: number
}

/** Each project's media library on the Deyslide API. */
export interface MediaApi {
  /** Whether the server keeps media at all (`/api/config`). */
  enabled: () => Promise<boolean>
  list: (projectId: string) => Promise<{ files: MediaFile[], usage: MediaUsage }>
  /** Uploads a file into the project's library and returns it once the server checked it. */
  upload: (projectId: string, file: File) => Promise<MediaFile>
}

/** A project's media library, for the pages that offer it. */
export interface ProjectMedia {
  api: MediaApi
  projectId: string
}

/** The image types a slide can show from the library. The server keeps video and audio too. */
export const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif']

export const MEDIA_KEY: InjectionKey<MediaApi> = Symbol('media')

const MESSAGES: Record<number, string> = {
  401: 'You are signed out. Sign in again to keep working.',
  404: 'That project no longer exists.',
}

const UNREACHABLE = 'Deyslide is unreachable. Check your connection and try again.'

/** An upload ticket from `POST /api/projects/:id/media`: where to PUT the file, then which file to finish. */
interface UploadTicket {
  media: MediaFile
  upload: { method: 'PUT', url: string, headers: Record<string, string> }
}

/**
 * The media library over HTTP. API calls go through `apiFetch` (the
 * session cookie on the website, a token in the app). The file itself goes
 * straight to storage through the signed link, with the page's own `fetch`:
 * the app's http plugin takes small bodies only.
 */
export class HttpMediaApi implements MediaApi {
  private readonly fetchImpl: typeof fetch
  private readonly uploadFetch: typeof fetch
  private enabledOnce?: Promise<boolean>

  constructor(fetchImpl: typeof fetch = apiFetch, uploadFetch: typeof fetch = (input, init) => fetch(input, init)) {
    this.fetchImpl = fetchImpl
    this.uploadFetch = uploadFetch
  }

  enabled() {
    this.enabledOnce ??= this.fetchImpl('/api/config')
      .then(async response => response.ok && Boolean((await response.json() as { media?: boolean }).media))
      .catch(() => false)
    return this.enabledOnce
  }

  list(projectId: string) {
    return this.json<{ files: MediaFile[], usage: MediaUsage }>('GET', `/projects/${encodeURIComponent(projectId)}/media`)
  }

  async upload(projectId: string, file: File) {
    const ticket = await this.json<UploadTicket>('POST', `/projects/${encodeURIComponent(projectId)}/media`, { name: file.name, type: file.type, size: file.size })
    let stored: Response
    try {
      stored = await this.uploadFetch(ticket.upload.url, { method: ticket.upload.method, headers: ticket.upload.headers, body: file })
    }
    catch {
      throw new StoreError('The upload did not finish. Check your connection and try again.')
    }
    if (!stored.ok)
      throw new StoreError('Storage did not take the file. Try again.')
    return this.json<MediaFile>('POST', `/media/${encodeURIComponent(ticket.media.id)}/finish`)
  }

  private async json<T>(method: string, path: string, body?: unknown): Promise<T> {
    let response: Response
    try {
      response = await this.fetchImpl(`/api${path}`, {
        method,
        headers: body === undefined ? undefined : { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
    }
    catch {
      throw new StoreError(UNREACHABLE)
    }
    if (response.ok)
      return await response.json() as T
    const reason = await response.json().then((data: { error?: string }) => data.error, () => undefined)
    // The server words its refusals for people: a file it does not keep, a full storage, a viewer's upload.
    const explained = response.status === 400 || response.status === 403 ? reason : undefined
    throw new StoreError(MESSAGES[response.status] ?? explained ?? 'Deyslide could not do that. Try again.')
  }
}
