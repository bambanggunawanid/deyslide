import type { DeckSession } from '../apps/web/src/deck/session'
import type { WebApp } from './support/web'
import { describeFeature, loadFeature } from '@amiceli/vitest-cucumber'
import { expect, vi } from 'vitest'
import * as Y from 'yjs'
import { MemoryGuestStorage } from '../apps/web/src/guest/memory-storage'
import { GuestStore } from '../apps/web/src/guest/store'
import { CloudStore } from '../apps/web/src/projects/cloud-store'
import { deckMarkdown, splitSlides } from '../packages/deck-model/src'
import { FakeAccountService } from './support/account'
import { FakeAssistantApi } from './support/assistant-api'
import { previewRequests, resetEditorDoubles } from './support/editor-doubles'
import { changeSlide, openReady, slidesOf } from './support/live-decks'
import { FakeProjectApi } from './support/project-api'
import { find, findAll, mountWebApp, text } from './support/web'

/** The time Yjs groups changes into one undo step by default. */
const CAPTURE_TIMEOUT_MS = 500

const feature = await loadFeature('./web-assistant.feature')

describeFeature(feature, ({ Scenario, AfterEachScenario }) => {
  let web: WebApp
  let api: FakeProjectApi
  let assistant: FakeAssistantApi
  let projectId: string
  let deckId: string
  let original: string
  let otherDeckId: string
  let budi: DeckSession | undefined

  AfterEachScenario(() => {
    budi?.close()
    budi = undefined
    web?.unmount()
    resetEditorDoubles()
  })

  const editor = () => find('[data-testid="markdown-editor"]') as HTMLTextAreaElement
  const input = () => find('[data-testid="assistant-input"]') as HTMLTextAreaElement
  const editorComponent = () => web.wrapper.findComponent({ name: 'MarkdownEditor' })

  async function openDeck({ signedIn = true, on = true, usedPercent = 0, otherDeck = '' } = {}) {
    const guest = await GuestStore.open(new MemoryGuestStorage())
    const service = new FakeAccountService()
    api = new FakeProjectApi()
    assistant = new FakeAssistantApi({ on })
    assistant.usedPercent = usedPercent
    if (signedIn) {
      service.addAccount('ana@example.com', 'correct horse')
      await service.signIn({ email: 'ana@example.com', password: 'correct horse' })
      projectId = (await api.createProject('Talks')).id
      web = await mountWebApp({ service, api, guest, assistant, view: 'markdown' })
      deckId = (await web.workspace.store.value.createDeck(projectId, 'Graphs', 'blank')).id
      if (otherDeck)
        otherDeckId = (await web.workspace.store.value.createDeck(projectId, otherDeck, 'blank')).id
    }
    else {
      projectId = (await guest.createProject('Talks')).id
      deckId = (await guest.createDeck(projectId, 'Graphs', 'blank')).id
      web = await mountWebApp({ service, api, guest, assistant, view: 'markdown' })
    }
    await web.router.push({ name: 'deck', params: { projectId, deckId } })
    await vi.waitFor(() => expect(editor()).not.toBeNull())
    await web.settle()
    original = editor().value
  }

  async function ask(message: string) {
    await web.fill('[data-testid="assistant-input"]', message)
    await web.click('[data-testid="assistant-send"]')
  }

  /** Asks, then waits until Claude finished. */
  async function askAndWait(message: string) {
    await ask(message)
    await vi.waitFor(() => expect(text('[data-testid="assistant-send"]')).toBe('Send'), { timeout: 3000 })
    await web.settle()
  }

  const slideCount = () => splitSlides(editor().value).length
  /** The content of each slide in the editor after the first. */
  const laterSlides = () => splitSlides(editor().value).slice(1).map(slide => slide.content)

  function slidesIn(state: Uint8Array) {
    const doc = new Y.Doc()
    Y.applyUpdate(doc, state)
    return (doc.getMap('deck').get('slides') as Y.Array<unknown>).length
  }

  /** The deck's Markdown as the server holds it. */
  async function savedMarkdown() {
    const doc = new Y.Doc()
    Y.applyUpdate(doc, await api.deckState(deckId))
    return deckMarkdown(doc)
  }

  const undoShown = () => find('[data-testid="assistant-undo"]') !== null

  Scenario('Ask for a new slide', ({ Given, When, Then, And }) => {
    Given('Ana is signed in with the blank deck "Graphs" open and the assistant on', () => openDeck())
    When('Ana asks the assistant "Add a slide about recursion"', () => ask('Add a slide about recursion'))
    Then('the editor holds a second slide "# Recursion"', () => {
      expect(slideCount()).toBe(2)
      expect(splitSlides(editor().value)[1].content).toBe('# Recursion')
    })
    And('the preview shows slide 2 of 2', async () => {
      await vi.waitFor(() => expect(text('[data-testid="slide-position"]')).toBe('Slide 2 of 2'))
      await vi.waitFor(() => expect(previewRequests.at(-1)!.slide.content).toBe('# Recursion'))
    })
    And('the chat shows the reply "Added a slide about recursion." with the change "Added slide 2"', () => {
      const reply = findAll('[data-testid="assistant-assistant"]').at(-1)!
      expect(reply.textContent).toContain('Added a slide about recursion.')
      expect(reply.querySelector('[data-testid="assistant-changes"]')!.textContent!.trim()).toBe('Added slide 2')
    })
    And('the deck is saved with 2 slides', async () => {
      await vi.waitFor(async () => expect(slidesIn(await api.deckState(deckId))).toBe(2), { timeout: 3000 })
    })
  })

  Scenario('Undo a reply', ({ Given, And, When, Then }) => {
    Given('Ana is signed in with the blank deck "Graphs" open and the assistant on', () => openDeck())
    And('Ana asked the assistant "Add a slide about recursion"', () => ask('Add a slide about recursion'))
    When('Ana presses "Undo"', () => web.click('[data-testid="assistant-undo"]'))
    Then('the editor holds only the first slide again', async () => {
      // Changes that do not come from typing reach the editor a moment later.
      await vi.waitFor(() => expect(editor().value).toBe(original))
      expect(find('[data-testid="assistant-undo"]')).toBeNull()
    })
    And('the preview shows slide 1 of 1', async () => {
      await vi.waitFor(() => expect(text('[data-testid="slide-position"]')).toBe('Slide 1 of 1'))
    })
  })

  Scenario('The editor waits while Claude works', ({ Given, And, When, Then }) => {
    let finish: () => void
    Given('Ana is signed in with the blank deck "Graphs" open and the assistant on', () => openDeck())
    And('Claude is slow to finish', () => {
      assistant.hold = new Promise((resolve) => {
        finish = resolve
      })
    })
    When('Ana asks the assistant "Add a slide about recursion"', () => ask('Add a slide about recursion'))
    Then('the editor is read only and the send button says "Working..."', () => {
      expect(editor().readOnly).toBe(true)
      expect(text('[data-testid="assistant-send"]')).toBe('Working...')
      expect(slideCount()).toBe(2)
    })
    When('Claude finishes', async () => {
      finish()
      await web.settle()
    })
    Then('the editor can be typed in again', () => {
      expect(editor().readOnly).toBe(false)
      expect(text('[data-testid="assistant-send"]')).toBe('Send')
    })
  })

  Scenario('The chat so far goes with each message', ({ Given, And, When, Then }) => {
    Given('Ana is signed in with the blank deck "Graphs" open and the assistant on', () => openDeck())
    And('Ana asked the assistant "Add a slide about recursion"', () => ask('Add a slide about recursion'))
    When('Ana asks the assistant "Make it shorter"', () => ask('Make it shorter'))
    Then('the assistant received the chat so far and the deck with 2 slides', () => {
      const { request } = assistant.requests.at(-1)!
      expect(request.message).toBe('Make it shorter')
      expect(request.history).toEqual([
        { role: 'user', text: 'Add a slide about recursion' },
        { role: 'assistant', text: 'Added a slide about recursion.\n\nChanges made: Added slide 2.' },
      ])
      expect(splitSlides(request.markdown)).toHaveLength(2)
      expect(assistant.requests.every(item => item.deckId === deckId)).toBe(true)
    })
  })

  Scenario('The allowance is shown', ({ Given, Then }) => {
    Given('Ana is signed in with the blank deck "Graphs" open and the assistant on, with 40 percent of the allowance used', () => openDeck({ usedPercent: 40 }))
    Then('the assistant says "40% of this month\'s allowance used"', () => {
      expect(text('[data-testid="assistant-allowance"]')).toBe('40% of this month\'s allowance used')
    })
  })

  Scenario('A refused request keeps the message', ({ Given, And, When, Then }) => {
    Given('Ana is signed in with the blank deck "Graphs" open and the assistant on', () => openDeck())
    And('the allowance has run out', () => {
      assistant.failWith = 'You have used this month\'s assistant allowance. It starts again on October 1.'
    })
    When('Ana asks the assistant "Add a slide about recursion"', () => ask('Add a slide about recursion'))
    Then('the assistant shows "You have used this month\'s assistant allowance. It starts again on October 1."', () => {
      expect(text('[data-testid="assistant-error"]')).toBe('You have used this month\'s assistant allowance. It starts again on October 1.')
      expect(findAll('[data-testid="assistant-user"]')).toHaveLength(0)
    })
    And('Ana\'s message is back in the input', () => {
      expect(input().value).toBe('Add a slide about recursion')
      expect(editor().value).toBe(original)
    })
  })

  Scenario('Guests are asked to sign in', ({ Given, Then }) => {
    Given('a guest has the blank deck "Graphs" open and the assistant on', () => openDeck({ signedIn: false }))
    Then('the assistant asks them to sign in', () => {
      expect(text('[data-testid="assistant-sign-in"]').replace(/\s+/g, ' ')).toContain('Sign in to use the assistant.')
      expect(input()).toBeNull()
    })
  })

  Scenario('No assistant when the server has it off', ({ Given, Then }) => {
    Given('Ana is signed in with the blank deck "Graphs" open and the assistant off', () => openDeck({ on: false }))
    Then('there is no assistant on the page', () => {
      expect(find('[data-testid="assistant"]')).toBeNull()
    })
  })

  Scenario('A collaborator\'s edit made during a reply survives', ({ Given, And, When, Then }) => {
    let changeNow: () => void
    Given('Ana is signed in with the blank deck "Graphs" open and the assistant on', () => openDeck())
    And('Budi has the same deck open in another browser', async () => {
      budi = await openReady(await CloudStore.open(api), projectId, deckId)
    })
    And('Claude takes a while before changing the deck', () => {
      assistant.holdChanges = new Promise((resolve) => {
        changeNow = resolve
      })
    })
    When('Ana asks the assistant "Add a slide about recursion"', async () => {
      await ask('Add a slide about recursion')
      expect(text('[data-testid="assistant-send"]')).toBe('Working...')
      expect(assistant.requests.at(-1)!.request.markdown).toBe(original)
    })
    And('Budi changes the title to "# Graphs, from Budi" while Claude works', async () => {
      changeSlide(budi!, 1, markdown => markdown.replace('# Graphs', '# Graphs, from Budi'))
      await vi.waitFor(() => expect(editor().value).toContain('# Graphs, from Budi'))
    })
    And('Claude changes the deck', async () => {
      changeNow()
      await web.settle()
    })
    Then('the editor holds the title "# Graphs, from Budi" and a second slide "# Recursion"', async () => {
      await vi.waitFor(() => expect(slideCount()).toBe(2))
      const [first, second] = splitSlides(editor().value)
      expect(first.content).toContain('# Graphs, from Budi')
      expect(second.content).toBe('# Recursion')
      expect(text('[data-testid="assistant-send"]')).toBe('Send')
    })
    And('Budi\'s copy holds both changes too', async () => {
      await vi.waitFor(() => expect(slidesOf(budi!.doc)).toHaveLength(2))
      const [first, second] = slidesOf(budi!.doc)
      expect(first).toContain('# Graphs, from Budi')
      expect(second).toContain('# Recursion')
    })
    When('Ana presses "Undo"', () => web.click('[data-testid="assistant-undo"]'))
    Then('the editor holds only the first slide, with the title "# Graphs, from Budi"', async () => {
      await vi.waitFor(() => expect(editor().value).toBe(original.replace('# Graphs', '# Graphs, from Budi')))
      expect(undoShown()).toBe(false)
      await vi.waitFor(() => expect(slidesOf(budi!.doc)).toHaveLength(1))
    })
  })

  Scenario('Undo after typing elsewhere takes back only the reply', ({ Given, And, When, Then }) => {
    const typed = () => original.replace('# Graphs', '# Graphs, typed')
    Given('Ana is signed in with the blank deck "Graphs" open and the assistant on', () => openDeck())
    And('Ana asked the assistant "Add a slide about recursion"', async () => {
      await ask('Add a slide about recursion')
      expect(slideCount()).toBe(2)
    })
    And('Ana then changed the title to "# Graphs, typed" in the editor, and it was saved', async () => {
      await web.fill('[data-testid="markdown-editor"]', editor().value.replace('# Graphs', '# Graphs, typed'))
      await vi.waitFor(async () => expect(await savedMarkdown()).toContain('# Graphs, typed'), { timeout: 3000 })
      expect(undoShown()).toBe(true)
    })
    When('Ana presses "Undo"', () => web.click('[data-testid="assistant-undo"]'))
    Then('the editor holds only the first slide, with the title "# Graphs, typed"', async () => {
      await vi.waitFor(() => expect(editor().value).toBe(typed()))
      await vi.waitFor(() => expect(text('[data-testid="slide-position"]')).toBe('Slide 1 of 1'))
    })
    And('the deck is saved with only that slide', async () => {
      await vi.waitFor(async () => expect(await savedMarkdown()).toBe(typed()), { timeout: 3000 })
    })
  })

  Scenario('The preview keeps showing Claude\'s slide until Ana moves the cursor', ({ Given, And, When, Then }) => {
    Given('Ana is signed in with the blank deck "Graphs" open and the assistant on', () => openDeck())
    And('Budi has the same deck open in another browser', async () => {
      budi = await openReady(await CloudStore.open(api), projectId, deckId)
    })
    And('the editor\'s cursor is on the first slide', async () => {
      editorComponent().vm.$emit('cursor', 0)
      await web.settle()
      expect(text('[data-testid="slide-position"]')).toBe('Slide 1 of 1')
    })
    When('Ana asks the assistant "Add a slide about recursion"', () => askAndWait('Add a slide about recursion'))
    Then('the preview shows slide 2 of 2', async () => {
      await vi.waitFor(() => expect(slideCount()).toBe(2))
      await vi.waitFor(() => expect(text('[data-testid="slide-position"]')).toBe('Slide 2 of 2'))
      expect(previewRequests.at(-1)!.slide.content).toBe('# Recursion')
    })
    When('Budi changes the title to "# Graphs, from Budi"', async () => {
      changeSlide(budi!, 1, markdown => markdown.replace('# Graphs', '# Graphs, from Budi'))
      await web.settle()
    })
    Then('the editor shows Budi\'s title, and the preview still shows slide 2 of 2', async () => {
      await vi.waitFor(() => expect(editor().value).toContain('# Graphs, from Budi'))
      await new Promise(resolve => setTimeout(resolve, 300))
      await web.settle()
      expect(text('[data-testid="slide-position"]')).toBe('Slide 2 of 2')
    })
    When('Ana moves the cursor within the first slide', async () => {
      editorComponent().vm.$emit('cursor', 1)
      await web.settle()
    })
    Then('the preview shows slide 1 of 2', () => {
      expect(text('[data-testid="slide-position"]')).toBe('Slide 1 of 2')
      expect(previewRequests.at(-1)!.slide.content).toContain('# Graphs, from Budi')
    })
  })

  Scenario('A reply with several changes adds each slide once, and Undo takes all of it back', ({ Given, And, When, Then }) => {
    Given('Ana is signed in with the blank deck "Graphs" open and the assistant on', () => openDeck())
    And('Claude pauses for longer than half a second between its changes', () => {
      assistant.pauseBetweenChanges = CAPTURE_TIMEOUT_MS + 100
    })
    When('Ana asks the assistant "Add slides about recursion and trees"', () => askAndWait('Add slides about recursion and trees'))
    Then('the editor holds the slides "# Recursion" and "# Trees" after the first, each once', async () => {
      await vi.waitFor(() => expect(laterSlides()).toEqual(['# Recursion', '# Trees']))
      const reply = findAll('[data-testid="assistant-assistant"]').at(-1)!
      expect([...reply.querySelectorAll('[data-testid="assistant-changes"] li')].map(item => item.textContent!.trim())).toEqual(['Added slide 2', 'Added slide 3'])
    })
    And('the preview shows slide 3 of 3', async () => {
      await vi.waitFor(() => expect(text('[data-testid="slide-position"]')).toBe('Slide 3 of 3'))
    })
    When('Ana presses "Undo"', () => web.click('[data-testid="assistant-undo"]'))
    Then('the editor holds only the first slide again', async () => {
      await vi.waitFor(() => expect(editor().value).toBe(original))
      expect(undoShown()).toBe(false)
    })
  })

  Scenario('Undo after two replies takes back only the latest', ({ Given, And, When, Then }) => {
    Given('Ana is signed in with the blank deck "Graphs" open and the assistant on', () => openDeck())
    And('Ana asked the assistant "Add a slide about recursion"', async () => {
      await askAndWait('Add a slide about recursion')
      await vi.waitFor(() => expect(laterSlides()).toEqual(['# Recursion']))
    })
    And('Ana asked the assistant "Add a slide about trees"', async () => {
      await askAndWait('Add a slide about trees')
      await vi.waitFor(() => expect(laterSlides()).toEqual(['# Recursion', '# Trees']))
    })
    When('Ana presses "Undo"', () => web.click('[data-testid="assistant-undo"]'))
    Then('the editor holds the slide "# Recursion" after the first, and no slide "# Trees"', async () => {
      await vi.waitFor(() => expect(laterSlides()).toEqual(['# Recursion']))
      expect(undoShown()).toBe(false)
    })
  })

  Scenario('A question or a refused request keeps the Undo for the last change', ({ Given, And, When, Then }) => {
    Given('Ana is signed in with the blank deck "Graphs" open and the assistant on', () => openDeck())
    And('Ana asked the assistant "Add a slide about recursion"', async () => {
      await askAndWait('Add a slide about recursion')
      await vi.waitFor(() => expect(laterSlides()).toEqual(['# Recursion']))
    })
    When('Ana asks the assistant "Is that slide clear?"', async () => {
      await askAndWait('Is that slide clear?')
      expect(findAll('[data-testid="assistant-assistant"]').at(-1)!.textContent).toContain('I can add a slide about a topic.')
    })
    And('Ana asks the assistant "Add a slide about trees", which is refused', async () => {
      assistant.failWith = 'You have used this month\'s assistant allowance. It starts again on October 1.'
      await askAndWait('Add a slide about trees')
      expect(text('[data-testid="assistant-error"]')).toContain('allowance')
    })
    Then('"Undo" is still there', () => {
      expect(undoShown()).toBe(true)
    })
    When('Ana presses "Undo"', () => web.click('[data-testid="assistant-undo"]'))
    Then('the editor holds only the first slide again', async () => {
      await vi.waitFor(() => expect(editor().value).toBe(original))
    })
  })

  Scenario('Undo goes away once someone edits a slide Claude added', ({ Given, And, When, Then }) => {
    Given('Ana is signed in with the blank deck "Graphs" open and the assistant on', () => openDeck())
    And('Ana asked the assistant "Add a slide about recursion"', async () => {
      await askAndWait('Add a slide about recursion')
      await vi.waitFor(() => expect(laterSlides()).toEqual(['# Recursion']))
      expect(undoShown()).toBe(true)
    })
    When('Ana types "My own notes" into the slide Claude added, and it is saved', async () => {
      await web.fill('[data-testid="markdown-editor"]', editor().value.replace('# Recursion', '# Recursion\n\nMy own notes'))
      await vi.waitFor(async () => expect(await savedMarkdown()).toContain('My own notes'), { timeout: 3000 })
      await web.settle()
    })
    Then('"Undo" is no longer there', () => {
      expect(undoShown()).toBe(false)
    })
    And('the deck keeps the slide "# Recursion" with "My own notes"', async () => {
      expect(laterSlides()).toEqual(['# Recursion\n\nMy own notes'])
      expect(splitSlides(await savedMarkdown()).slice(1).map(slide => slide.content)).toEqual(['# Recursion\n\nMy own notes'])
    })
  })

  Scenario('Opening another deck while Claude works leaves it editable', ({ Given, And, When, Then }) => {
    let finish: () => void
    Given('Ana is signed in with the blank decks "Graphs" and "Trees", "Graphs" open and the assistant on', () => openDeck({ otherDeck: 'Trees' }))
    And('Claude is slow to finish', () => {
      assistant.hold = new Promise((resolve) => {
        finish = resolve
      })
    })
    When('Ana asks the assistant "Add a slide about recursion"', async () => {
      await ask('Add a slide about recursion')
      expect(editor().readOnly).toBe(true)
    })
    And('Ana opens the deck "Trees" while Claude works', async () => {
      await web.router.push({ name: 'deck', params: { projectId, deckId: otherDeckId } })
      await vi.waitFor(() => expect(editor()?.value ?? '').toContain('# Trees'))
    })
    And('Claude finishes', async () => {
      finish()
      await web.settle()
    })
    Then('the editor holds the deck "Trees" and can be typed in', async () => {
      expect(editor().value).toContain('# Trees')
      expect(editor().readOnly).toBe(false)
      await web.fill('[data-testid="markdown-editor"]', editor().value.replace('# Trees', '# Trees, typed'))
      await vi.waitFor(() => expect(text('[data-testid="save-status"]')).toBe('Saved'), { timeout: 3000 })
      const doc = new Y.Doc()
      Y.applyUpdate(doc, await api.deckState(otherDeckId))
      expect(deckMarkdown(doc)).toContain('# Trees, typed')
      expect(deckMarkdown(doc)).not.toContain('# Recursion')
    })
  })
})
