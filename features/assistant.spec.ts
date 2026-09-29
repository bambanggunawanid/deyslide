// @vitest-environment node
import type { BetaMessageParam, BetaToolResultBlockParam } from '@anthropic-ai/sdk/resources/beta/messages'
import type { AssistantAllowance, AssistantDone } from '../apps/server/src/assistant/routes'
import type { Project } from '../apps/server/src/projects'
import type { TestBrowser, TestServer } from './support/server'
import { describeFeature, loadFeature } from '@amiceli/vitest-cucumber'
import { beforeAll, expect } from 'vitest'
import { slideTexts } from '../packages/deck-model/src'
import { fakeTurn, ScriptedModel } from './support/assistant-model'
import { demoDeckMarkdown, demoDeckState } from './support/deck-content'
import { createTestServer, DATABASE_WARM_UP_MS, TestBrowser as Browser, signedInBrowser, warmUpDatabase } from './support/server'

const feature = await loadFeature('./assistant.feature')

beforeAll(warmUpDatabase, DATABASE_WARM_UP_MS)

interface StreamEvent {
  event: string
  data: any
}

/** Reads a whole Server Sent Events body into its events. */
function parseEvents(text: string): StreamEvent[] {
  return text.split('\n\n').filter(chunk => chunk && !chunk.startsWith(':')).map((chunk) => {
    const lines = chunk.split('\n')
    const event = lines.find(line => line.startsWith('event:'))?.slice(6).trim() ?? 'message'
    const data = lines.filter(line => line.startsWith('data:')).map(line => line.slice(5).trim()).join('\n')
    return { event, data: JSON.parse(data) }
  })
}

const dollars = (amount: number) => ({ input_tokens: amount * 250_000, output_tokens: 0 })

describeFeature(feature, ({ Background, Scenario }) => {
  let server: TestServer
  let model: ScriptedModel
  let today: Date
  let ana: TestBrowser
  let deckId: string
  let status: number
  let events: StreamEvent[]
  let error: string

  async function ask(browser: TestBrowser, message: string, extra: { markdown?: string, history?: unknown[], deck?: string } = {}) {
    const response = await browser.request(`/api/decks/${extra.deck ?? deckId}/assistant`, {
      json: { markdown: extra.markdown ?? demoDeckMarkdown(), message, history: extra.history ?? [] },
    })
    status = response.status
    const text = await response.text()
    if (response.headers.get('content-type')?.startsWith('text/event-stream')) {
      events = parseEvents(text)
      error = ''
    }
    else {
      events = []
      error = (JSON.parse(text) as { error: string }).error
    }
    return response
  }

  const changes = () => events.filter(item => item.event === 'deck').map(item => item.data.change)
  const done = () => events.find(item => item.event === 'done')?.data as AssistantDone
  const lastRequest = () => model.requests.at(-1)!
  const toolResults = () => model.requests.flatMap(request => request.messages)
    .flatMap(message => Array.isArray(message.content) ? message.content : [])
    .filter((block): block is BetaToolResultBlockParam => block.type === 'tool_result')

  function textOf(message: BetaMessageParam) {
    return typeof message.content === 'string'
      ? message.content
      : message.content.map(block => block.type === 'text' ? block.text : '').join('\n')
  }

  Background(({ Given, And }) => {
    Given('the Deyslide API with the assistant and a scripted Claude', async () => {
      model = new ScriptedModel()
      today = new Date(Date.UTC(2026, 8, 15))
      server = await createTestServer({ assistantModel: model, now: () => today })
    })
    And('Ana is signed in with the demo deck "Sorting" open', async () => {
      ana = await signedInBrowser(server, 'ana@example.com')
      const project = (await ana.json<Project>('/api/projects', { json: { name: 'Algorithms 101' } })).body
      const deck = await ana.json<{ id: string }>(`/api/projects/${project.id}/decks`, { json: { name: 'Sorting', state: demoDeckState() } })
      deckId = deck.body.id
    })
  })

  Scenario('Claude adds a slide', ({ Given, When, Then, And }) => {
    Given('Claude will add the slide "# Recursion" at position 6 and then reply "Added a slide about recursion."', () => {
      model.queue(
        fakeTurn({ calls: [{ name: 'insert_slide', input: { position: 6, text: '# Recursion' } }] }),
        fakeTurn({ text: 'Added a slide about recursion.' }),
      )
    })
    When('Ana asks "Add a slide about recursion"', async () => {
      await ask(ana, 'Add a slide about recursion')
      expect(status).toBe(200)
    })
    Then('the stream shows the change "Added slide 6"', () => {
      expect(changes()).toEqual(['Added slide 6'])
      expect(events.find(item => item.event === 'deck')!.data.slide).toBe(6)
    })
    And('the deck in the stream has 6 slides and the last is titled "Recursion"', () => {
      const slides = slideTexts(events.find(item => item.event === 'deck')!.data.markdown)
      expect(slides).toHaveLength(6)
      expect(slides.at(-1)!.trim()).toBe('# Recursion')
    })
    And('the stream ends with the reply "Added a slide about recursion."', () => {
      expect(done()).toMatchObject({ reply: 'Added a slide about recursion.', stop: 'done' })
      expect(events.at(-1)!.event).toBe('done')
    })
  })

  Scenario('Claude gets the open deck and nothing else', ({ When, Then, And }) => {
    When('Ana asks "Make the title shorter"', async () => {
      await ask(ana, 'Make the title shorter')
    })
    Then('Claude was asked with the model "claude-opus-5-5" and server side fallbacks', () => {
      expect(lastRequest()).toMatchObject({ model: 'claude-opus-5-5', fallbacks: 'default', betas: ['server-side-fallback-2026-07-01'] })
    })
    And('Claude\'s only tools are "replace_slide, insert_slide, delete_slide, move_slide"', () => {
      expect(lastRequest().tools!.map(tool => 'name' in tool ? tool.name : tool.type).join(', ')).toBe('replace_slide, insert_slide, delete_slide, move_slide')
      expect(lastRequest().tools!.every(tool => 'strict' in tool && tool.strict)).toBe(true)
    })
    And('Claude received the 5 slides of the deck, numbered, and the message "Make the title shorter"', () => {
      const { messages } = lastRequest()
      expect(messages).toHaveLength(1)
      const text = textOf(messages[0])
      expect(text.match(/<slide number="\d+">/g)).toEqual([1, 2, 3, 4, 5].map(number => `<slide number="${number}">`))
      expect(text.endsWith('Make the title shorter')).toBe(true)
    })
  })

  Scenario('The chat so far goes along', ({ When, Then }) => {
    When('Ana asks "Now make it blue" after the chat "Add a slide about recursion" and "Added a slide about recursion."', async () => {
      await ask(ana, 'Now make it blue', {
        history: [{ role: 'user', text: 'Add a slide about recursion' }, { role: 'assistant', text: 'Added a slide about recursion.' }],
      })
    })
    Then('Claude received the chat in order before the deck', () => {
      const { messages } = lastRequest()
      expect(messages.map(message => message.role)).toEqual(['user', 'assistant', 'user'])
      expect(messages.slice(0, 2).map(textOf)).toEqual(['Add a slide about recursion', 'Added a slide about recursion.'])
      expect(textOf(messages[2])).toContain('<slide number="1">')
    })
  })

  Scenario('A change that would break the deck goes back to Claude', ({ Given, When, Then, And }) => {
    Given('Claude will first send two slides as one, then send "# Fixed" for slide 2', () => {
      model.queue(
        fakeTurn({ calls: [{ name: 'replace_slide', input: { slide: 2, text: '# One\n\n---\n\n# Two' } }] }),
        fakeTurn({ calls: [{ name: 'replace_slide', input: { slide: 2, text: '# Fixed' } }] }),
        fakeTurn({ text: 'Fixed slide 2.' }),
      )
    })
    When('Ana asks "Fix slide 2"', async () => {
      await ask(ana, 'Fix slide 2')
    })
    Then('Claude was told "That text makes 2 slides"', () => {
      const [first] = toolResults()
      expect(first.is_error).toBe(true)
      expect(first.content).toContain('That text makes 2 slides')
    })
    And('the stream shows only the change "Changed slide 2"', () => {
      expect(changes()).toEqual(['Changed slide 2'])
      expect(slideTexts(events.find(item => item.event === 'deck')!.data.markdown)[1].trim()).toBe('# Fixed')
    })
  })

  Scenario('A refusal changes nothing', ({ Given, When, Then, And }) => {
    Given('Claude will refuse part way through a call to delete slide 1', () => {
      model.queue(fakeTurn({ calls: [{ name: 'delete_slide', input: { slide: 1 } }], stop: 'refusal' }))
    })
    When('Ana asks "Delete the first slide"', async () => {
      await ask(ana, 'Delete the first slide')
    })
    Then('the stream shows no change', () => {
      expect(changes()).toEqual([])
    })
    And('the stream ends because Claude declined', () => {
      expect(done().stop).toBe('refused')
    })
  })

  Scenario('Each month has an allowance', ({ Given, When, Then, And }) => {
    Given('the monthly allowance is 3 dollars and each of Claude\'s replies costs 2 dollars', () => {
      expect(server.config.assistant).toEqual({ monthlyLimitUsd: 3 })
      model.queue(fakeTurn({ text: 'One.', usage: dollars(2) }), fakeTurn({ text: 'Two.', usage: dollars(2) }), fakeTurn({ text: 'Three.', usage: dollars(2) }))
    })
    When('Ana asks "First" and then "Second"', async () => {
      await ask(ana, 'First')
      expect(done().allowance.usedPercent).toBe(66)
      await ask(ana, 'Second')
    })
    Then('the allowance shows 100 percent used, starting again on "2026-10-01"', async () => {
      const expected = { usedPercent: 100, resetsAt: '2026-10-01T00:00:00.000Z' }
      expect(done().allowance).toEqual(expected)
      expect((await ana.json<AssistantAllowance>('/api/assistant')).body).toEqual(expected)
    })
    When('Ana asks "Third"', async () => {
      await ask(ana, 'Third')
    })
    Then('it is refused with 429 "You have used this month\'s assistant allowance. It starts again on October 1."', () => {
      expect(status).toBe(429)
      expect(error).toBe('You have used this month\'s assistant allowance. It starts again on October 1.')
    })
    And('Claude received 2 requests', () => {
      expect(model.requests).toHaveLength(2)
    })
    When('the calendar moves to October 1', () => {
      today = new Date(Date.UTC(2026, 9, 1))
    })
    Then('Ana can ask again', async () => {
      await ask(ana, 'Third')
      expect(status).toBe(200)
      expect(done()).toMatchObject({ reply: 'Three.', allowance: { usedPercent: 66, resetsAt: '2026-11-01T00:00:00.000Z' } })
    })
  })

  Scenario('The allowance runs out part way through a reply', ({ Given, When, Then, And }) => {
    Given('the monthly allowance is 3 dollars and Claude\'s first turn costs 3 dollars while it deletes slide 5', () => {
      model.queue(fakeTurn({ calls: [{ name: 'delete_slide', input: { slide: 5 } }], usage: dollars(3) }))
    })
    When('Ana asks "Delete the last slide and tidy up"', async () => {
      await ask(ana, 'Delete the last slide and tidy up')
    })
    Then('the stream shows the change "Deleted slide 5"', () => {
      expect(changes()).toEqual(['Deleted slide 5'])
    })
    And('the stream ends because the allowance ran out', () => {
      expect(done()).toMatchObject({ stop: 'allowance', allowance: { usedPercent: 100 } })
    })
    And('Claude received 1 request', () => {
      expect(model.requests).toHaveLength(1)
    })
  })

  Scenario('A fallback model\'s tokens count at its own price', ({ Given, When, Then }) => {
    Given('Claude declined and a fallback finished, with 100000 input tokens on "claude-opus-5-5" and 100000 on "claude-opus-4-8"', () => {
      const attempt = { input_tokens: 100_000, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, cache_creation: null }
      model.queue(fakeTurn({
        text: 'Here is a slide.',
        model: 'claude-opus-4-8',
        usage: {
          ...attempt,
          iterations: [
            { ...attempt, type: 'message', model: 'claude-opus-5-5' },
            { ...attempt, type: 'fallback_message', model: 'claude-opus-4-8' },
          ] as never,
        },
      }))
    })
    When('Ana asks "Explain recursion on a slide"', async () => {
      await ask(ana, 'Explain recursion on a slide')
    })
    Then('the allowance shows 30 percent used', () => {
      expect(done().allowance.usedPercent).toBe(30)
    })
  })

  Scenario('Leaving part way still counts what Claude used', ({ Given, When, And, Then }) => {
    let release: () => void
    Given('Claude will delete slide 5 and cost 1 dollar, but is still thinking', () => {
      model.queue(fakeTurn({ calls: [{ name: 'delete_slide', input: { slide: 5 } }], usage: dollars(1) }))
      model.hold = new Promise((resolve) => {
        release = resolve
      })
    })
    When('Ana closes the page before Claude answers', async () => {
      const response = await ana.request(`/api/decks/${deckId}/assistant`, { json: { markdown: demoDeckMarkdown(), message: 'Delete the last slide' } })
      await expect.poll(() => model.requests.length).toBe(1)
      await response.body!.cancel()
    })
    And('Claude finishes that turn', () => {
      release()
    })
    Then('the allowance shows 33 percent used', async () => {
      await expect.poll(async () => (await ana.json<AssistantAllowance>('/api/assistant')).body.usedPercent).toBe(33)
    })
    And('Claude is not asked to continue that reply', async () => {
      // A new message is refused while the first reply still runs, so this waits for it to end.
      await expect.poll(async () => (await ask(ana, 'Hello'), status)).toBe(200)
      expect(model.requests).toHaveLength(2)
      expect(textOf(model.requests[1].messages.at(-1)!)).toContain('Hello')
    })
  })

  Scenario('One request at a time', ({ Given, When, Then }) => {
    let release: () => void
    let first: Promise<Response>
    Given('Claude is still thinking about Ana\'s first request', async () => {
      model.hold = new Promise((resolve) => {
        release = resolve
      })
      first = ana.request(`/api/decks/${deckId}/assistant`, { json: { markdown: demoDeckMarkdown(), message: 'First' } })
      await expect.poll(() => model.requests.length).toBe(1)
    })
    When('Ana sends a second request', async () => {
      await ask(ana, 'Second')
    })
    Then('it is refused with 409 "The assistant is still working on your last message."', async () => {
      expect(status).toBe(409)
      expect(error).toBe('The assistant is still working on your last message.')
      release()
      expect((await first).status).toBe(200)
      await (await first).text()
    })
  })

  Scenario('Other people\'s decks are out of reach', ({ Given, When, Then, And }) => {
    let budi: TestBrowser
    Given('Budi is signed in on another browser', async () => {
      budi = await signedInBrowser(server, 'budi@example.com')
    })
    When('Budi asks the assistant about Ana\'s deck', async () => {
      await ask(budi, 'Show me this deck')
    })
    Then('it is refused with 404 "Not found"', () => {
      expect(status).toBe(404)
      expect(error).toBe('Not found')
    })
    And('Claude received 0 requests', () => {
      expect(model.requests).toHaveLength(0)
    })
  })

  Scenario('Guests cannot use the assistant', ({ When, Then }) => {
    When('a guest asks the assistant about Ana\'s deck', async () => {
      await ask(new Browser(server), 'Show me this deck')
    })
    Then('it is refused with 401 "Sign in first"', () => {
      expect(status).toBe(401)
      expect(error).toBe('Sign in first')
    })
  })

  Scenario('Frontmatter Claude writes must be valid YAML', ({ Given, When, Then, And }) => {
    Given('Claude will first send slide 2 with an unclosed list in its frontmatter, then fix it', () => {
      model.queue(
        fakeTurn({ calls: [{ name: 'replace_slide', input: { slide: 2, text: '---\nlayout: [center\n---\n\n# Centered' } }] }),
        fakeTurn({ calls: [{ name: 'replace_slide', input: { slide: 2, text: '---\nlayout: center\n---\n\n# Centered' } }] }),
      )
    })
    When('Ana asks "Center slide 2"', async () => {
      await ask(ana, 'Center slide 2')
    })
    Then('Claude was told "The frontmatter is not valid YAML"', () => {
      const [first] = toolResults()
      expect(first.is_error).toBe(true)
      expect(first.content).toContain('The frontmatter is not valid YAML')
    })
    And('the stream shows only the change "Changed slide 2"', () => {
      expect(changes()).toEqual(['Changed slide 2'])
    })
  })

  Scenario('The assistant is off without a Claude API key', ({ Given, Then }) => {
    let off: TestServer
    Given('the Deyslide API without an Anthropic API key', async () => {
      off = await createTestServer()
    })
    Then('the public settings say the assistant is off', async () => {
      const config = await new Browser(off).json<{ assistant: boolean }>('/api/config')
      expect(config.body.assistant).toBe(false)
      const assistant = await new Browser(off).request('/api/assistant')
      expect(assistant.status).toBe(404)
    })
  })
})
