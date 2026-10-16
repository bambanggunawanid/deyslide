import type { RenderRequest } from '../apps/web/src/preview/protocol'
import type { WebApp } from './support/web'
import { describeFeature, loadFeature } from '@amiceli/vitest-cucumber'
import { expect, vi } from 'vitest'
import { effectScope } from 'vue'
import { GuestStore } from '../apps/web/src/guest/store'
import { MemoryGuestStorage } from '../apps/web/src/guest/memory-storage'
import { clearMediaLinks, knownMedia, mediaAddress, mediaOwner, resolveMedia, useMediaRequest } from '../apps/web/src/platform/media'
import { startPlatform } from '../apps/web/src/platform/platform'
import { FakeAccountService } from './support/account'
import { fromMarkdown } from '../packages/deck-model/src'
import { previewRequests, resetEditorDoubles } from './support/editor-doubles'
import { FakeIntersectionObserver } from './support/intersection-observer'
import { accountDeck } from './support/live-decks'
import { FakeMediaApi } from './support/media-api'
import { FakeProjectApi } from './support/project-api'
import { FakeResizeObserver } from './support/resize-observer'
import { find, findAll, mountWebApp, text } from './support/web'

// A stand in for the Deyslide app: its commands and its http plugin.
const app = vi.hoisted(() => ({ invoke: vi.fn(), httpFetch: vi.fn() }))

vi.mock('@tauri-apps/api/core', () => ({ invoke: app.invoke }))
// The plugin is a dependency of apps/web only, so it is mocked by the file the pages load.
vi.mock('../apps/web/node_modules/@tauri-apps/plugin-http/dist-js/index.js', () => ({ fetch: app.httpFetch }))

const feature = await loadFeature('./media-links.feature')

const MINUTE = 60_000
const START = new Date('2026-10-15T09:00:00.000Z').getTime()

/** A request the page made: where, and how. */
interface Asked {
  url: string
  init?: RequestInit
}

describeFeature(feature, ({ Scenario, BeforeEachScenario, AfterEachScenario }) => {
  let library: FakeMediaApi
  let asked: Asked[]
  let links: Record<string, string>
  let first: Record<string, string>
  let together: Record<string, string>[]
  let web: WebApp | undefined
  let restore: (() => void)[]

  BeforeEachScenario(() => {
    clearMediaLinks()
    library = new FakeMediaApi()
    asked = []
    restore = []
    app.invoke.mockReset()
    app.httpFetch.mockReset()
  })

  AfterEachScenario(() => {
    web?.unmount()
    web = undefined
    for (const undo of restore.reverse())
      undo()
    vi.useRealTimers()
    vi.unstubAllEnvs()
    mediaOwner(undefined)
    clearMediaLinks()
    resetEditorDoubles()
    FakeResizeObserver.reset()
    FakeIntersectionObserver.reset()
  })

  /** Swaps a global for the scenario. */
  function swap<K extends keyof typeof globalThis>(name: K, value: (typeof globalThis)[K]) {
    const original = globalThis[name]
    globalThis[name] = value
    restore.push(() => {
      globalThis[name] = original
    })
  }

  /** The browser's fetch answers from the fake library, and remembers what it was asked. */
  function browserAnswers(answer: (input: RequestInfo | URL) => Promise<Response> = library.fetch) {
    swap('fetch', (async (input: RequestInfo | URL, init?: RequestInit) => {
      asked.push({ url: String(input), init })
      return answer(input)
    }) as typeof fetch)
  }

  function at(time: number) {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(time)
  }

  /** A file the scenarios name by its id. */
  const fileNamed = (id: string) => library.add('project-1', `${id}.png`, { id })

  const signed = (id: string) => expect.stringMatching(new RegExp(`^https://storage\\.example/${id}\\?signature=\\d+$`))

  Scenario('A slide\'s media gets signed links, kept until they are about to expire', ({ Given, When, Then }) => {
    Given('the project file "m1", whose signed links last 15 minutes', () => {
      fileNamed('m1')
      library.linkSeconds = 15 * 60
      browserAnswers()
      at(START)
    })
    When('the page asks for links to "/api/media/m1/file" and "https://example.com/cat.png"', async () => {
      first = await resolveMedia(['/api/media/m1/file', 'https://example.com/cat.png'])
    })
    Then('it gets a signed link for "/api/media/m1/file" only, after asking the API once with the session cookie', () => {
      expect(first).toEqual({ '/api/media/m1/file': signed('m1') })
      expect(asked.map(request => request.url)).toEqual(['/api/media/m1'])
      expect(asked[0].init?.credentials).toBe('same-origin')
    })
    When('it asks again 13 minutes later', async () => {
      at(START + 13 * MINUTE)
      links = await resolveMedia(['/api/media/m1/file'])
    })
    Then('it gets the same link without asking the API', () => {
      expect(links).toEqual(first)
      expect(asked).toHaveLength(1)
    })
    When('it asks again 14 and a half minutes after the first time', async () => {
      at(START + 14.5 * MINUTE)
      links = await resolveMedia(['/api/media/m1/file'])
    })
    Then('it asks the API for a fresh link, since the old one stops working within a minute', () => {
      expect(asked).toHaveLength(2)
      expect(links['/api/media/m1/file']).toEqual(signed('m1'))
      expect(links['/api/media/m1/file']).not.toBe(first['/api/media/m1/file'])
    })
  })

  Scenario('Parts of the page asking at the same time share one request', ({ Given, When, Then }) => {
    Given('the project file "m1", whose signed links last 15 minutes', () => {
      fileNamed('m1')
      browserAnswers()
    })
    When('the slide and two strip pictures ask for "/api/media/m1/file" at the same time', async () => {
      together = await Promise.all([1, 2, 3].map(() => resolveMedia(['/api/media/m1/file'])))
    })
    Then('the API is asked once, and all three get the same link', () => {
      expect(asked).toHaveLength(1)
      expect(new Set(together.map(result => result['/api/media/m1/file'])).size).toBe(1)
      expect(together[0]['/api/media/m1/file']).toEqual(signed('m1'))
    })
  })

  Scenario('A file the server will not link is left out, and asked for again later', ({ Given, When, Then }) => {
    Given('the server has no file "gone"', () => {
      browserAnswers()
      at(START)
    })
    When('the page asks for a link to "/api/media/gone/file"', async () => {
      links = await resolveMedia(['/api/media/gone/file'])
    })
    Then('it gets no link for "/api/media/gone/file"', () => {
      expect(links).toEqual({})
      expect(asked.map(request => request.url)).toEqual(['/api/media/gone'])
    })
    When('it asks again 10 seconds later', async () => {
      at(START + 10_000)
      links = await resolveMedia(['/api/media/gone/file'])
    })
    Then('the API was asked once only', () => {
      expect(links).toEqual({})
      expect(asked).toHaveLength(1)
    })
    When('it asks again 31 seconds after the first time', async () => {
      at(START + 31_000)
      links = await resolveMedia(['/api/media/gone/file'])
    })
    Then('the API was asked twice', () => {
      expect(asked).toHaveLength(2)
    })
  })

  Scenario('A server out of reach leaves the file out without failing', ({ Given, When, Then }) => {
    Given('the server cannot be reached', () => {
      browserAnswers(async () => {
        throw new TypeError('Failed to fetch')
      })
    })
    When('the page asks for a link to "/api/media/m1/file"', async () => {
      links = await resolveMedia(['/api/media/m1/file'])
    })
    Then('it gets no link for "/api/media/m1/file"', () => {
      expect(links).toEqual({})
      expect(asked).toHaveLength(1)
    })
  })

  Scenario('In the app, links come from the app\'s server with its token', ({ Given, And, When, Then }) => {
    Given('the app on a computer, signed in, using the server "https://deyslide.example"', async () => {
      vi.stubEnv('VITE_APP', '1')
      app.invoke.mockImplementation(async (command: string) => {
        if (command === 'app_info')
          return { version: '0.2.0', platform: 'linux', serverUrl: 'https://deyslide.example' }
        if (command === 'auth_access_token')
          return 'token-1'
        throw new Error(`The fake app has no command ${command}`)
      })
      await startPlatform()
      // The page's own fetch must not be used for the API.
      browserAnswers(async () => {
        throw new Error('The app asked the API without its http plugin')
      })
    })
    And('the project file "m1", whose signed links last 15 minutes', () => {
      fileNamed('m1')
      app.httpFetch.mockImplementation(async (url: string) => library.fetch(new URL(url).pathname))
    })
    When('the page asks for a link to "/api/media/m1/file"', async () => {
      links = await resolveMedia(['/api/media/m1/file'])
    })
    Then('the request went to "https://deyslide.example/api/media/m1" through the app\'s http plugin, with the app\'s token', () => {
      expect(asked).toEqual([])
      expect(app.httpFetch).toHaveBeenCalledTimes(1)
      const [url, init] = app.httpFetch.mock.calls[0] as [string, RequestInit]
      expect(url).toBe('https://deyslide.example/api/media/m1')
      expect(new Headers(init.headers).get('authorization')).toBe('Bearer token-1')
    })
    And('the page gets the signed link', () => {
      expect(links).toEqual({ '/api/media/m1/file': signed('m1') })
    })
  })

  Scenario('The preview waits for the links its slide needs, in every view and in the strip', ({ Given, And, Then, When }) => {
    let address: string
    let answer: () => void
    const withImage = (request: RenderRequest | undefined) => request?.slide.content.includes('![Cat]')
    const pictureRequests = () => web!.wrapper.findAllComponents({ name: 'SlidePreviewFrame' })
      .map(frame => frame.props('request') as RenderRequest | undefined)
      .filter((request): request is RenderRequest => request?.mode === 'print')
    Given('Ana\'s deck shows a project image on its first slide, on a wide screen, in the Markdown view', async () => {
      const original = window.matchMedia
      window.matchMedia = ((query: string) => ({ matches: query.includes('min-width: 1024px'), media: query, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia
      restore.push(() => {
        window.matchMedia = original
      })
      swap('IntersectionObserver', FakeIntersectionObserver as unknown as typeof IntersectionObserver)
      const service = new FakeAccountService()
      service.addAccount('ana@example.com', 'correct horse', 'Ana')
      await service.signIn({ email: 'ana@example.com', password: 'correct horse' })
      const api = new FakeProjectApi()
      address = mediaAddress(library.add('project-1', 'cat.png').id)
      const { projectId, deckId } = await accountDeck(api, `# Pets\n\n![Cat](${address})\n`, 'Pets')
      const gate = new Promise<void>((resolve) => {
        answer = resolve
      })
      browserAnswers(async (input) => {
        await gate
        return library.fetch(input)
      })
      web = await mountWebApp({ service, api, media: library, view: 'markdown' })
      await web.router.push({ name: 'deck', params: { projectId, deckId } })
      await web.waitFor('[data-testid="markdown-view"]')
    })
    And('the API takes a while to answer', async () => {
      await vi.waitFor(() => expect(asked.map(request => request.url)).toContain(address.replace(/\/file$/, '')))
    })
    Then('the preview has not been asked to render the slide yet', () => {
      expect(previewRequests.filter(withImage)).toEqual([])
    })
    When('the API answers', async () => {
      answer()
      await web!.settle()
    })
    Then('the preview renders the slide with a signed link for the image', async () => {
      await vi.waitFor(() => expect(previewRequests.filter(withImage)).toHaveLength(1))
      expect(previewRequests.filter(withImage)[0].media).toEqual({ [address]: expect.stringMatching(/^https:\/\/storage\.example\//) })
    })
    When('Ana switches to the Design view', async () => {
      const before = previewRequests.length
      await web!.click('[data-testid="view-design"]')
      await vi.waitFor(() => expect(find('[data-testid="slide-stage"]')).not.toBeNull())
      FakeResizeObserver.resizeAll(980, 551.25)
      await web!.settle()
      await vi.waitFor(() => expect(previewRequests.length).toBeGreaterThan(before))
    })
    Then('the slide on the canvas gets the same link', () => {
      const shown = previewRequests.at(-1)!
      expect(withImage(shown)).toBe(true)
      expect(shown.media).toEqual(previewRequests.filter(withImage)[0].media)
    })
    When('the strip\'s first slide comes into view', async () => {
      FakeIntersectionObserver.report(target => (target as HTMLElement).dataset?.slideId ? true : undefined)
      await web!.settle()
      await vi.waitFor(() => expect(findAll('[data-testid="strip-thumbnail"]')).toHaveLength(1))
    })
    Then('the strip\'s picture of the slide gets the same link too', async () => {
      await vi.waitFor(() => expect(pictureRequests()).toHaveLength(1))
      expect(pictureRequests()[0].media).toEqual(previewRequests.filter(withImage)[0].media)
    })
  })

  Scenario('Signed links stay with the account that asked for them', ({ Given, And, When, Then }) => {
    let signedOut = false
    let gate: Promise<void> | undefined
    let answer = () => {}
    let late: Promise<Record<string, string>>
    Given('the project file "m1", whose signed links last 15 minutes', () => {
      fileNamed('m1')
      // The API gives links to Ana only, and holds an answer while the scenario keeps the gate shut.
      browserAnswers(async (input) => {
        await gate
        return signedOut ? Response.json({ error: 'Sign in first' }, { status: 401 }) : library.fetch(input)
      })
    })
    And('Ana\'s page has a link for "/api/media/m1/file"', async () => {
      mediaOwner('ana')
      links = await resolveMedia(['/api/media/m1/file'])
      expect(links).toEqual({ '/api/media/m1/file': signed('m1') })
    })
    When('Ana signs out and the page asks for that link for a guest', async () => {
      signedOut = true
      mediaOwner(undefined)
      links = await resolveMedia(['/api/media/m1/file'])
    })
    Then('the API is asked again, and the guest gets no link', () => {
      expect(asked).toHaveLength(2)
      expect(links).toEqual({})
    })
    When('a link asked for on Ana\'s behalf arrives after someone else signed in', async () => {
      signedOut = false
      mediaOwner('ana')
      gate = new Promise<void>((resolve) => {
        answer = resolve
      })
      late = resolveMedia(['/api/media/m1/file'])
      await vi.waitFor(() => expect(asked).toHaveLength(3))
      mediaOwner('budi')
      answer()
    })
    Then('the page does not keep it', async () => {
      expect(await late).toEqual({})
      expect(knownMedia(['/api/media/m1/file'])).toEqual({ links: {}, missing: ['/api/media/m1/file'] })
    })
  })

  Scenario('A preview waiting for a link when the account changes asks again', ({ Given, And, When, Then }) => {
    let answer = () => {}
    let request: ReturnType<typeof useMediaRequest>
    const scope = effectScope()
    /** Who the API gives links to: the account whose page asked. */
    const owners: string[] = []
    let owner = 'ana'
    Given('the project file "m1", whose signed links last 15 minutes', () => {
      restore.push(() => scope.stop())
      fileNamed('m1')
      const gate = new Promise<void>((resolve) => {
        answer = resolve
      })
      browserAnswers(async (input) => {
        owners.push(owner)
        // Ana's answer is held; later ones come at once.
        if (owners.length === 1)
          await gate
        return library.fetch(input)
      })
    })
    And('a slide on Ana\'s page waits for a link to "/api/media/m1/file"', async () => {
      mediaOwner('ana')
      const slide = { id: 'r1', slide: { content: '![Cat](/api/media/m1/file)', frontmatter: {} } } as unknown as RenderRequest
      request = scope.run(() => useMediaRequest(() => slide))!
      await vi.waitFor(() => expect(asked).toHaveLength(1))
      expect(request.value).toBeUndefined()
    })
    When('Budi signs in on the page before the API answers', async () => {
      owner = 'budi'
      mediaOwner('budi')
      answer()
      await vi.waitFor(() => expect(asked.length).toBeGreaterThan(1))
    })
    Then('the API is asked again, for Budi', () => {
      expect(owners).toEqual(['ana', 'budi'])
    })
    And('the slide is rendered with the link Budi got', async () => {
      await vi.waitFor(() => expect(request.value?.media).toEqual({ '/api/media/m1/file': signed('m1') }))
    })
  })

  Scenario('The deck page asks for links afresh after signing out', ({ Given, And, When, Then }) => {
    let address: string
    let guest: GuestStore
    let markdown: string
    let signedOut = false
    const withImage = (request: RenderRequest | undefined) => request?.slide.content.includes('![Cat]')
    Given('Ana\'s signed in deck shows a project image', async () => {
      const service = new FakeAccountService()
      service.addAccount('ana@example.com', 'correct horse', 'Ana')
      await service.signIn({ email: 'ana@example.com', password: 'correct horse' })
      const api = new FakeProjectApi()
      address = mediaAddress(library.add('project-1', 'cat.png').id)
      markdown = `# Pets\n\n![Cat](${address})\n`
      const { projectId, deckId } = await accountDeck(api, markdown, 'Pets')
      guest = await GuestStore.open(new MemoryGuestStorage())
      // The API answers signed in pages only.
      browserAnswers(async input => signedOut ? Response.json({ error: 'Sign in first' }, { status: 401 }) : library.fetch(input))
      web = await mountWebApp({ service, api, guest, media: library, view: 'markdown' })
      await web.router.push({ name: 'deck', params: { projectId, deckId } })
      await web.waitFor('[data-testid="markdown-view"]')
    })
    And('Ana\'s preview has a signed link for the image', async () => {
      await vi.waitFor(() => expect(previewRequests.filter(withImage).at(-1)?.media).toEqual({ [address]: expect.stringMatching(/^https:\/\/storage\.example\//) }))
      expect(asked).toHaveLength(1)
    })
    When('Ana signs out and opens a deck in this browser that shows the same image', async () => {
      const before = previewRequests.length
      const trigger = await web!.waitFor('[data-testid="account-menu"]')
      trigger.focus()
      trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
      await web!.settle()
      await web!.click('[data-testid="sign-out"]')
      await vi.waitFor(() => expect(find('[data-testid="account-menu"]')).toBeNull())
      signedOut = true
      // Signing in moves a browser's projects into the account, so this one is made after.
      const project = await guest.createProject('Copied')
      const deck = await guest.createDeck(project.id, 'Pets', 'blank')
      await guest.saveDeck(project.id, deck.id, fromMarkdown(markdown))
      await web!.router.push({ name: 'deck', params: { projectId: project.id, deckId: deck.id }, query: { view: 'markdown' } })
      await web!.waitFor('[data-testid="markdown-view"]')
      await vi.waitFor(() => expect(previewRequests.slice(before).filter(withImage)).not.toHaveLength(0))
    })
    Then('the page asks the API again, and its preview gets no link from Ana\'s account', () => {
      expect(text('[data-testid="deck-name"]')).toBe('Pets')
      expect(asked).toHaveLength(2)
      expect(previewRequests.filter(withImage).at(-1)!.media).toBeUndefined()
    })
  })
})
