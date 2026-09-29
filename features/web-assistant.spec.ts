import type { WebApp } from './support/web'
import { describeFeature, loadFeature } from '@amiceli/vitest-cucumber'
import { expect, vi } from 'vitest'
import * as Y from 'yjs'
import { MemoryGuestStorage } from '../apps/web/src/guest/memory-storage'
import { GuestStore } from '../apps/web/src/guest/store'
import { splitSlides } from '../packages/deck-model/src'
import { FakeAccountService } from './support/account'
import { FakeAssistantApi } from './support/assistant-api'
import { previewRequests, resetEditorDoubles } from './support/editor-doubles'
import { FakeProjectApi } from './support/project-api'
import { find, findAll, mountWebApp, text } from './support/web'

const feature = await loadFeature('./web-assistant.feature')

describeFeature(feature, ({ Scenario, AfterEachScenario }) => {
  let web: WebApp
  let api: FakeProjectApi
  let assistant: FakeAssistantApi
  let deckId: string
  let original: string

  AfterEachScenario(() => {
    web?.unmount()
    resetEditorDoubles()
  })

  const editor = () => find('[data-testid="markdown-editor"]') as HTMLTextAreaElement
  const input = () => find('[data-testid="assistant-input"]') as HTMLTextAreaElement

  async function openDeck({ signedIn = true, on = true, usedPercent = 0 } = {}) {
    const guest = await GuestStore.open(new MemoryGuestStorage())
    const service = new FakeAccountService()
    api = new FakeProjectApi()
    assistant = new FakeAssistantApi({ on })
    assistant.usedPercent = usedPercent
    let projectId: string
    if (signedIn) {
      service.addAccount('ana@example.com', 'correct horse')
      await service.signIn({ email: 'ana@example.com', password: 'correct horse' })
      projectId = (await api.createProject('Talks')).id
      web = await mountWebApp({ service, api, guest, assistant })
      deckId = (await web.workspace.store.value.createDeck(projectId, 'Graphs', 'blank')).id
    }
    else {
      projectId = (await guest.createProject('Talks')).id
      deckId = (await guest.createDeck(projectId, 'Graphs', 'blank')).id
      web = await mountWebApp({ service, api, guest, assistant })
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

  const slideCount = () => splitSlides(editor().value).length

  function slidesIn(state: Uint8Array) {
    const doc = new Y.Doc()
    Y.applyUpdate(doc, state)
    return (doc.getMap('deck').get('slides') as Y.Array<unknown>).length
  }

  Scenario('Ask for a new slide', ({ Given, When, Then, And }) => {
    Given('Ana is signed in with the blank deck "Graphs" open and the assistant on', () => openDeck())
    When('she asks the assistant "Add a slide about recursion"', () => ask('Add a slide about recursion'))
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
    And('she asked the assistant "Add a slide about recursion"', () => ask('Add a slide about recursion'))
    When('she presses "Undo"', () => web.click('[data-testid="assistant-undo"]'))
    Then('the editor holds only the first slide again', () => {
      expect(editor().value).toBe(original)
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
    When('she asks the assistant "Add a slide about recursion"', () => ask('Add a slide about recursion'))
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
    And('she asked the assistant "Add a slide about recursion"', () => ask('Add a slide about recursion'))
    When('she asks the assistant "Make it shorter"', () => ask('Make it shorter'))
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
    When('she asks the assistant "Add a slide about recursion"', () => ask('Add a slide about recursion'))
    Then('the assistant shows "You have used this month\'s assistant allowance. It starts again on October 1."', () => {
      expect(text('[data-testid="assistant-error"]')).toBe('You have used this month\'s assistant allowance. It starts again on October 1.')
      expect(findAll('[data-testid="assistant-user"]')).toHaveLength(0)
    })
    And('her message is back in the input', () => {
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
})
