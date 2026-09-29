// @vitest-environment node
import type { Client } from '@modelcontextprotocol/sdk/client/index.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import type { RenderedSlide, SlideRenderer, SlideToRender } from '../apps/server/src/mcp/renderer'
import type { Project } from '../apps/server/src/projects'
import type { TestBrowser, TestServer } from './support/server'
import { describeFeature, loadFeature } from '@amiceli/vitest-cucumber'
import { beforeAll, expect } from 'vitest'
import { splitSlides } from '../packages/deck-model/src'
import { demoDeckState } from './support/deck-content'
import { approveConsent, CALLBACK_URL, connectMcp, FakeClaudeCodeAuth, followInBrowser } from './support/mcp-client'
import { createTestServer, DATABASE_WARM_UP_MS, TEST_ORIGIN, TestBrowser as Browser, signedInBrowser, warmUpDatabase } from './support/server'

const feature = await loadFeature('./mcp.feature')

beforeAll(warmUpDatabase, DATABASE_WARM_UP_MS)

/** A 1 by 1 PNG, standing in for a slide image. */
const PIXEL = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII='

class FakeRenderer implements SlideRenderer {
  readonly requests: SlideToRender[] = []
  overflowing = new Set<string>()

  async render(slides: SlideToRender[]): Promise<RenderedSlide[]> {
    this.requests.push(...slides)
    return slides.map(slide => ({ png: PIXEL, clicks: 2, overflow: [...this.overflowing].some(text => slide.content.includes(text)) }))
  }
}

const MCP_URL = `${TEST_ORIGIN}/mcp`

describeFeature(feature, ({ Background, Scenario }) => {
  let server: TestServer
  let renderer: FakeRenderer
  let ana: TestBrowser
  let deckId: string
  let projectId: string
  let claude: Client
  let auth: FakeClaudeCodeAuth
  let result: CallToolResult
  let response: Response

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

  function postMcp(headers: Record<string, string> = {}) {
    return server.app.request(MCP_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'accept': 'application/json, text/event-stream', ...headers },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    })
  }

  Background(({ Given, And }) => {
    Given('the Deyslide API with a slide renderer', async () => {
      renderer = new FakeRenderer()
      server = await createTestServer({ renderer })
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
    Given('Budi connects Claude Code to his own account', async () => {
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
