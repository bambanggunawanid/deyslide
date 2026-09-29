// @vitest-environment node
import type { MediaFile, UploadTicket } from '../apps/server/src/media/store'
import type { TestBrowser, TestServer } from './support/server'
import { describeFeature, loadFeature } from '@amiceli/vitest-cucumber'
import { beforeAll, expect } from 'vitest'
import { R2MediaStorage } from '../apps/server/src/media/storage'
import { FakeMediaStorage, sampleFile } from './support/media-storage'
import { createTestServer, DATABASE_WARM_UP_MS, TestBrowser as Browser, signedInBrowser, warmUpDatabase } from './support/server'

const feature = await loadFeature('./media.feature')

beforeAll(warmUpDatabase, DATABASE_WARM_UP_MS)

describeFeature(feature, ({ Background, Scenario, ScenarioOutline }) => {
  let server: TestServer
  let storage: FakeMediaStorage
  let ana: TestBrowser
  let ticket: UploadTicket
  let result: { status: number, body: any }

  async function startUpload(name: string, type: string, size: number) {
    result = await ana.json<UploadTicket>('/api/media', { json: { name, type, size } })
    if (result.status === 201)
      ticket = result.body
  }

  async function finish() {
    result = await ana.json<MediaFile>(`/api/media/${ticket.media.id}/finish`, { method: 'POST' })
  }

  /** Where storage keeps a file: the key its upload link was made for. */
  const keyOf = (id: string) => storage.links.find(link => link.kind === 'upload' && link.key.endsWith(`/${id}`))!.key
  const mediaOf = async (browser: TestBrowser) => (await browser.json<MediaFile[]>('/api/media')).body

  async function uploaded(name: string) {
    await startUpload(name, 'image/png', 2048)
    storage.put(keyOf(ticket.media.id), sampleFile('png', 2048))
    await finish()
    expect(result.status).toBe(200)
  }

  Background(({ Given, And }) => {
    Given('the Deyslide API with media storage', async () => {
      storage = new FakeMediaStorage()
      server = await createTestServer({ mediaStorage: storage })
    })
    And('Ana is signed in', async () => {
      ana = await signedInBrowser(server, 'ana@example.com', 'Ana')
    })
  })

  Scenario('Upload an image', ({ When, Then }) => {
    When('Ana asks to upload "diagram.png" as "image/png" with 2048 bytes', () => startUpload('diagram.png', 'image/png', 2048))
    Then('she gets an upload link that expires in 15 minutes and is signed for "image/png" and 2048 bytes', () => {
      expect(result.status).toBe(201)
      expect(ticket.upload).toMatchObject({ method: 'PUT', headers: { 'content-type': 'image/png' } })
      expect(storage.links).toEqual([{ kind: 'upload', key: keyOf(ticket.media.id), type: 'image/png', size: 2048, expiresSeconds: 900 }])
      expect(ticket.upload.url).toBe(`https://storage.test/${keyOf(ticket.media.id)}?upload`)
    })
    When('she uploads a PNG of 2048 bytes to it and finishes the upload', async () => {
      storage.put(keyOf(ticket.media.id), sampleFile('png', 2048))
      await finish()
      expect(result.status).toBe(200)
    })
    Then('her media lists "diagram.png" as a 2048 byte "image/png"', async () => {
      expect(await mediaOf(ana)).toEqual([{ id: ticket.media.id, name: 'diagram.png', type: 'image/png', size: 2048, createdAt: expect.any(Number) }])
    })
  })

  ScenarioOutline('Only media files are accepted', ({ When, Then }, variables) => {
    When('Ana asks to upload "<name>" as "<type>" with 1000 bytes', () => startUpload(variables.name, variables.type, 1000))
    Then('the upload is refused with "Upload an image, a video or an audio file: PNG, JPEG, GIF, WebP, AVIF, MP4, WebM, MOV, MP3, M4A, OGG or WAV."', () => {
      expect(result).toEqual({ status: 400, body: { error: 'Upload an image, a video or an audio file: PNG, JPEG, GIF, WebP, AVIF, MP4, WebM, MOV, MP3, M4A, OGG or WAV.' } })
      expect(storage.links).toEqual([])
    })
  })

  Scenario('A file can be at most 100 MB', ({ When, Then }) => {
    When('Ana asks to upload "talk.mp4" as "video/mp4" with 104857601 bytes', () => startUpload('talk.mp4', 'video/mp4', 104857601))
    Then('the upload is refused with "A file can be at most 100 MB."', () => {
      expect(result).toEqual({ status: 400, body: { error: 'A file can be at most 100 MB.' } })
    })
  })

  Scenario('A file that is not what it claims is not kept', ({ Given, When, Then, And }) => {
    let key: string
    Given('Ana asked to upload "photo.png" as "image/png" with 1000 bytes', () => startUpload('photo.png', 'image/png', 1000))
    When('she uploads a PDF of 1000 bytes to it and finishes the upload', async () => {
      key = keyOf(ticket.media.id)
      storage.put(key, sampleFile('pdf', 1000))
      await finish()
    })
    Then('the upload is refused with "That file is not a PNG image, so it was not kept."', () => {
      expect(result).toEqual({ status: 400, body: { error: 'That file is not a PNG image, so it was not kept.' } })
    })
    And('the stored file is gone and her media is empty', async () => {
      expect(storage.files.has(key)).toBe(false)
      expect(await mediaOf(ana)).toEqual([])
    })
  })

  Scenario('Finishing before uploading', ({ Given, When, Then }) => {
    Given('Ana asked to upload "clip.webm" as "video/webm" with 5000 bytes', () => startUpload('clip.webm', 'video/webm', 5000))
    When('she finishes the upload without sending the file', finish)
    Then('the upload is refused with "The file has not arrived yet. Upload it, then finish again."', () => {
      expect(result).toEqual({ status: 400, body: { error: 'The file has not arrived yet. Upload it, then finish again.' } })
    })
  })

  Scenario('Open a file', ({ Given, When, Then, And }) => {
    Given('Ana uploaded "diagram.png"', () => uploaded('diagram.png'))
    When('she asks for a link to "diagram.png"', async () => {
      result = await ana.json(`/api/media/${ticket.media.id}`)
    })
    Then('she gets a download link that expires in 1 hour', () => {
      expect(result.status).toBe(200)
      expect(result.body.url).toBe(`https://storage.test/${keyOf(ticket.media.id)}?download`)
      expect(storage.links.at(-1)).toMatchObject({ kind: 'download', expiresSeconds: 3600 })
    })
    And('the file address redirects to that kind of link', async () => {
      const response = await ana.request(`/api/media/${ticket.media.id}/file`)
      expect(response.status).toBe(302)
      expect(response.headers.get('location')).toBe(`https://storage.test/${keyOf(ticket.media.id)}?download`)
    })
  })

  Scenario('Delete a file', ({ Given, When, Then }) => {
    let key: string
    Given('Ana uploaded "diagram.png"', async () => {
      await uploaded('diagram.png')
      key = keyOf(ticket.media.id)
    })
    When('she deletes "diagram.png"', async () => {
      expect((await ana.request(`/api/media/${ticket.media.id}`, { method: 'DELETE' })).status).toBe(204)
    })
    Then('the stored file is gone and her media is empty', async () => {
      expect(storage.files.has(key)).toBe(false)
      expect(await mediaOf(ana)).toEqual([])
    })
  })

  Scenario('Files are private', ({ Given, And, Then }) => {
    let budi: TestBrowser
    Given('Ana uploaded "diagram.png"', () => uploaded('diagram.png'))
    And('Budi is signed in on another browser', async () => {
      budi = await signedInBrowser(server, 'budi@example.com', 'Budi')
    })
    Then('Budi cannot list, open or delete "diagram.png"', async () => {
      expect(await mediaOf(budi)).toEqual([])
      expect((await budi.request(`/api/media/${ticket.media.id}`)).status).toBe(404)
      expect((await budi.request(`/api/media/${ticket.media.id}/file`)).status).toBe(404)
      expect((await budi.request(`/api/media/${ticket.media.id}`, { method: 'DELETE' })).status).toBe(404)
      expect((await budi.request(`/api/media/${ticket.media.id}/finish`, { method: 'POST' })).status).toBe(404)
      expect(await mediaOf(ana)).toHaveLength(1)
    })
    And('guests cannot upload', async () => {
      expect((await new Browser(server).request('/api/media', { json: { name: 'a.png', type: 'image/png', size: 10 } })).status).toBe(401)
    })
  })

  Scenario('Media is off without R2 settings', ({ Given, Then }) => {
    let off: TestServer
    Given('the Deyslide API without media storage', async () => {
      off = await createTestServer()
    })
    Then('the public settings say media is off', async () => {
      expect((await new Browser(off).json<{ media: boolean }>('/api/config')).body.media).toBe(false)
      expect((await new Browser(off).request('/api/media')).status).toBe(404)
    })
  })

  Scenario('Upload links for Cloudflare R2', ({ Given, When, Then, And }) => {
    let r2: R2MediaStorage
    let url: URL
    Given('R2 settings for the account "0123456789abcdef" and the bucket "deyslide-private-assets"', () => {
      r2 = new R2MediaStorage({ accountId: '0123456789abcdef', accessKeyId: 'test-key', secretAccessKey: 'test-secret', bucket: 'deyslide-private-assets' })
    })
    When('an upload link is made for "users/ana/file-1" as "image/png" with 2048 bytes', async () => {
      url = new URL(await r2.uploadUrl('users/ana/file-1', 'image/png', 2048, 900))
    })
    Then('it is a PUT to "https://0123456789abcdef.r2.cloudflarestorage.com/deyslide-private-assets/users/ana/file-1"', () => {
      expect(`${url.origin}${url.pathname}`).toBe('https://0123456789abcdef.r2.cloudflarestorage.com/deyslide-private-assets/users/ana/file-1')
    })
    And('it is signed with SigV4 for the "auto" region and the "s3" service, expiring in 900 seconds', () => {
      expect(url.searchParams.get('X-Amz-Algorithm')).toBe('AWS4-HMAC-SHA256')
      expect(url.searchParams.get('X-Amz-Credential')).toMatch(/^test-key\/\d{8}\/auto\/s3\/aws4_request$/)
      expect(url.searchParams.get('X-Amz-Expires')).toBe('900')
      expect(url.searchParams.get('X-Amz-Signature')).toMatch(/^[0-9a-f]{64}$/)
    })
    And('the signed headers are "content-length;content-type;host"', () => {
      expect(url.searchParams.get('X-Amz-SignedHeaders')).toBe('content-length;content-type;host')
    })
  })
})
