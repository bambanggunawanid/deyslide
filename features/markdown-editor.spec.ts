import type { WebApp } from './support/web'
import { describeFeature, loadFeature } from '@amiceli/vitest-cucumber'
import { expect, vi } from 'vitest'
import { MemoryGuestStorage } from '../apps/web/src/guest/memory-storage'
import { GuestStore } from '../apps/web/src/guest/store'
import { FakeAccountService } from './support/account'
import { editorJumps, previewRequests, resetEditorDoubles } from './support/editor-doubles'
import { FakeProjectApi } from './support/project-api'
import { find, mountWebApp, text } from './support/web'

const feature = await loadFeature('./markdown-editor.feature')

describeFeature(feature, ({ Scenario, AfterEachScenario }) => {
  let web: WebApp
  let guest: GuestStore
  let api: FakeProjectApi
  let service: FakeAccountService

  AfterEachScenario(() => {
    web?.unmount()
    resetEditorDoubles()
  })

  const editor = () => find('[data-testid="markdown-editor"]') as HTMLTextAreaElement
  const lastRequest = () => previewRequests.at(-1)!
  const preview = () => web.wrapper.findComponent({ name: 'SlidePreviewFrame' })
  const editorComponent = () => web.wrapper.findComponent({ name: 'MarkdownEditor' })

  async function openDeck(name: string, template: 'blank' | 'demo', signedIn = false) {
    guest = await GuestStore.open(new MemoryGuestStorage())
    api = new FakeProjectApi()
    service = new FakeAccountService()
    let projectId: string
    let deckId: string
    if (signedIn) {
      service.addAccount('ana@example.com', 'correct horse')
      await service.signIn({ email: 'ana@example.com', password: 'correct horse' })
      const project = await api.createProject('Talks')
      web = await mountWebApp({ service, api, guest })
      const deck = await web.workspace.store.value.createDeck(project.id, name, template)
      projectId = project.id
      deckId = deck.id
    }
    else {
      const project = await guest.createProject('Talks')
      const deck = await guest.createDeck(project.id, name, template)
      web = await mountWebApp({ service, api, guest })
      projectId = project.id
      deckId = deck.id
    }
    await web.router.push({ name: 'deck', params: { projectId, deckId } })
    await vi.waitFor(() => expect(editor()).not.toBeNull())
    await vi.waitFor(() => expect(previewRequests.length).toBeGreaterThan(0))
  }

  async function typeFirstSlide(heading: string) {
    const markdown = editor().value.replace(/^# .*$/m, `# ${heading}`)
    editor().value = markdown
    editor().dispatchEvent(new Event('input'))
    await web.settle()
  }

  async function moveCursorToSlide(number: number) {
    const lines = editor().value.split('\n')
    // The line after the separator that opens slide `number`.
    let seen = 0
    let line = 0
    for (const [index, content] of lines.entries()) {
      if (index > 0 && content === '---' && lines[index - 1] === '') {
        seen++
        if (seen === number - 1) {
          line = index + 1
          break
        }
      }
    }
    editorComponent().vm.$emit('cursor', line + 2)
    await web.settle()
  }

  Scenario('Opening a deck shows its Markdown and its first slide', ({ Given, Then, And }) => {
    Given('the demo deck "Sorting" is open in the editor', () => openDeck('Sorting', 'demo'))
    Then('the editor holds the deck\'s Markdown, starting with its frontmatter', () => {
      expect(editor().value.startsWith('---\n')).toBe(true)
      expect(editor().value).toContain('title: Deyslide')
    })
    And('the preview shows slide 1 of 5, the cover titled "Deyslide"', () => {
      expect(text('[data-testid="slide-position"]')).toBe('Slide 1 of 5')
      expect(lastRequest().slide.first).toBe(true)
      expect(lastRequest().slide.content).toContain('Deyslide')
      expect(lastRequest().headmatter.title).toBe('Deyslide')
    })
  })

  Scenario('Typing updates the preview', ({ Given, When, Then }) => {
    Given('the blank deck "Graphs" is open in the editor', () => openDeck('Graphs', 'blank'))
    When('I change the Markdown so the first slide reads "Hello"', () => typeFirstSlide('Hello'))
    Then('the preview is asked to render the heading "Hello"', async () => {
      await vi.waitFor(() => expect(lastRequest().slide.content).toContain('# Hello'))
    })
  })

  Scenario('The preview follows the cursor', ({ Given, When, Then }) => {
    Given('the demo deck "Sorting" is open in the editor', () => openDeck('Sorting', 'demo'))
    When('the cursor moves into the third slide', () => moveCursorToSlide(3))
    Then('the preview shows slide 3 of 5 with the layout "two-cols"', () => {
      expect(text('[data-testid="slide-position"]')).toBe('Slide 3 of 5')
      expect(lastRequest().slide.frontmatter.layout).toBe('two-cols')
      expect(lastRequest().slide.content).toContain('# Spatial zoom')
    })
  })

  Scenario('Step through clicks', ({ Given, And, When, Then }) => {
    Given('the demo deck "Sorting" is open in the editor', () => openDeck('Sorting', 'demo'))
    And('the cursor is in the third slide, which the preview says has 3 clicks', async () => {
      await moveCursorToSlide(3)
      preview().vm.$emit('rendered', 3)
      await web.settle()
    })
    When('I press the next click button twice', async () => {
      await web.click('[data-testid="next-click"]')
      await web.click('[data-testid="next-click"]')
    })
    Then('the preview is asked to show click 2, and the counter reads "Click 2 of 3"', () => {
      expect(lastRequest().clicks).toBe(2)
      expect(text('[data-testid="click-position"]')).toBe('Click 2 of 3')
    })
  })

  Scenario('The slide buttons move the cursor too', ({ Given, When, Then, And }) => {
    Given('the demo deck "Sorting" is open in the editor', () => openDeck('Sorting', 'demo'))
    When('I press the next slide button', () => web.click('[data-testid="next-slide"]'))
    Then('the preview shows slide 2 of 5', () => {
      expect(text('[data-testid="slide-position"]')).toBe('Slide 2 of 5')
      expect(lastRequest().slide.content).toContain('# Teaching: code that morphs')
    })
    And('the editor cursor jumps to the first line of slide 2', () => {
      const lines = editor().value.split('\n')
      expect(lines.slice(editorJumps.at(-1)!).join('\n')).toMatch(/^---\nlayout: default\n---/)
    })
  })

  Scenario('Changes are saved', ({ Given, When, Then, And }) => {
    Given('the blank deck "Graphs" is open in the editor', () => openDeck('Graphs', 'blank'))
    When('I change the Markdown so the first slide reads "Changed"', () => typeFirstSlide('Changed'))
    Then('the editor says "Saved" after a moment', async () => {
      expect(text('[data-testid="save-status"]')).toBe('Unsaved changes')
      await vi.waitFor(() => expect(text('[data-testid="save-status"]')).toBe('Saved'), { timeout: 3000 })
    })
    And('the stored deck\'s first slide reads "Changed"', async () => {
      const deckId = guest.listProjects()[0].decks[0].id
      expect(await guest.deckMarkdown(deckId)).toContain('# Changed')
    })
  })

  Scenario('A failed save says so', ({ Given, And, When, Then }) => {
    Given('Ana is signed in with the blank deck "Graphs" open in the editor', () => openDeck('Graphs', 'blank', true))
    And('the server cannot be reached', () => {
      api.failWith = 'Deyslide is unreachable. Check your connection and try again.'
    })
    When('I change the Markdown so the first slide reads "Offline"', () => typeFirstSlide('Offline'))
    Then('the editor says "Not saved: Deyslide is unreachable. Check your connection and try again."', async () => {
      await vi.waitFor(() => expect(text('[data-testid="save-status"]')).toBe('Not saved: Deyslide is unreachable. Check your connection and try again.'), { timeout: 3000 })
    })
  })

  Scenario('Phones switch between writing and the preview', ({ Given, When, Then }) => {
    Given('the blank deck "Graphs" is open in the editor', () => openDeck('Graphs', 'blank'))
    When('I choose the "Preview" tab', () => web.click('[data-testid="tab-preview"]'))
    Then('the preview is shown and the editor is hidden on small screens', () => {
      expect(editor().parentElement!.className).toContain('hidden md:block')
      expect(find('[data-testid="preview-frame"]')!.parentElement!.className).toContain('flex')
      expect(find('[data-testid="tab-preview"]')!.getAttribute('aria-selected')).toBe('true')
    })
  })
})
