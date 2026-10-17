import type { WebApp } from './support/web'
import { describeFeature, loadFeature } from '@amiceli/vitest-cucumber'
import { expect, vi } from 'vitest'
import * as Y from 'yjs'
import { MERGE_DELAY_MS } from '../apps/web/src/editor/markdown-sync'
import { MemoryGuestStorage } from '../apps/web/src/guest/memory-storage'
import { GuestStore } from '../apps/web/src/guest/store'
import { deckMarkdown } from '../packages/deck-model/src'
import { FakeAccountService } from './support/account'
import { editorJumps, previewRequests, resetEditorDoubles } from './support/editor-doubles'
import { FakeProjectApi } from './support/project-api'
import { find, findAll, mountWebApp, text } from './support/web'

const feature = await loadFeature('./markdown-editor.feature')

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

describeFeature(feature, ({ Scenario, AfterEachScenario }) => {
  let web: WebApp
  let storage: MemoryGuestStorage
  let guest: GuestStore
  let api: FakeProjectApi
  let service: FakeAccountService
  let projectId: string
  let deckId: string

  AfterEachScenario(() => {
    web?.unmount()
    resetEditorDoubles()
  })

  const editor = () => find('[data-testid="markdown-editor"]') as HTMLTextAreaElement
  const lastRequest = () => previewRequests.at(-1)!
  const preview = () => web.wrapper.findComponent({ name: 'SlidePreviewFrame' })
  const editorComponent = () => web.wrapper.findComponent({ name: 'MarkdownEditor' })

  async function openDeck(name: string, template: 'blank' | 'demo', signedIn = false) {
    storage = new MemoryGuestStorage()
    guest = await GuestStore.open(storage)
    api = new FakeProjectApi()
    service = new FakeAccountService()
    if (signedIn) {
      service.addAccount('ana@example.com', 'correct horse')
      await service.signIn({ email: 'ana@example.com', password: 'correct horse' })
      const project = await api.createProject('Talks')
      web = await mountWebApp({ service, api, guest, view: 'markdown' })
      const deck = await web.workspace.store.value.createDeck(project.id, name, template)
      projectId = project.id
      deckId = deck.id
    }
    else {
      const project = await guest.createProject('Talks')
      const deck = await guest.createDeck(project.id, name, template)
      web = await mountWebApp({ service, api, guest, view: 'markdown' })
      projectId = project.id
      deckId = deck.id
    }
    await web.router.push({ name: 'deck', params: { projectId, deckId } })
    await vi.waitFor(() => expect(editor()).not.toBeNull())
    await vi.waitFor(() => expect(previewRequests.length).toBeGreaterThan(0))
  }

  async function type(markdown: string) {
    editor().value = markdown
    editor().dispatchEvent(new Event('input'))
    await web.settle()
  }

  const typeFirstSlide = (heading: string) => type(editor().value.replace(/^# .*$/m, `# ${heading}`))
  const status = () => text('[data-testid="save-status"]')
  const problem = () => find('[data-testid="markdown-problem"]')

  /** The deck as the browser's storage holds it, not the copy the page has open. */
  async function storedMarkdown() {
    const copy = await storage.openDeck(deckId)
    try {
      return deckMarkdown(copy.doc)
    }
    finally {
      copy.doc.destroy()
    }
  }

  /** Leaves the deck for its project page. The page may ask first, so this does not wait for the answer. */
  function goToProject() {
    const going = web.router.push({ name: 'project', params: { projectId } })
    return going
  }

  const onProjectPage = () => web.router.currentRoute.value.name === 'project'
  const dialog = () => find('[data-testid="confirm-dialog"]')

  /** The first heading of the deck as the account holds it. */
  async function accountHeading() {
    const doc = new Y.Doc()
    Y.applyUpdate(doc, await api.deckState(deckId))
    return deckMarkdown(doc).match(/^# (.*)$/m)?.[1]
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
      preview().vm.$emit('rendered', { clicks: 3 })
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

  Scenario('A slide typed in the editor shows in the preview once it is in the deck', ({ Given, When, Then }) => {
    Given('the demo deck "Sorting" is open in the editor', () => openDeck('Sorting', 'demo'))
    When('I type a new slide "# Brand new" after the first slide, with the cursor in it', async () => {
      const value = editor().value
      const at = value.indexOf('\n---\nlayout: default')
      expect(at).toBeGreaterThan(0)
      await type(`${value.slice(0, at)}\n---\n\n# Brand new\n${value.slice(at)}`)
      editorComponent().vm.$emit('cursor', editor().value.split('\n').indexOf('# Brand new'))
      await web.settle()
    })
    Then('a moment later the preview shows slide 2 of 6, the slide "# Brand new"', async () => {
      await vi.waitFor(() => expect(text('[data-testid="slide-position"]')).toBe('Slide 2 of 6'))
      await vi.waitFor(() => expect(lastRequest().slide.content).toContain('# Brand new'))
    })
  })

  Scenario('Changes are saved', ({ Given, And, When, Then }) => {
    Given('Ana is signed in with the blank deck "Graphs" open in the editor', () => openDeck('Graphs', 'blank', true))
    And('the server is slow to confirm changes', () => {
      api.slowToConfirm = true
    })
    When('I change the Markdown so the first slide reads "Changed"', () => typeFirstSlide('Changed'))
    Then('the editor says "Saving..." at once, and still once the change reached the server', async () => {
      // Typing waits a moment before it goes into the deck, and that is not saved yet either.
      expect(status()).toBe('Saving...')
      await sleep(MERGE_DELAY_MS + 50)
      await web.settle()
      expect(status()).toBe('Saving...')
      expect(api.rooms.get(deckId) && deckMarkdown(api.rooms.get(deckId)!)).toContain('# Graphs')
    })
    When('the server confirms the changes', async () => {
      api.confirmChanges()
      await web.settle()
    })
    Then('the editor says "Saved"', async () => {
      await vi.waitFor(() => expect(status()).toBe('Saved'))
    })
    And('the account\'s deck has the first slide "Changed"', async () => {
      expect(await accountHeading()).toBe('Changed')
    })
  })

  Scenario('Changes in the browser are saved', ({ Given, When, Then, And }) => {
    Given('the blank deck "Graphs" is open in the editor', () => openDeck('Graphs', 'blank'))
    When('I change the Markdown so the first slide reads "Changed"', () => typeFirstSlide('Changed'))
    Then('the editor says "Saving..." until the change is in the deck', () => {
      expect(status()).toBe('Saving...')
    })
    And('the browser\'s storage has the first slide "Changed" after a moment', async () => {
      await vi.waitFor(async () => expect(await storedMarkdown()).toContain('# Changed'))
    })
    And('the editor says "Saved"', async () => {
      await vi.waitFor(() => expect(status()).toBe('Saved'))
    })
  })

  Scenario('A failed save says so', ({ Given, When, Then, And }) => {
    Given('Ana is signed in with the blank deck "Graphs" open in the editor', () => openDeck('Graphs', 'blank', true))
    When('the server stops letting Ana into the deck', async () => {
      api.failAuth()
      await web.settle()
    })
    Then('the editor says "Not saved: You no longer have access to this deck."', async () => {
      await vi.waitFor(() => expect(status()).toBe('Not saved: You no longer have access to this deck.'))
    })
    And('the editor is read only', () => {
      expect(editor().readOnly).toBe(true)
    })
  })

  Scenario('Working offline says so, and the changes go out once back online', ({ Given, When, Then, And }) => {
    Given('Ana is signed in with the blank deck "Graphs" open in the editor', () => openDeck('Graphs', 'blank', true))
    When('the connection drops', async () => {
      api.goOffline()
      await web.settle()
    })
    Then('the editor says "Offline. Changes sync when you are back online."', () => {
      expect(status()).toBe('Offline. Changes sync when you are back online.')
      expect(editor().readOnly).toBe(false)
    })
    When('I change the Markdown so the first slide reads "On the train"', async () => {
      await typeFirstSlide('On the train')
      // The change is in the page; the account gets it once the connection is back.
      await new Promise(resolve => setTimeout(resolve, MERGE_DELAY_MS + 50))
      expect(await accountHeading()).toBe('Graphs')
    })
    And('the connection comes back', async () => {
      api.goOnline()
      await web.settle()
    })
    Then('the editor says "Saved"', async () => {
      await vi.waitFor(() => expect(status()).toBe('Saved'))
    })
    And('the account\'s deck has the first slide "On the train"', async () => {
      expect(await accountHeading()).toBe('On the train')
    })
  })

  Scenario('Leaving the deck while offline keeps the changes for later', ({ Given, When, And, Then }) => {
    Given('Ana is signed in with the blank deck "Graphs" open in the editor', () => openDeck('Graphs', 'blank', true))
    When('the connection drops', async () => {
      api.goOffline()
      await web.settle()
    })
    And('I change the Markdown so the first slide reads "Written offline"', async () => {
      await typeFirstSlide('Written offline')
    })
    And('I go to the project page', async () => {
      await goToProject()
      await web.settle()
    })
    Then('the project page shows, without a question', () => {
      expect(onProjectPage()).toBe(true)
      expect(dialog()).toBeNull()
    })
    When('the connection comes back', async () => {
      expect(await accountHeading()).toBe('Graphs')
      api.goOnline()
      await web.settle()
    })
    Then('the account\'s deck has the first slide "Written offline"', async () => {
      await vi.waitFor(async () => expect(await accountHeading()).toBe('Written offline'))
    })
  })

  const breakYaml = () => type(editor().value.replace('title: Graphs', 'title: [Graphs'))
  const yamlError = async () => {
    await vi.waitFor(() => expect(problem()?.textContent?.trim()).toMatch(/^The frontmatter is not valid YAML\./))
  }

  Scenario('Markdown that cannot be read shows the error under the editor', ({ Given, When, Then, And }) => {
    Given('the blank deck "Graphs" is open in the editor', () => openDeck('Graphs', 'blank'))
    When('I break the YAML of the deck\'s frontmatter', breakYaml)
    Then('the error under the editor starts with "The frontmatter is not valid YAML."', async () => {
      await yamlError()
      expect(problem()!.getAttribute('role')).toBe('alert')
    })
    And('the editor says "Not saved: fix the Markdown error."', () => {
      expect(status()).toBe('Not saved: fix the Markdown error.')
    })
    And('the stored deck still has the title "Graphs"', async () => {
      const stored = await guest.deckMarkdown(deckId)
      expect(stored).toContain('title: Graphs\n')
      expect(stored).not.toContain('[Graphs')
    })
    And('closing the tab asks first', () => {
      const closing = new Event('beforeunload', { cancelable: true })
      window.dispatchEvent(closing)
      expect(closing.defaultPrevented).toBe(true)
    })
  })

  Scenario('A change held back by an error survives a switch to Design and back', ({ Given, When, And, Then }) => {
    Given('the blank deck "Graphs" is open in the editor', () => openDeck('Graphs', 'blank'))
    When('I add the paragraph "Careful writing." and break the YAML of the deck\'s frontmatter', async () => {
      await type(editor().value.replace('# Graphs', '# Graphs\n\nCareful writing.').replace('title: Graphs', 'title: [Graphs'))
      await yamlError()
    })
    And('I switch to the Design view and back to Markdown', async () => {
      await web.click('[data-testid="view-design"]')
      expect(editor()).toBeNull()
      await web.click('[data-testid="view-markdown"]')
      await vi.waitFor(() => expect(editor()).not.toBeNull())
    })
    Then('the editor still has "Careful writing." and the broken YAML, with the error under it', async () => {
      expect(editor().value).toContain('Careful writing.')
      expect(editor().value).toContain('title: [Graphs')
      await yamlError()
      expect(await storedMarkdown()).not.toContain('Careful writing.')
    })
    When('I fix the YAML', () => type(editor().value.replace('title: [Graphs', 'title: Graphs')))
    Then('the browser\'s storage has "Careful writing." after a moment', async () => {
      await vi.waitFor(async () => expect(await storedMarkdown()).toContain('Careful writing.'))
      expect(problem()).toBeNull()
    })
  })

  Scenario('Leaving with a change held back by an error asks first', ({ Given, When, And, Then }) => {
    let going: Promise<unknown>
    Given('the blank deck "Graphs" is open in the editor', () => openDeck('Graphs', 'blank'))
    When('I break the YAML of the deck\'s frontmatter', async () => {
      await breakYaml()
      await yamlError()
    })
    And('I go to the project page', async () => {
      going = goToProject()
      await web.settle()
    })
    Then('the page asks "Leave without your last change?" and the deck stays open', async () => {
      await vi.waitFor(() => expect(dialog()?.textContent).toContain('Leave without your last change?'))
      expect(onProjectPage()).toBe(false)
    })
    When('I choose to stay', async () => {
      findAll('[data-testid="confirm-dialog"] button').find(button => button.textContent?.trim() === 'Cancel')!.click()
      await going
      await web.settle()
    })
    Then('the editor still has the broken YAML', async () => {
      expect(onProjectPage()).toBe(false)
      expect(editor().value).toContain('title: [Graphs')
      await yamlError()
    })
    When('I go to the project page and choose to leave without it', async () => {
      going = goToProject()
      await vi.waitFor(() => expect(find('[data-testid="confirm-action"]')).not.toBeNull())
      find('[data-testid="confirm-action"]')!.click()
      await going
      await web.settle()
    })
    Then('the project page shows, and the stored deck still has the title "Graphs"', async () => {
      expect(onProjectPage()).toBe(true)
      expect(await storedMarkdown()).toContain('title: Graphs\n')
    })
  })

  Scenario('Half typed Markdown is shown softly and waits', ({ Given, When, Then, And }) => {
    Given('the blank deck "Graphs" is open in the editor', () => openDeck('Graphs', 'blank'))
    When('I start an HTML comment on the first slide', () => type(editor().value.replace('# Graphs', '# Graphs <!--')))
    Then('a note under the editor says "Slide 1 has an HTML comment that is not closed. Close it with -->."', async () => {
      await vi.waitFor(() => expect(problem()?.textContent?.trim()).toBe('Slide 1 has an HTML comment that is not closed. Close it with -->.'))
    })
    And('the note is not an alert', () => {
      expect(problem()!.getAttribute('role')).toBe('status')
    })
    And('the editor says "Not saved yet: finish the Markdown change."', () => {
      expect(status()).toBe('Not saved yet: finish the Markdown change.')
    })
    And('the stored deck\'s first slide still reads "Graphs"', async () => {
      const stored = await guest.deckMarkdown(deckId)
      expect(stored).toContain('# Graphs')
      expect(stored).not.toContain('<!--')
    })
  })

  Scenario('Text typed after the --- on line 1 is not saved, and the editor says why', ({ Given, When, Then, And }) => {
    Given('the blank deck "Graphs" is open in the editor', () => openDeck('Graphs', 'blank'))
    When('I type "x" right after the "---" on line 1', async () => {
      expect(editor().value.startsWith('---\n')).toBe(true)
      await type(`---x${editor().value.slice(3)}`)
    })
    Then('the error under the editor says "Line 1 is a slide break, and Slidev ignores anything after its ---. Keep --- alone on that line."', async () => {
      await vi.waitFor(() => expect(problem()?.textContent?.trim()).toBe('Line 1 is a slide break, and Slidev ignores anything after its ---. Keep --- alone on that line.'))
      expect(problem()!.getAttribute('role')).toBe('alert')
      expect(editor().value.split('\n')[0]).toBe('---x')
    })
    And('the editor says "Not saved: fix the Markdown error."', () => {
      expect(status()).toBe('Not saved: fix the Markdown error.')
    })
    And('the stored deck still has "---" alone on line 1', async () => {
      expect((await guest.deckMarkdown(deckId)).split('\n')[0]).toBe('---')
    })
  })

  Scenario('Phones switch between writing and the preview', ({ Given, When, Then }) => {
    Given('the blank deck "Graphs" is open in the editor', () => openDeck('Graphs', 'blank'))
    When('I choose the "Preview" tab', () => web.click('[data-testid="tab-preview"]'))
    Then('the preview is shown and the editor is hidden on small screens', () => {
      expect(editor().parentElement!.className).toContain('hidden md:flex')
      expect(find('[data-testid="preview-frame"]')!.parentElement!.className).toContain('flex')
      expect(find('[data-testid="tab-preview"]')!.getAttribute('aria-selected')).toBe('true')
    })
  })
})
