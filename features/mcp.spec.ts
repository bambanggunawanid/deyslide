// @vitest-environment node
import type { Client } from '@modelcontextprotocol/sdk/client/index.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import type { UploadTicket } from '../apps/server/src/media/store'
import type { RenderedSlide, RenderOptions, SlideRenderer, SlideToRender } from '../apps/server/src/mcp/renderer'
import type { Project } from '../apps/server/src/projects'
import type { TestBrowser, TestServer } from './support/server'
import { describeFeature, loadFeature } from '@amiceli/vitest-cucumber'
import { beforeAll, expect, vi } from 'vitest'
import { StorageError } from '../apps/server/src/media/storage'
import { splitSlides } from '../packages/deck-model/src'
import { demoDeckState } from './support/deck-content'
import { FakeMediaStorage, sampleFile } from './support/media-storage'
import { approveConsent, CALLBACK_URL, connectMcp, FakeClaudeCodeAuth, followInBrowser } from './support/mcp-client'
import { closeTestServers, createTestServer, DATABASE_WARM_UP_MS, TEST_ORIGIN, TestBrowser as Browser, signedInBrowser, warmUpDatabase } from './support/server'

const feature = await loadFeature('./mcp.feature')

beforeAll(warmUpDatabase, DATABASE_WARM_UP_MS)

/** A 1 by 1 PNG, standing in for a slide image. */
const PIXEL = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII='

class FakeRenderer implements SlideRenderer {
  readonly requests: SlideToRender[] = []
  /** The options of each call, in order. */
  readonly options: (RenderOptions | undefined)[] = []
  overflowing = new Set<string>()
  /** Calls being drawn now, and the most there were at once. */
  drawing = 0
  mostAtOnce = 0
  private held?: Promise<void>
  private release?: () => void

  /** Keeps every call waiting until `answer`. */
  hold() {
    this.held = new Promise(resolve => (this.release = resolve))
  }

  answer() {
    this.release?.()
    this.held = undefined
  }

  async render(slides: SlideToRender[], options?: RenderOptions): Promise<RenderedSlide[]> {
    this.requests.push(...slides)
    this.options.push(options)
    this.drawing++
    this.mostAtOnce = Math.max(this.mostAtOnce, this.drawing)
    try {
      await this.held
    }
    finally {
      this.drawing--
    }
    return slides.map(slide => ({ png: PIXEL, clicks: 2, overflow: [...this.overflowing].some(text => slide.content.includes(text)) }))
  }
}

const MCP_URL = `${TEST_ORIGIN}/mcp`
const MB = 1024 * 1024
/** How long a scenario waits for calls that run at the same time. */
const SOON = { timeout: 4000, interval: 20 }

/** A file in a project's media library, as a scenario uploaded it. */
interface Upload {
  /** The address slides use: `/api/media/<id>/file`. */
  link: string
  /** Where storage keeps it. */
  key: string
  type: string
  bytes: Uint8Array
}

const SAMPLE_KINDS: Record<string, Parameters<typeof sampleFile>[0]> = { 'image/png': 'png', 'video/mp4': 'mp4', 'audio/mpeg': 'mp3' }

/** How a slide shows the file: pictures as images, the rest as players. */
function shown(upload: Upload, name: string) {
  if (upload.type.startsWith('image/'))
    return `![${name}](${upload.link})`
  return upload.type.startsWith('video/') ? `<video src="${upload.link}" />` : `<audio controls src="${upload.link}" />`
}

describeFeature(feature, ({ Background, Scenario, AfterEachScenario }) => {
  AfterEachScenario(async () => {
    renderer?.answer()
    vi.restoreAllMocks()
    await closeTestServers()
  })

  let server: TestServer
  let renderer: FakeRenderer
  let storage: FakeMediaStorage
  let ana: TestBrowser
  let deckId: string
  let projectId: string
  let claude: Client
  let auth: FakeClaudeCodeAuth
  let result: CallToolResult
  let response: Response
  /** Files uploaded in this scenario, by name. */
  let uploads: Record<string, Upload> = {}
  /** Slide 2 as a scenario put it in "Sorting". */
  let slide2: string
  const call = async (name: string, args: Record<string, unknown> = {}, client = claude) => {
    result = await client.callTool({ name, arguments: args }) as CallToolResult
    return result
  }
  const resultText = () => result.content.flatMap(item => item.type === 'text' ? [item.text] : []).join('\n')

  /** Claude Code connecting as the person signed in on `browser`, who approves or denies it. */
  async function connectAs(browser: TestBrowser, accept = true) {
    auth = new FakeClaudeCodeAuth(async (url) => {
      const page = await followInBrowser(browser, url)
      return page.pathname === '/oauth/consent' ? approveConsent(browser, page, accept) : page
    })
    return connectMcp(server, auth)
  }

  async function signInAna() {
    ana = await signedInBrowser(server, 'ana@example.com')
    projectId = (await ana.json<Project>('/api/projects', { json: { name: 'Talks' } })).body.id
    deckId = (await ana.json<{ id: string }>(`/api/projects/${projectId}/decks`, { json: { name: 'Sorting', state: demoDeckState() } })).body.id
  }

  async function markdownOfSorting() {
    await call('read_deck', { deckId })
    return (result.structuredContent as { markdown: string }).markdown
  }

  /** Uploads a file to a project's media library, as the person's browser would. */
  async function upload(browser: TestBrowser, project: string, name: string, size: number, type = 'image/png') {
    const ticket = await browser.json<UploadTicket>(`/api/projects/${project}/media`, { json: { name, type, size } })
    expect(ticket.status).toBe(201)
    const id = ticket.body.media.id
    const key = storage.links.find(link => link.kind === 'upload' && link.key.endsWith(`/${id}`))!.key
    const bytes = sampleFile(SAMPLE_KINDS[type], size)
    storage.put(key, bytes)
    expect((await browser.request(`/api/media/${id}/finish`, { method: 'POST' })).status).toBe(200)
    uploads[name] = { link: `/api/media/${id}/file`, key, type, bytes }
  }

  /** Puts a slide showing the files at position 2 of "Sorting". */
  async function showOnSlide2(...names: string[]) {
    slide2 = ['# Media', ...names.map(name => shown(uploads[name], name))].join('\n\n')
    await call('edit_slides', { deckId, edits: [{ action: 'insert', position: 2, text: slide2 }] })
    expect(result.isError).toBeFalsy()
  }

  /**
   * The files the renderer got with call `index`, by name, sorted. Each
   * must be the whole file as a `data:` URL.
   */
  function mediaWith(index: number) {
    return Object.entries(renderer.options[index]?.media ?? {}).map(([link, url]) => {
      const [name, file] = Object.entries(uploads).find(([, item]) => item.link === link) ?? [link]
      const whole = file && url === `data:${file.type};base64,${Buffer.from(file.bytes).toString('base64')}`
      expect(whole, `${name} is sent as its whole file`).toBe(true)
      return name
    }).sort()
  }

  /** Ana's diagram on slide 2 of "Sorting", the start of most media scenarios. */
  async function diagramOnSlide2() {
    await upload(ana, projectId, 'diagram.png', 2048)
    await showOnSlide2('diagram.png')
  }

  const drewDiagram = () => {
    expect(renderer.requests.map(slide => slide.content)).toEqual([slide2])
    expect(mediaWith(0)).toEqual(['diagram.png'])
  }

  function postMcp(headers: Record<string, string> = {}) {
    return server.app.request(MCP_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'accept': 'application/json, text/event-stream', ...headers },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    })
  }

  Background(({ Given, And }) => {
    Given('the Deyslide API with a slide renderer and media storage', async () => {
      renderer = new FakeRenderer()
      storage = new FakeMediaStorage()
      uploads = {}
      server = await createTestServer({ renderer, mediaStorage: storage })
    })
    And('Ana is signed in on her browser with the demo deck "Sorting" in the project "Talks"', signInAna)
  })

  Scenario('Claude Code signs in through the browser', ({ When, Then, And }) => {
    When('Claude Code calls the MCP server without a token', async () => {
      response = await postMcp()
    })
    Then('it is refused with 401 and pointed to the protected resource metadata', () => {
      expect(response.status).toBe(401)
      expect(response.headers.get('www-authenticate')).toBe(`Bearer resource_metadata="${TEST_ORIGIN}/.well-known/oauth-protected-resource/mcp"`)
    })
    And('the metadata names Deyslide\'s sign in as the authorization server', async () => {
      const metadata = await (await server.app.request(`${TEST_ORIGIN}/.well-known/oauth-protected-resource/mcp`)).json() as { resource: string, authorization_servers: string[] }
      expect(metadata.resource).toBe(MCP_URL)
      const [issuer] = metadata.authorization_servers
      const discovery = await (await server.app.request(`${TEST_ORIGIN}/.well-known/oauth-authorization-server${new URL(issuer).pathname}`)).json() as Record<string, unknown>
      expect(discovery.issuer).toBe(issuer)
      expect(discovery.registration_endpoint).toBe(`${TEST_ORIGIN}/api/auth/oauth2/register`)
      expect(discovery.code_challenge_methods_supported).toEqual(['S256'])
    })
    When('Claude Code connects and Ana approves it in her browser', async () => {
      claude = await connectAs(ana)
    })
    Then('Claude Code asked for a token for the MCP endpoint only', () => {
      expect(auth.authorizationUrl!.searchParams.get('resource')).toBe(MCP_URL)
      expect(auth.authorizationUrl!.searchParams.get('code_challenge_method')).toBe('S256')
      expect(auth.authorizationUrl!.searchParams.get('redirect_uri')).toBe(CALLBACK_URL)
    })
    And('list_decks shows the deck "Sorting" with 5 slides and its editor link', async () => {
      await call('list_decks')
      expect(resultText()).toContain(`Deck "Sorting" (id ${deckId}), 5 slides, ${TEST_ORIGIN}/p/${projectId}/d/${deckId}`)
    })
  })

  Scenario('Guests are sent to sign in first', ({ When, Then }) => {
    let landed: URL
    When('Claude Code sends a guest\'s browser to authorize', async () => {
      const guest = new Browser(server)
      auth = new FakeClaudeCodeAuth(async (url) => {
        landed = await followInBrowser(guest, url)
        return landed
      })
      await expect(connectMcp(server, auth)).rejects.toThrow()
    })
    Then('the browser lands on the sign in page with the request attached', () => {
      expect(landed.origin + landed.pathname).toBe(`${TEST_ORIGIN}/sign-in`)
      expect(landed.searchParams.get('client_id')).toBeTruthy()
      expect(landed.searchParams.get('sig')).toBeTruthy()
    })
  })

  Scenario('Ana can say no', ({ When, Then }) => {
    When('Claude Code connects and Ana denies it in her browser', async () => {
      await expect(connectAs(ana, false)).rejects.toThrow()
    })
    Then('Claude Code gets no token and the MCP server still refuses it', async () => {
      expect(auth.code).toBeUndefined()
      expect(auth.tokens()).toBeUndefined()
      expect((await postMcp()).status).toBe(401)
    })
  })

  Scenario('Tools say what they change', ({ Given, Then, And }) => {
    Given('Claude Code is connected as Ana', async () => {
      claude = await connectAs(ana)
    })
    Then('the tools are "get_guide, list_decks, create_project, create_deck, read_deck, write_deck, edit_slides, render_slides"', async () => {
      const { tools } = await claude.listTools()
      expect(tools.map(tool => tool.name).join(', ')).toBe('get_guide, list_decks, create_project, create_deck, read_deck, write_deck, edit_slides, render_slides')
      expect(tools.every(tool => tool.description && tool.title)).toBe(true)
    })
    And('"get_guide, list_decks, read_deck, render_slides" are marked read only', async () => {
      const { tools } = await claude.listTools()
      expect(tools.filter(tool => tool.annotations?.readOnlyHint).map(tool => tool.name).join(', ')).toBe('get_guide, list_decks, read_deck, render_slides')
    })
    And('the server\'s instructions explain the read, edit and render loop', () => {
      const instructions = claude.getInstructions() ?? ''
      for (const tool of ['read_deck', 'edit_slides', 'write_deck', 'render_slides', 'get_guide'])
        expect(instructions).toContain(tool)
    })
  })

  Scenario('Create a deck from Claude Code', ({ Given, When, Then, And }) => {
    let editorUrl: string
    Given('Claude Code is connected as Ana', async () => {
      claude = await connectAs(ana)
    })
    When('Claude Code creates the project "Lectures" and in it the deck "Recursion" with 3 slides', async () => {
      await call('create_project', { name: 'Lectures' })
      const lectures = (result.structuredContent as { project: { id: string } }).project.id
      await call('create_deck', { projectId: lectures, name: 'Recursion', markdown: '---\nlayout: cover\n---\n\n# Recursion\n\n---\n\n# Base case\n\n---\n\n# Recursive case\n' })
      expect(result.isError).toBeFalsy()
      editorUrl = (result.structuredContent as { deck: { editorUrl: string } }).deck.editorUrl
    })
    Then('Ana\'s account lists "Recursion" in "Lectures" with 3 slides', async () => {
      const projects = (await ana.json<Project[]>('/api/projects')).body
      const lectures = projects.find(project => project.name === 'Lectures')!
      expect(lectures.decks.map(deck => [deck.name, deck.slideCount])).toEqual([['Recursion', 3]])
    })
    And('the answer gives the deck\'s editor link', () => {
      expect(editorUrl).toMatch(new RegExp(`^${TEST_ORIGIN}/p/[^/]+/d/[^/]+$`))
      expect(resultText()).toContain(editorUrl)
    })
  })

  Scenario('Read a deck with numbered slides', ({ Given, When, Then }) => {
    Given('Claude Code is connected as Ana', async () => {
      claude = await connectAs(ana)
    })
    When('Claude Code reads the deck "Sorting"', async () => {
      await call('read_deck', { deckId })
    })
    Then('it gets 5 slides wrapped in numbered slide tags and the editor link', () => {
      expect(resultText().match(/<slide number="\d+">/g)).toEqual([1, 2, 3, 4, 5].map(number => `<slide number="${number}">`))
      expect(resultText()).toContain(`${TEST_ORIGIN}/p/${projectId}/d/${deckId}`)
    })
  })

  Scenario('Edits land in one batch', ({ Given, When, Then }) => {
    Given('Claude Code is connected as Ana', async () => {
      claude = await connectAs(ana)
    })
    When('Claude Code adds a slide "# Summary" at the end and moves it to position 2', async () => {
      await call('edit_slides', { deckId, edits: [{ action: 'insert', position: 6, text: '# Summary' }, { action: 'move', slide: 6, to: 2 }] })
      expect(result.isError).toBeFalsy()
    })
    Then('the deck has 6 slides and slide 2 is "# Summary"', async () => {
      const slides = splitSlides(await markdownOfSorting())
      expect(slides).toHaveLength(6)
      expect(slides[1].content).toBe('# Summary')
    })
  })

  Scenario('A bad edit saves nothing', ({ Given, When, Then, And }) => {
    let before: string
    Given('Claude Code is connected as Ana', async () => {
      claude = await connectAs(ana)
      before = await markdownOfSorting()
    })
    When('Claude Code sends two edits where the second breaks the frontmatter', async () => {
      await call('edit_slides', { deckId, edits: [
        { action: 'replace', slide: 1, text: '# Changed' },
        { action: 'replace', slide: 2, text: '---\nlayout: [center\n---\n\n# Broken' },
      ] })
    })
    Then('the answer says "Nothing was saved. Edit 2 (replace) failed: The frontmatter is not valid YAML"', () => {
      expect(result.isError).toBe(true)
      expect(resultText()).toContain('Nothing was saved. Edit 2 (replace) failed: The frontmatter is not valid YAML')
    })
    And('the deck still has its 5 original slides', async () => {
      expect(await markdownOfSorting()).toBe(before)
    })
  })

  Scenario('A whole deck that is not valid is refused', ({ Given, When, Then }) => {
    Given('Claude Code is connected as Ana', async () => {
      claude = await connectAs(ana)
    })
    When('Claude Code writes a deck whose first frontmatter is broken', async () => {
      await call('write_deck', { deckId, markdown: '---\ntitle: [oops\n---\n\n# Hello\n' })
    })
    Then('the answer starts with "Nothing was saved. The frontmatter is not valid YAML."', () => {
      expect(result.isError).toBe(true)
      expect(resultText().startsWith('Nothing was saved. The frontmatter is not valid YAML.')).toBe(true)
    })
  })

  Scenario('See slides as images', ({ Given, And, When, Then }) => {
    Given('Claude Code is connected as Ana', async () => {
      claude = await connectAs(ana)
    })
    And('the renderer reports that slide 3 overflows', () => {
      renderer.overflowing.add('# Spatial zoom')
    })
    When('Claude Code renders slides 1 and 3 of "Sorting"', async () => {
      await call('render_slides', { deckId, slides: [1, 3] })
    })
    Then('it gets two PNG images with each slide\'s click count', () => {
      const images = result.content.filter(item => item.type === 'image')
      expect(images).toHaveLength(2)
      expect(images.every(image => image.type === 'image' && image.mimeType === 'image/png' && image.data === PIXEL)).toBe(true)
      expect(resultText()).toContain('Slide 1: 2 clicks, fits the slide.')
    })
    And('slide 3 is reported as overflowing', () => {
      expect(resultText()).toContain('Slide 3: 2 clicks, content overflows the slide: shorten it or split it.')
      expect(result.structuredContent).toEqual({ slides: [
        { number: 1, clicks: 2, overflow: false, error: null },
        { number: 3, clicks: 2, overflow: true, error: null },
      ] })
    })
    And('the renderer drew slide 3 with the deck\'s headmatter at its last click', () => {
      const third = renderer.requests[1]
      expect(third.content).toContain('# Spatial zoom')
      expect(third.frontmatter.layout).toBe('two-cols')
      expect(third.headmatter.title).toBe('Deyslide')
      expect(third.first).toBe(false)
      expect(third.clicks).toBeGreaterThanOrEqual(1000)
    })
  })

  Scenario('Slide images show the project\'s media', ({ Given, And, When, Then }) => {
    Given('Claude Code is connected as Ana', async () => {
      claude = await connectAs(ana)
    })
    And('Ana uploaded "diagram.png" to "Talks" and slide 2 of "Sorting" shows it', diagramOnSlide2)
    When('Claude Code renders slide 2 of "Sorting"', async () => {
      await call('render_slides', { deckId, slides: [2] })
      expect(result.isError).toBeFalsy()
    })
    Then('the renderer got "diagram.png" as a data URL with slide 2', drewDiagram)
    And('the answer leaves nothing out', () => {
      expect(resultText()).not.toContain('left out')
    })
  })

  Scenario('Files the person may not open stay out of slide images', ({ Given, And, When, Then }) => {
    Given('Claude Code is connected as Ana', async () => {
      claude = await connectAs(ana)
    })
    And('Budi uploaded "secret.png" to a project of Budi\'s own', async () => {
      const budi = await signedInBrowser(server, 'budi@example.com', 'Budi')
      await upload(budi, (await budi.json<Project>('/api/projects', { json: { name: 'Private' } })).body.id, 'secret.png', 2048)
    })
    And('Ana uploaded "diagram.png" to "Talks", and slide 2 of "Sorting" shows both files', async () => {
      await upload(ana, projectId, 'diagram.png', 2048)
      await showOnSlide2('diagram.png', 'secret.png')
    })
    When('Claude Code renders slide 2 of "Sorting"', async () => {
      await call('render_slides', { deckId, slides: [2] })
      expect(result.isError).toBeFalsy()
    })
    Then('the renderer got "diagram.png" as a data URL with slide 2', drewDiagram)
    And('the answer leaves nothing out', () => {
      expect(resultText()).not.toContain('left out')
    })
  })

  Scenario('Someone given only one deck sees its media in slide images', ({ Given, And, When, Then }) => {
    let budi: Client
    Given('Claude Code is connected as Ana', async () => {
      claude = await connectAs(ana)
    })
    And('Ana uploaded "diagram.png" to "Talks" and slide 2 of "Sorting" shows it', diagramOnSlide2)
    And('Ana shares only the deck "Sorting" with Budi', async () => {
      const budiBrowser = await signedInBrowser(server, 'budi@example.com', 'Budi')
      expect((await ana.json(`/api/decks/${deckId}/sharing`, { json: { email: 'budi@example.com', role: 'viewer' } })).status).toBe(201)
      budi = await connectAs(budiBrowser)
    })
    When('Budi\'s Claude Code renders slide 2 of "Sorting"', async () => {
      await call('render_slides', { deckId, slides: [2] }, budi)
      expect(result.isError).toBeFalsy()
    })
    Then('the renderer got "diagram.png" as a data URL with slide 2', drewDiagram)
  })

  Scenario('Slide images carry at most 20 MB of media, pictures first, and name what they leave out', ({ Given, And, When, Then }) => {
    Given('Claude Code is connected as Ana', async () => {
      claude = await connectAs(ana)
    })
    And('slide 2 of "Sorting" shows these files from "Talks":', async (_, files: { name: string, type: string, size: string }[]) => {
      for (const file of files)
        await upload(ana, projectId, file.name, Number.parseInt(file.size) * MB, file.type)
      await showOnSlide2(...files.map(file => file.name))
    })
    When('Claude Code renders slide 2 of "Sorting"', async () => {
      await call('render_slides', { deckId, slides: [2] })
      expect(result.isError).toBeFalsy()
    })
    Then('the renderer drew slide 2 with "chart.png" and "photo.png" as data URLs', () => {
      expect(renderer.requests.map(slide => slide.content)).toEqual([slide2])
      expect(mediaWith(0)).toEqual(['chart.png', 'photo.png'])
    })
    And('the answer says "poster.png" is too big on its own and "clip.mp4" had no room left', () => {
      expect(resultText()).toContain([
        'Media left out of these images (one call carries at most 20 MB):',
        `- ${uploads['poster.png'].link}: larger than that on its own`,
        `- ${uploads['clip.mp4'].link}: no room left after the other files`,
        `Editor: `,
      ].join('\n'))
    })
    And('"talk.mp3" is neither sent nor named, since an image shows no sound', () => {
      expect(mediaWith(0)).not.toContain('talk.mp3')
      expect(resultText()).not.toContain(uploads['talk.mp3'].link)
    })
  })

  Scenario('A file storage cannot read is left out of slide images', ({ Given, And, When, Then, But }) => {
    Given('Claude Code is connected as Ana', async () => {
      claude = await connectAs(ana)
    })
    And('Ana uploaded "diagram.png" and "chart.png" to "Talks", and slide 2 of "Sorting" shows both', async () => {
      await upload(ana, projectId, 'diagram.png', 2048)
      await upload(ana, projectId, 'chart.png', 4096)
      await showOnSlide2('diagram.png', 'chart.png')
    })
    But('storage cannot read "chart.png" right now', () => {
      storage.unreadable.add(uploads['chart.png'].key)
      // The server logs each failed read.
      vi.spyOn(console, 'error').mockImplementation(() => {})
    })
    When('Claude Code renders slide 2 of "Sorting"', async () => {
      await call('render_slides', { deckId, slides: [2] })
      expect(result.isError).toBeFalsy()
    })
    Then('the renderer got "diagram.png" as a data URL with slide 2', drewDiagram)
    And('the answer says storage could not read "chart.png" just now', () => {
      expect(resultText()).toContain(`Media left out of these images (one call carries at most 20 MB):\n- ${uploads['chart.png'].link}: storage could not read it just now\n`)
      expect(console.error).toHaveBeenCalledWith(`Could not read ${uploads['chart.png'].link} for slide images:`, expect.any(StorageError))
    })
  })

  Scenario('Slide images carry media for a few calls at a time', ({ Given, And, When, Then }) => {
    let calls: Promise<CallToolResult>[]
    const answered: CallToolResult[] = []
    Given('Claude Code is connected as Ana', async () => {
      claude = await connectAs(ana)
    })
    And('Ana uploaded "diagram.png" to "Talks" and slide 2 of "Sorting" shows it', diagramOnSlide2)
    And('the renderer takes a while to answer', () => {
      renderer.hold()
    })
    When('Claude Code asks for slide 2 of "Sorting" 7 times at once', () => {
      calls = Array.from({ length: 7 }, async () => {
        const answer = await claude.callTool({ name: 'render_slides', arguments: { deckId, slides: [2] } }) as CallToolResult
        answered.push(answer)
        return answer
      })
    })
    Then('2 of the calls reach the renderer and one is told "Slide images are busy right now. Try again in a minute."', async () => {
      await vi.waitFor(() => expect(answered).toHaveLength(1), SOON)
      expect(answered[0]).toEqual({ content: [{ type: 'text', text: 'Slide images are busy right now. Try again in a minute.' }], isError: true })
      await vi.waitFor(() => expect(renderer.drawing).toBe(2), SOON)
      expect(answered).toHaveLength(1)
    })
    When('the renderer answers', () => {
      renderer.answer()
    })
    Then('the other 6 calls get their images, with never more than 2 at the renderer at once', async () => {
      const drawn = (await Promise.all(calls)).filter(answer => !answer.isError)
      expect(drawn).toHaveLength(6)
      expect(drawn.every(answer => answer.content.some(item => item.type === 'image'))).toBe(true)
      expect(renderer.options.map((_, index) => mediaWith(index))).toEqual(Array.from({ length: 6 }, () => ['diagram.png']))
      expect(renderer.mostAtOnce).toBe(2)
    })
  })

  Scenario('No renderer, no images', ({ Given, And, When, Then }) => {
    Given('the Deyslide API without a slide renderer', async () => {
      server = await createTestServer()
    })
    And('Ana is signed in on her browser with the demo deck "Sorting" in the project "Talks"', signInAna)
    And('Claude Code is connected as Ana', async () => {
      claude = await connectAs(ana)
    })
    When('Claude Code renders slides 1 and 3 of "Sorting"', async () => {
      await call('render_slides', { deckId, slides: [1, 3] })
    })
    Then('the answer says slide images are not available', () => {
      expect(result.isError).toBe(true)
      expect(resultText()).toBe('Slide images are not available on this Deyslide server. Check the Markdown with read_deck instead.')
    })
  })

  Scenario('Other accounts stay out of reach', ({ Given, When, Then, And }) => {
    let budi: Client
    Given('Budi connects Claude Code to Budi\'s account', async () => {
      budi = await connectAs(await signedInBrowser(server, 'budi@example.com'))
    })
    When('Budi\'s Claude Code reads Ana\'s deck "Sorting"', async () => {
      await call('read_deck', { deckId }, budi)
    })
    Then('it is told "There is no deck with that id in this account. Call list_decks to see the decks."', () => {
      expect(result.isError).toBe(true)
      expect(resultText()).toBe('There is no deck with that id in this account. Call list_decks to see the decks.')
    })
    And('Budi\'s list_decks is empty', async () => {
      await call('list_decks', {}, budi)
      expect(resultText()).toBe('This account has no projects yet. Create one with create_project.')
    })
  })

  Scenario('Decks shared with you follow your role', ({ Given, And, Then, But }) => {
    let budi: Client
    let budiBrowser: TestBrowser
    Given('Ana shared the project "Talks" with Budi as a viewer', async () => {
      budiBrowser = await signedInBrowser(server, 'budi@example.com', 'Budi')
      const shared = await ana.json(`/api/projects/${projectId}/sharing`, { json: { email: 'budi@example.com', role: 'viewer' } })
      expect(shared.status).toBe(201)
    })
    And('Budi connects Claude Code to Budi\'s account', async () => {
      budi = await connectAs(budiBrowser)
    })
    Then('Budi\'s list_decks shows "Sorting" shared by Ana as view only', async () => {
      await call('list_decks', {}, budi)
      expect(resultText()).toContain('Shared with you:')
      expect(resultText()).toContain(`Deck "Sorting" (id ${deckId}), 5 slides, view only`)
    })
    And('Budi\'s Claude Code can read the deck "Sorting"', async () => {
      await call('read_deck', { deckId }, budi)
      expect(result.isError).toBeFalsy()
      expect(resultText()).toContain('<slide number="5">')
    })
    But('writing it is refused with "Nothing was saved. You can view this deck but not change it."', async () => {
      await call('write_deck', { deckId, markdown: '# Mine\n' }, budi)
      expect(result.isError).toBe(true)
      expect(resultText()).toBe('Nothing was saved. You can view this deck but not change it.')
      await call('edit_slides', { deckId, edits: [{ action: 'delete', slide: 1 }] }, budi)
      expect(resultText()).toBe('Nothing was saved. You can view this deck but not change it.')
    })
  })

  Scenario('A token from somewhere else is refused', ({ When, Then }) => {
    When('Claude Code calls the MCP server with a made up token', async () => {
      response = await postMcp({ authorization: 'Bearer eyJhbGciOiJub25lIn0.eyJzdWIiOiJhbmEifQ.' })
    })
    Then('it is refused with 401 and told the token is invalid', () => {
      expect(response.status).toBe(401)
      expect(response.headers.get('www-authenticate')).toContain('error="invalid_token"')
    })
  })
})
