import type { DeckSession } from '../apps/web/src/deck/session'
import type { WebApp } from './support/web'
import { describeFeature, loadFeature } from '@amiceli/vitest-cucumber'
import { expect, vi } from 'vitest'
import { VIEW_STORAGE_KEY } from '../apps/web/src/deck/view'
import { MemoryGuestStorage } from '../apps/web/src/guest/memory-storage'
import { GuestStore } from '../apps/web/src/guest/store'
import { CloudStore } from '../apps/web/src/projects/cloud-store'
import { readDeckDoc, splitSlides, toMarkdown } from '../packages/deck-model/src'
import { FakeAccountService } from './support/account'
import { editorJumps, previewRequests, resetEditorDoubles } from './support/editor-doubles'
import { introduce, openReady, setSlides, slidesOf } from './support/live-decks'
import { FakeProjectApi } from './support/project-api'
import { find, findAll, mountWebApp, text } from './support/web'

const feature = await loadFeature('./deck-page.feature')

describeFeature(feature, ({ Scenario, AfterEachScenario }) => {
  let web: WebApp
  let guest: GuestStore
  let api: FakeProjectApi
  let service: FakeAccountService
  let projectId: string
  let deckId: string
  let budi: DeckSession | undefined

  AfterEachScenario(() => {
    budi?.close()
    budi = undefined
    web?.unmount()
    resetEditorDoubles()
    vi.restoreAllMocks()
  })

  const editor = () => find('[data-testid="markdown-editor"]') as HTMLTextAreaElement | null
  const lastRequest = () => previewRequests.at(-1)!
  const position = () => text('[data-testid="slide-position"]')

  async function deckInBrowser(template: 'blank' | 'demo', name: string) {
    guest = await GuestStore.open(new MemoryGuestStorage())
    projectId = (await guest.createProject('Talks')).id
    deckId = (await guest.createDeck(projectId, name, template)).id
  }

  async function openDeck(query?: Record<string, string>) {
    await web.router.push({ name: 'deck', params: { projectId, deckId }, query })
    await vi.waitFor(() => expect(find('[data-testid="slide-position"]')).not.toBeNull())
    await web.settle()
  }

  async function signedInWith(template: 'blank' | 'demo', name: string) {
    service = new FakeAccountService()
    service.addAccount('ana@example.com', 'correct horse', 'Ana')
    await service.signIn({ email: 'ana@example.com', password: 'correct horse' })
    api = new FakeProjectApi()
    projectId = (await api.createProject('Talks')).id
    web = await mountWebApp({ service, api })
    deckId = (await web.workspace.store.value.createDeck(projectId, name, template)).id
    await openDeck()
  }

  const designShown = (Then: (title: string, run: () => void) => void) =>
    Then('the page shows the Design view with the slide preview and "Slide 1 of 1"', () => {
      expect(find('[data-testid="design-view"]')).not.toBeNull()
      expect(find('[data-testid="preview-frame"]')).not.toBeNull()
      expect(position()).toBe('Slide 1 of 1')
      expect(find('[data-testid="view-design"]')!.getAttribute('aria-pressed')).toBe('true')
    })

  Scenario('A deck opens in the Design view', ({ Given, When, Then, And }) => {
    Given('the blank deck "Graphs" is in this browser', () => deckInBrowser('blank', 'Graphs'))
    When('I open the deck', async () => {
      web = await mountWebApp({ guest })
      await openDeck()
    })
    designShown(Then)
    And('there is no Markdown editor', () => {
      expect(editor()).toBeNull()
    })
  })

  Scenario('Switching to Markdown shows the editor and is remembered', ({ Given, And, When, Then }) => {
    Given('the blank deck "Graphs" is in this browser', () => deckInBrowser('blank', 'Graphs'))
    And('I open the deck', async () => {
      web = await mountWebApp({ guest })
      await openDeck()
    })
    When('I switch to the Markdown view', () => web.click('[data-testid="view-markdown"]'))
    Then('the editor holds the deck\'s Markdown', async () => {
      await vi.waitFor(() => expect(editor()).not.toBeNull())
      expect(editor()!.value).toBe(toMarkdown(await guest.readDeck(deckId), { ids: false }))
      expect(editor()!.value).toContain('# Graphs')
      expect(find('[data-testid="view-markdown"]')!.getAttribute('aria-pressed')).toBe('true')
    })
    And('the address says the view is "markdown"', () => {
      expect(web.router.currentRoute.value.query.view).toBe('markdown')
      expect(localStorage.getItem(VIEW_STORAGE_KEY)).toBe('markdown')
    })
    When('I go to the project and open the deck again, without a view in the address', async () => {
      await web.router.push({ name: 'project', params: { projectId } })
      await web.settle()
      await openDeck()
      expect(web.router.currentRoute.value.query.view).toBeUndefined()
    })
    Then('the page shows the Markdown view', async () => {
      await vi.waitFor(() => expect(editor()).not.toBeNull())
      expect(find('[data-testid="markdown-view"]')).not.toBeNull()
    })
  })

  Scenario('The address chooses the view', ({ Given, When, Then }) => {
    Given('the blank deck "Graphs" is in this browser, and the Markdown view was chosen last time', async () => {
      await deckInBrowser('blank', 'Graphs')
      web = await mountWebApp({ guest, view: 'markdown' })
    })
    When('I open the deck with the view "design" in the address', () => openDeck({ view: 'design' }))
    designShown(Then)
  })

  Scenario('The slide on show stays the same across views', ({ Given, And, When, Then }) => {
    Given('the demo deck "Sorting" is in this browser', () => deckInBrowser('demo', 'Sorting'))
    And('I open the deck', async () => {
      web = await mountWebApp({ guest })
      await openDeck()
    })
    When('I press the next slide button', () => web.click('[data-testid="next-slide"]'))
    And('I switch to the Markdown view', async () => {
      await web.click('[data-testid="view-markdown"]')
      await vi.waitFor(() => expect(editor()).not.toBeNull())
    })
    Then('the page still shows slide 2 of 5', () => {
      expect(position()).toBe('Slide 2 of 5')
      expect(lastRequest().slide.content).toContain('# Teaching: code that morphs')
    })
    When('I press the next slide button again', () => web.click('[data-testid="next-slide"]'))
    Then('the editor cursor jumps to the first line of slide 3', () => {
      const lines = editor()!.value.split('\n')
      expect(editorJumps.at(-1)).toBe(splitSlides(editor()!.value)[2].start)
      expect(lines.slice(editorJumps.at(-1)!).join('\n')).toMatch(/^---\nlayout: two-cols\n/)
    })
  })

  Scenario('The slide on show stays on its slide when someone adds one above it', ({ Given, When, Then }) => {
    Given('Ana is signed in with the demo deck "Sorting" open on slide 3', async () => {
      await signedInWith('demo', 'Sorting')
      await web.click('[data-testid="next-slide"]')
      await web.click('[data-testid="next-slide"]')
      expect(position()).toBe('Slide 3 of 5')
      expect(lastRequest().slide.content).toContain('# Spatial zoom')
    })
    When('Budi adds a slide after slide 1 in another browser', async () => {
      budi = await openReady(await CloudStore.open(api), projectId, deckId)
      const slides = slidesOf(budi.doc)
      setSlides(budi, [slides[0], '\n# Added by Budi\n', ...slides.slice(1)])
    })
    Then('the page shows slide 4 of 6, still the slide "# Spatial zoom"', async () => {
      await vi.waitFor(() => expect(position()).toBe('Slide 4 of 6'))
      expect(lastRequest().slide.content).toContain('# Spatial zoom')
    })
  })

  Scenario('Download Markdown saves the live deck', ({ Given, And, When, Then }) => {
    let saved: { name: string, text: Promise<string> } | undefined
    Given('the blank deck "Graphs" is in this browser', () => deckInBrowser('blank', 'Graphs'))
    And('I open the deck in the Markdown view', async () => {
      web = await mountWebApp({ guest, view: 'markdown' })
      await openDeck()
      await vi.waitFor(() => expect(editor()).not.toBeNull())
    })
    And('I change the title to "Changed" in the editor', async () => {
      editor()!.value = editor()!.value.replace('# Graphs', '# Changed')
      editor()!.dispatchEvent(new Event('input'))
      await web.settle()
    })
    When('I download the deck as Markdown', async () => {
      let blob: Blob | undefined
      vi.spyOn(URL, 'createObjectURL').mockImplementation((object) => {
        blob = object as Blob
        return 'blob:deck'
      })
      vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
      vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
        saved = { name: this.download, text: blob!.text() }
      })
      await web.click('[data-testid="download-markdown"]')
    })
    Then('the file "Graphs.md" holds the deck with the title "Changed"', async () => {
      expect(saved?.name).toBe('Graphs.md')
      // Typing still waiting to merge goes with the download.
      expect(await saved!.text).toContain('# Changed')
      expect(await saved!.text).toMatch(/^---\ntheme: default\n/)
    })
  })

  Scenario('People who have the deck open show in the header', ({ Given, When, Then }) => {
    Given('Ana is signed in with the blank deck "Graphs" open', () => signedInWith('blank', 'Graphs'))
    When('Budi opens the same deck in another browser', async () => {
      budi = await openReady(await CloudStore.open(api), projectId, deckId)
      introduce(budi, 'user-budi', 'Budi Santoso')
    })
    Then('the header shows Budi as "B" in Budi\'s color, with the full name on hover', async () => {
      await vi.waitFor(() => expect(findAll('[data-testid="peers"] li').map(item => item.getAttribute('data-peer'))).toEqual(['Budi Santoso']))
      const avatar = find('[data-testid="peers"] li')!
      expect(avatar.textContent!.trim()).toBe('B')
      expect(avatar.title).toBe('Budi Santoso')
      expect(avatar.getAttribute('style')).toMatch(/background-color: (#46a758|rgb\(70, 167, 88\))/)
    })
    When('Budi closes the deck', async () => {
      budi!.close()
      budi = undefined
      await web.settle()
    })
    Then('the header shows nobody else', async () => {
      await vi.waitFor(() => expect(find('[data-testid="peers"]')).toBeNull())
    })
  })

  Scenario('Others see which view and slide the page shows', ({ Given, And, Then, When }) => {
    /** Ana's page, as Budi's session sees it. */
    const ana = () => budi!.peers.value.find(peer => peer.user.id === web.account.account.value?.id)
    const slideIds = () => readDeckDoc(budi!.doc).slides.map(slide => slide.id)
    Given('Ana is signed in with the demo deck "Sorting" open', () => signedInWith('demo', 'Sorting'))
    And('Budi has the same deck open in another browser', async () => {
      budi = await openReady(await CloudStore.open(api), projectId, deckId)
    })
    Then('Budi sees Ana in the Design view on slide 1, with nothing selected', async () => {
      await vi.waitFor(() => expect(ana()).toBeDefined())
      expect(ana()!.user.name).toBe('Ana')
      expect(ana()).toMatchObject({ view: 'design', slideId: slideIds()[0], selection: [] })
    })
    When('Ana goes to the next slide and switches to the Markdown view', async () => {
      await web.click('[data-testid="next-slide"]')
      await web.click('[data-testid="view-markdown"]')
    })
    Then('Budi sees Ana in the Markdown view on slide 2', async () => {
      await vi.waitFor(() => expect(ana()).toMatchObject({ view: 'markdown', slideId: slideIds()[1], selection: [] }))
    })
    When('Ana leaves the deck', async () => {
      await web.router.push({ name: 'project', params: { projectId } })
      await web.settle()
    })
    Then('Budi sees nobody else', async () => {
      await vi.waitFor(() => expect(budi!.peers.value).toEqual([]))
    })
  })
})
