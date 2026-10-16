import type { MediaApi, MediaFile } from '../../apps/web/src/projects/media'
import { StoreError } from '../../apps/web/src/projects/names'

/**
 * A project's media library for page scenarios. Files live in memory, an
 * upload is kept at once, and `fetch` answers `GET /api/media/:id` and
 * `GET /api/decks/:deckId/media/:id` with a signed link as the API does, so
 * pages that resolve media links can run against it (stub the global
 * `fetch` with it). A deck's previews only get files of the deck's project:
 * say which with `deckIn`. The API has its own scenarios in media.feature.
 */
export class FakeMediaApi implements MediaApi {
  on: boolean
  readonly files: MediaFile[] = []
  /** What each upload sent. */
  readonly uploads: { projectId: string, name: string, type: string, size: number }[] = []
  /** File ids the page asked a signed link for, in order. */
  readonly linkRequests: string[] = []
  /** Each deck's project, for the links its previews ask for. */
  readonly deckProjects = new Map<string, string>()
  /** When set, the next upload fails with this message. */
  failUpload = ''
  /** How long a signed link works. */
  linkSeconds = 15 * 60
  private created = 0
  private signed = 0

  constructor({ on = true }: { on?: boolean } = {}) {
    this.on = on
  }

  async enabled() {
    return this.on
  }

  async list(projectId: string) {
    const files = this.files.filter(file => file.projectId === projectId)
    return { files: structuredClone(files), usage: { usedBytes: files.reduce((total, file) => total + file.size, 0), limitBytes: 1024 ** 3 } }
  }

  async upload(projectId: string, file: File) {
    if (this.failUpload) {
      const message = this.failUpload
      this.failUpload = ''
      throw new StoreError(message)
    }
    this.uploads.push({ projectId, name: file.name, type: file.type, size: file.size })
    return this.add(projectId, file.name, { type: file.type, size: file.size })
  }

  /** A file already in a project's library. Newer files come later. */
  add(projectId: string, name: string, { type = 'image/png', size = 1000, id }: { type?: string, size?: number, id?: string } = {}): MediaFile {
    const count = ++this.created
    const file: MediaFile = { id: id ?? `media-${count}`, projectId, name, type, size, createdAt: Date.now() + count }
    this.files.push(file)
    return structuredClone(file)
  }

  /** Says which project a deck is in. */
  deckIn(deckId: string, projectId: string) {
    this.deckProjects.set(deckId, projectId)
  }

  /** The signed link the fake hands out for a file, by its count. */
  static signedLink(id: string, count: number) {
    return `https://storage.example/${id}?signature=${count}`
  }

  /** `GET /api/media/:id` and `GET /api/decks/:deckId/media/:id` as the API answers them; every other request is not found. */
  readonly fetch = async (input: RequestInfo | URL): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : String(input), 'http://localhost')
    const single = url.pathname.match(/^\/api\/media\/([^/]+)$/)
    const inDeck = url.pathname.match(/^\/api\/decks\/([^/]+)\/media\/([^/]+)$/)
    const deckId = inDeck ? decodeURIComponent(inDeck[1]!) : undefined
    const found = single?.[1] ?? inDeck?.[2]
    const id = found === undefined ? undefined : decodeURIComponent(found)
    let file = id === undefined ? undefined : this.files.find(item => item.id === id)
    if (id !== undefined)
      this.linkRequests.push(id)
    if (file && deckId !== undefined && this.deckProjects.get(deckId) !== file.projectId)
      file = undefined
    if (!file)
      return Response.json({ error: 'Not found' }, { status: 404 })
    return Response.json({
      media: file,
      url: FakeMediaApi.signedLink(file.id, ++this.signed),
      expiresAt: new Date(Date.now() + this.linkSeconds * 1000).toISOString(),
    })
  }
}
