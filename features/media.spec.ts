// @vitest-environment node
import type { Project } from '../apps/server/src/projects'
import type { MediaFile, UploadTicket, Usage } from '../apps/server/src/media/store'
import type { TestBrowser, TestServer } from './support/server'
import { describeFeature, loadFeature } from '@amiceli/vitest-cucumber'
import { beforeAll, expect } from 'vitest'
import * as Y from 'yjs'
import { R2MediaStorage } from '../apps/server/src/media/storage'
import { deckToYDoc, fromMarkdown } from '../packages/deck-model/src'
import { FakeMediaStorage, sampleFile } from './support/media-storage'
import { createTestServer, DATABASE_WARM_UP_MS, TestBrowser as Browser, signedInBrowser, warmUpDatabase } from './support/server'

const feature = await loadFeature('./media.feature')

beforeAll(warmUpDatabase, DATABASE_WARM_UP_MS)

const MB = 1024 * 1024
const GB = 1024 * MB

/** A deck as the API stores it, in base64. */
function stateOf(markdown: string) {
  return Buffer.from(Y.encodeStateAsUpdate(deckToYDoc(fromMarkdown(markdown)))).toString('base64')
}

describeFeature(feature, ({ Background, Scenario, ScenarioOutline }) => {
  let server: TestServer
  let storage: FakeMediaStorage
  let ana: TestBrowser
  let budi: TestBrowser
  let citra: TestBrowser
  let projectId: string
  let ticket: UploadTicket
  let result: { status: number, body: any }
  let files: Record<string, string>

  async function start(env: Record<string, string> = {}) {
    storage = new FakeMediaStorage()
    server = await createTestServer({ mediaStorage: storage, env })
    files = {}
  }

  async function signInAna() {
    ana = await signedInBrowser(server, 'ana@example.com', 'Ana')
    projectId = (await ana.json<Project>('/api/projects', { json: { name: 'Algorithms 101' } })).body.id
  }

  async function startUpload(browser: TestBrowser, name: string, type: string, size: number) {
    result = await browser.json<UploadTicket>(`/api/projects/${projectId}/media`, { json: { name, type, size } })
    if (result.status === 201)
      ticket = result.body
  }

  async function finish(browser: TestBrowser = ana) {
    result = await browser.json<MediaFile>(`/api/media/${ticket.media.id}/finish`, { method: 'POST' })
  }

  /** Where storage keeps a file: the key its upload link was made for. */
  const keyOf = (id: string) => storage.links.find(link => link.kind === 'upload' && link.key.endsWith(`/${id}`))!.key
  const libraryOf = async (browser: TestBrowser, project = projectId) =>
    (await browser.json<{ files: MediaFile[], usage: Usage }>(`/api/projects/${project}/media`)).body
  const status = async (browser: TestBrowser, path: string, init: { method?: string, json?: unknown } = {}) => (await browser.request(path, init)).status
  const opens = (browser: TestBrowser, name: string) => status(browser, `/api/media/${files[name]}/file`)

  async function uploaded(name: string, browser: TestBrowser = ana, size = 2048) {
    await startUpload(browser, name, 'image/png', size)
    expect(result.status, JSON.stringify(result.body)).toBe(201)
    storage.put(keyOf(ticket.media.id), sampleFile('png', size))
    await finish(browser)
    expect(result.status).toBe(200)
    files[name] = ticket.media.id
  }

  async function shareProject(email: string, role: string) {
    expect((await ana.json(`/api/projects/${projectId}/sharing`, { json: { email, role } })).status).toBe(201)
  }

  /** A finished file in another of Ana's projects, written straight to the database. */
  async function storesElsewhere(bytes: number) {
    const other = (await ana.json<Project>('/api/projects', { json: { name: 'Archive' } })).body.id
    await server.db.insertInto('media').values({
      id: 'archive-video',
      project_id: other,
      uploaded_by: null,
      key: `projects/${other}/archive-video`,
      name: 'archive.mp4',
      type: 'video/mp4',
      size: bytes,
      status: 'ready',
      created_at: new Date(),
    }).execute()
  }

  const refused = (message: string, code = 400) => () => {
    expect(result).toEqual({ status: code, body: { error: message } })
  }

  Background(({ Given, And }) => {
    Given('the Deyslide API with media storage', () => start())
    And('Ana is signed in with the project "Algorithms 101"', signInAna)
  })

  Scenario('Upload an image', ({ When, Then, And }) => {
    When('Ana asks to upload "diagram.png" as "image/png" with 2048 bytes', () => startUpload(ana, 'diagram.png', 'image/png', 2048))
    Then('she gets an upload link that expires in 15 minutes and is signed for "image/png" and 2048 bytes', () => {
      expect(result.status).toBe(201)
      expect(ticket.upload).toMatchObject({ method: 'PUT', headers: { 'content-type': 'image/png' } })
      expect(storage.links).toEqual([{ kind: 'upload', key: keyOf(ticket.media.id), type: 'image/png', size: 2048, expiresSeconds: 900 }])
      expect(ticket.upload.url).toBe(`https://storage.test/${keyOf(ticket.media.id)}?upload`)
    })
    And('the file is stored under the project', () => {
      expect(keyOf(ticket.media.id)).toBe(`projects/${projectId}/${ticket.media.id}`)
    })
    When('she uploads a PNG of 2048 bytes to it and finishes the upload', async () => {
      storage.put(keyOf(ticket.media.id), sampleFile('png', 2048))
      await finish()
      expect(result.status).toBe(200)
    })
    Then('the project\'s media lists "diagram.png" as a 2048 byte "image/png"', async () => {
      expect((await libraryOf(ana)).files).toEqual([{ id: ticket.media.id, projectId, name: 'diagram.png', type: 'image/png', size: 2048, createdAt: expect.any(Number) }])
    })
    And('2048 bytes of her 1 GB are used', async () => {
      expect((await libraryOf(ana)).usage).toEqual({ usedBytes: 2048, limitBytes: GB })
    })
  })

  ScenarioOutline('Only media files are accepted', ({ When, Then }, variables) => {
    When('Ana asks to upload "<name>" as "<type>" with 1000 bytes', () => startUpload(ana, variables.name, variables.type, 1000))
    Then('the upload is refused with "Upload an image, a video or an audio file: PNG, JPEG, GIF, WebP, AVIF, MP4, WebM, MOV, MP3, M4A, OGG or WAV."', () => {
      refused('Upload an image, a video or an audio file: PNG, JPEG, GIF, WebP, AVIF, MP4, WebM, MOV, MP3, M4A, OGG or WAV.')()
      expect(storage.links).toEqual([])
    })
  })

  Scenario('A file can be at most 100 MB', ({ When, Then }) => {
    When('Ana asks to upload "talk.mp4" as "video/mp4" with 104857601 bytes', () => startUpload(ana, 'talk.mp4', 'video/mp4', 104857601))
    Then('the upload is refused with "A file can be at most 100 MB."', refused('A file can be at most 100 MB.'))
  })

  Scenario('A file that is not what it claims is not kept', ({ Given, When, Then, And }) => {
    let key: string
    Given('Ana asked to upload "photo.png" as "image/png" with 1000 bytes', () => startUpload(ana, 'photo.png', 'image/png', 1000))
    When('she uploads a PDF of 1000 bytes to it and finishes the upload', async () => {
      key = keyOf(ticket.media.id)
      storage.put(key, sampleFile('pdf', 1000))
      await finish()
    })
    Then('the upload is refused with "That file is not a PNG image, so it was not kept."', refused('That file is not a PNG image, so it was not kept.'))
    And('the stored file is gone and the project\'s media is empty', async () => {
      expect(storage.files.has(key)).toBe(false)
      expect((await libraryOf(ana)).files).toEqual([])
    })
  })

  Scenario('Finishing before uploading', ({ Given, When, Then }) => {
    Given('Ana asked to upload "clip.webm" as "video/webm" with 5000 bytes', () => startUpload(ana, 'clip.webm', 'video/webm', 5000))
    When('she finishes the upload without sending the file', () => finish())
    Then('the upload is refused with "The file has not arrived yet. Upload it, then finish again."', refused('The file has not arrived yet. Upload it, then finish again.'))
  })

  Scenario('Open a file', ({ Given, When, Then, And }) => {
    Given('Ana uploaded "diagram.png"', () => uploaded('diagram.png'))
    When('she asks for a link to "diagram.png"', async () => {
      result = await ana.json(`/api/media/${files['diagram.png']}`)
    })
    Then('she gets a download link that expires in 15 minutes', () => {
      expect(result.status).toBe(200)
      expect(result.body.url).toBe(`https://storage.test/${keyOf(files['diagram.png'])}?download`)
      expect(storage.links.at(-1)).toMatchObject({ kind: 'download', expiresSeconds: 900 })
    })
    And('the file address redirects to that kind of link', async () => {
      const response = await ana.request(`/api/media/${files['diagram.png']}/file`)
      expect(response.status).toBe(302)
      expect(response.headers.get('location')).toBe(`https://storage.test/${keyOf(files['diagram.png'])}?download`)
    })
  })

  Scenario('Delete a file', ({ Given, When, Then, And }) => {
    let key: string
    Given('Ana uploaded "diagram.png"', async () => {
      await uploaded('diagram.png')
      key = keyOf(files['diagram.png'])
    })
    When('she deletes "diagram.png"', async () => {
      expect(await status(ana, `/api/media/${files['diagram.png']}`, { method: 'DELETE' })).toBe(204)
    })
    Then('the stored file is gone and the project\'s media is empty', async () => {
      expect(storage.files.has(key)).toBe(false)
      expect((await libraryOf(ana)).files).toEqual([])
    })
    And('none of her storage is used', async () => {
      expect((await libraryOf(ana)).usage.usedBytes).toBe(0)
    })
  })

  Scenario('Each account has 1 GB for all its projects', ({ Given, When, Then }) => {
    Given('Ana already stores 1000 MB of files in another project', () => storesElsewhere(1000 * MB))
    When('Ana asks to upload "talk.mp4" as "video/mp4" with 52428800 bytes', () => startUpload(ana, 'talk.mp4', 'video/mp4', 50 * MB))
    Then('the upload is refused with "This file does not fit in your 1 GB of storage, which has 24 MB left. Delete some files first."', () => {
      refused('This file does not fit in your 1 GB of storage, which has 24 MB left. Delete some files first.')()
      expect(storage.links).toEqual([])
    })
  })

  Scenario('The limit comes from the server settings', ({ Given, And, When, Then }) => {
    Given('the Deyslide API with media storage and a limit of 1 MB for each account', () => start({ MEDIA_ACCOUNT_LIMIT_MB: '1' }))
    And('Ana is signed in with the project "Algorithms 101"', signInAna)
    When('Ana asks to upload "photo.png" as "image/png" with 2097152 bytes', () => startUpload(ana, 'photo.png', 'image/png', 2 * MB))
    Then('the upload is refused with "This file does not fit in your 1 MB of storage, which has 1 MB left. Delete some files first."', refused('This file does not fit in your 1 MB of storage, which has 1 MB left. Delete some files first.'))
  })

  Scenario('Uploads started together cannot pass the limit', ({ Given, And, When, Then }) => {
    let statuses: number[]
    Given('the Deyslide API with media storage and a limit of 1 MB for each account', () => start({ MEDIA_ACCOUNT_LIMIT_MB: '1' }))
    And('Ana is signed in with the project "Algorithms 101"', signInAna)
    When('Ana asks to upload two files of 600000 bytes at the same time', async () => {
      const upload = (name: string) => status(ana, `/api/projects/${projectId}/media`, { json: { name, type: 'image/png', size: 600000 } })
      statuses = await Promise.all([upload('one.png'), upload('two.png')])
    })
    Then('one gets an upload link and the other is refused', () => {
      expect(statuses.sort()).toEqual([201, 400])
    })
  })

  Scenario('The team shares the project\'s files', ({ Given, And, Then, When, But }) => {
    Given('Ana uploaded "diagram.png"', () => uploaded('diagram.png'))
    And('Ana shares the project with Budi as an editor and with Citra as a viewer', async () => {
      budi = await signedInBrowser(server, 'budi@example.com', 'Budi')
      citra = await signedInBrowser(server, 'citra@example.com', 'Citra')
      await shareProject('budi@example.com', 'editor')
      await shareProject('citra@example.com', 'viewer')
    })
    Then('Budi and Citra see "diagram.png" in the project\'s media and can open it', async () => {
      for (const browser of [budi, citra]) {
        expect((await libraryOf(browser)).files.map(file => file.name)).toEqual(['diagram.png'])
        expect(await opens(browser, 'diagram.png')).toBe(302)
      }
    })
    When('Budi uploads "chart.png" of 4096 bytes', () => uploaded('chart.png', budi, 4096))
    Then('the project\'s media lists "chart.png" and "diagram.png"', async () => {
      expect((await libraryOf(ana)).files.map(file => file.name).sort()).toEqual(['chart.png', 'diagram.png'])
    })
    And('the 4096 bytes count toward Ana\'s storage, not Budi\'s', async () => {
      expect((await libraryOf(budi)).usage.usedBytes).toBe(2048 + 4096)
      const own = (await budi.json<Project>('/api/projects', { json: { name: 'Budi notes' } })).body.id
      expect((await libraryOf(budi, own)).usage.usedBytes).toBe(0)
    })
    But('Citra cannot add files', async () => {
      await startUpload(citra, 'mine.png', 'image/png', 100)
      refused('You can view this project but not add files to it.', 403)()
    })
    And('only Ana can delete files', async () => {
      result = await budi.json(`/api/media/${files['chart.png']}`, { method: 'DELETE' })
      refused('Only the owner can delete files.', 403)()
      expect(await status(citra, `/api/media/${files['diagram.png']}`, { method: 'DELETE' })).toBe(403)
      expect(await status(ana, `/api/media/${files['chart.png']}`, { method: 'DELETE' })).toBe(204)
    })
  })

  Scenario('An editor\'s upload that does not fit in the owner\'s storage', ({ Given, And, When, Then }) => {
    Given('Ana already stores 1000 MB of files in another project', () => storesElsewhere(1000 * MB))
    And('Ana shares the project with Budi as an editor', async () => {
      budi = await signedInBrowser(server, 'budi@example.com', 'Budi')
      await shareProject('budi@example.com', 'editor')
    })
    When('Budi asks to upload "talk.mp4" as "video/mp4" with 52428800 bytes', () => startUpload(budi, 'talk.mp4', 'video/mp4', 50 * MB))
    Then('the upload is refused with "This file does not fit in the project owner\'s 1 GB of storage. Ask them to delete some files first."', refused('This file does not fit in the project owner\'s 1 GB of storage. Ask them to delete some files first.'))
  })

  Scenario('Someone given one deck opens only the files that deck shows', ({ Given, And, Then, But }) => {
    let deckId: string
    Given('Ana uploaded "diagram.png" and "secret.png"', async () => {
      await uploaded('diagram.png')
      await uploaded('secret.png')
    })
    And('her deck "Sorting" shows "diagram.png"', async () => {
      const markdown = `# Sorting\n\n![Diagram](/api/media/${files['diagram.png']}/file)\n`
      deckId = (await ana.json<{ id: string }>(`/api/projects/${projectId}/decks`, { json: { name: 'Sorting', state: stateOf(markdown) } })).body.id
    })
    And('Ana shares only the deck "Sorting" with Budi', async () => {
      budi = await signedInBrowser(server, 'budi@example.com', 'Budi')
      expect((await ana.json(`/api/decks/${deckId}/sharing`, { json: { email: 'budi@example.com', role: 'viewer' } })).status).toBe(201)
    })
    Then('Budi can open "diagram.png"', async () => {
      expect(await opens(budi, 'diagram.png')).toBe(302)
    })
    But('Budi cannot open "secret.png" or list the project\'s media', async () => {
      expect(await opens(budi, 'secret.png')).toBe(404)
      expect(await status(budi, `/api/projects/${projectId}/media`)).toBe(404)
    })
  })

  Scenario('Files are private', ({ Given, And, Then }) => {
    Given('Ana uploaded "diagram.png"', () => uploaded('diagram.png'))
    And('Budi is signed in on another browser', async () => {
      budi = await signedInBrowser(server, 'budi@example.com', 'Budi')
    })
    Then('Budi cannot list, add, open, finish or delete files in the project', async () => {
      const id = files['diagram.png']
      expect(await status(budi, `/api/projects/${projectId}/media`)).toBe(404)
      expect(await status(budi, `/api/projects/${projectId}/media`, { json: { name: 'a.png', type: 'image/png', size: 10 } })).toBe(404)
      expect(await status(budi, `/api/media/${id}`)).toBe(404)
      expect(await status(budi, `/api/media/${id}/file`)).toBe(404)
      expect(await status(budi, `/api/media/${id}/finish`, { method: 'POST' })).toBe(404)
      expect(await status(budi, `/api/media/${id}`, { method: 'DELETE' })).toBe(404)
      expect((await libraryOf(ana)).files).toHaveLength(1)
    })
    And('guests cannot upload', async () => {
      expect(await status(new Browser(server), `/api/projects/${projectId}/media`, { json: { name: 'a.png', type: 'image/png', size: 10 } })).toBe(401)
    })
  })

  Scenario('Deleting a project deletes its files', ({ Given, When, Then, And }) => {
    let key: string
    Given('Ana uploaded "diagram.png"', async () => {
      await uploaded('diagram.png')
      key = keyOf(files['diagram.png'])
    })
    When('she deletes the project', async () => {
      expect(await status(ana, `/api/projects/${projectId}`, { method: 'DELETE' })).toBe(204)
    })
    Then('the stored file is gone', () => {
      expect(storage.files.has(key)).toBe(false)
    })
    And('none of her storage is used', async () => {
      projectId = (await ana.json<Project>('/api/projects', { json: { name: 'Fresh' } })).body.id
      expect((await libraryOf(ana)).usage.usedBytes).toBe(0)
    })
  })

  Scenario('Media is off without R2 settings', ({ Given, Then }) => {
    let off: TestServer
    Given('the Deyslide API without media storage', async () => {
      off = await createTestServer()
    })
    Then('the public settings say media is off', async () => {
      expect((await new Browser(off).json<{ media: boolean }>('/api/config')).body.media).toBe(false)
      const anaOff = await signedInBrowser(off, 'ana@example.com', 'Ana')
      const project = (await anaOff.json<Project>('/api/projects', { json: { name: 'Talks' } })).body.id
      expect(await status(anaOff, `/api/projects/${project}/media`)).toBe(404)
    })
  })

  Scenario('Upload links for Cloudflare R2', ({ Given, When, Then, And }) => {
    let r2: R2MediaStorage
    let url: URL
    Given('R2 settings for the account "0123456789abcdef" and the bucket "deyslide-private-assets"', () => {
      r2 = new R2MediaStorage({ accountId: '0123456789abcdef', accessKeyId: 'test-key', secretAccessKey: 'test-secret', bucket: 'deyslide-private-assets' })
    })
    When('an upload link is made for "projects/p1/file-1" as "image/png" with 2048 bytes', async () => {
      url = new URL(await r2.uploadUrl('projects/p1/file-1', 'image/png', 2048, 900))
    })
    Then('it is a PUT to "https://0123456789abcdef.r2.cloudflarestorage.com/deyslide-private-assets/projects/p1/file-1"', () => {
      expect(`${url.origin}${url.pathname}`).toBe('https://0123456789abcdef.r2.cloudflarestorage.com/deyslide-private-assets/projects/p1/file-1')
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
