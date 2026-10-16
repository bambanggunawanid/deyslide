import type { InjectionKey } from 'vue'
import { inject } from 'vue'
import { apiFetch } from '../platform/platform'

/** PDF and video exports on the server, through `/api/exports`. */

export type ExportFormat = 'pdf' | 'webm'

/** One page per slide with all its clicks shown, or one page per click step. */
export type ExportClicks = 'last' | 'each'

/** The deck to export: one on the server by id, or Markdown for a deck that lives on this device. */
export type ExportSource = { deckId: string } | { markdown: string }

export interface ExportStatus {
  status: 'queued' | 'running' | 'done' | 'failed'
  /** From 0 to 1. */
  progress: number
  error?: string
}

export interface ExportFile {
  bytes: Uint8Array
  /** The file name the server suggests. */
  name: string
  type: string
}

export interface ExportApi {
  /** How often to ask about a running export, in milliseconds. A second unless set. */
  pollMs?: number
  /** Whether the server makes exports for signed in people (`/api/config`). */
  enabled: () => Promise<boolean>
  /** Starts an export and returns its id. */
  start: (source: ExportSource, format: ExportFormat, clicks: ExportClicks) => Promise<string>
  status: (id: string) => Promise<ExportStatus>
  download: (id: string) => Promise<ExportFile>
}

/** An export problem, in words for the person. */
export class ExportError extends Error {}

export const UNREACHABLE = 'The server could not be reached. Check the connection and try again.'

/** The file name in a Content-Disposition header, preferring the UTF-8 form. */
export function attachmentName(header: string | null): string | undefined {
  if (!header)
    return undefined
  const encoded = /filename\*\s*=\s*UTF-8''([^;]+)/i.exec(header)?.[1]
  if (encoded) {
    try {
      return decodeURIComponent(encoded.trim())
    }
    catch {}
  }
  return /filename\s*=\s*"([^"]*)"/i.exec(header)?.[1] ?? /filename\s*=\s*([^;]+)/i.exec(header)?.[1]?.trim()
}

export class HttpExportApi implements ExportApi {
  private readonly fetchImpl: typeof fetch
  private config?: Promise<boolean>

  constructor(fetchImpl: typeof fetch = apiFetch) {
    this.fetchImpl = fetchImpl
  }

  /** The server's answer is kept once it came; a check that failed (offline, say) is tried again next time. */
  enabled() {
    this.config ??= this.fetchImpl('/api/config')
      .then(async (response) => {
        if (!response.ok)
          throw new Error(`The config answered ${response.status}`)
        return Boolean((await response.json() as { exports?: boolean }).exports)
      })
      .catch(() => {
        this.config = undefined
        return false
      })
    return this.config
  }

  async start(source: ExportSource, format: ExportFormat, clicks: ExportClicks) {
    const response = await this.send('/api/exports', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...source, format, options: { clicks } }),
    })
    return (await response.json() as { id: string }).id
  }

  async status(id: string) {
    const response = await this.send(`/api/exports/${encodeURIComponent(id)}`)
    return await response.json() as ExportStatus
  }

  async download(id: string): Promise<ExportFile> {
    const response = await this.send(`/api/exports/${encodeURIComponent(id)}/file`)
    const type = response.headers.get('content-type') ?? 'application/octet-stream'
    return {
      bytes: new Uint8Array(await response.arrayBuffer()),
      name: attachmentName(response.headers.get('content-disposition')) ?? '',
      type,
    }
  }

  private async send(path: string, init?: RequestInit) {
    let response: Response
    try {
      response = await this.fetchImpl(path, init)
    }
    catch {
      throw new ExportError(UNREACHABLE)
    }
    if (response.ok)
      return response
    let message = ''
    try {
      message = (await response.json() as { error?: string }).error ?? ''
    }
    catch {}
    throw new ExportError(message || (response.status === 401 ? 'Sign in again to export.' : 'The export did not work. Try again.'))
  }
}

export const EXPORT_KEY: InjectionKey<ExportApi> = Symbol('exports')

export function useExportApi(): ExportApi {
  const api = inject(EXPORT_KEY)
  if (!api)
    throw new Error('The export API is not provided')
  return api
}
