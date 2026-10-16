import type { AssistantAllowance, AssistantApi, AssistantDone, AssistantEvent, AssistantRequest } from '../../apps/web/src/assistant/api'
import { AssistantError } from '../../apps/web/src/assistant/api'
import { joinSlides, slideTexts } from '../../packages/deck-model/src'

/**
 * The assistant API for page scenarios. "Add a slide about <topic>" adds a
 * slide at the end, like the real assistant would. "Add slides about <one>
 * and <two>" adds a slide for each, sending the deck after each one, as the
 * real server does after each change. The API has its own scenarios.
 */
export class FakeAssistantApi implements AssistantApi {
  readonly requests: { deckId: string, request: AssistantRequest }[] = []
  on: boolean
  usedPercent = 0
  /** When set, the next request fails with this message. */
  failWith = ''
  /** When set, a reply waits for this after its changes arrive. */
  hold?: Promise<void>
  /** When set, a reply waits for this before its changes arrive, as Claude thinking for a while would. */
  holdChanges?: Promise<void>
  /** Milliseconds a reply waits between two of its changes. */
  pauseBetweenChanges = 0

  constructor({ on = true }: { on?: boolean } = {}) {
    this.on = on
  }

  async enabled() {
    return this.on
  }

  async allowance(): Promise<AssistantAllowance> {
    return { usedPercent: this.usedPercent, resetsAt: '2026-10-01T00:00:00.000Z' }
  }

  async ask(deckId: string, request: AssistantRequest, onEvent: (event: AssistantEvent) => void): Promise<AssistantDone> {
    this.requests.push({ deckId, request: structuredClone(request) })
    if (this.failWith) {
      const message = this.failWith
      this.failWith = ''
      throw new AssistantError(message)
    }
    let reply = 'I can add a slide about a topic.'
    const one = request.message.match(/^add a slide about (.+?)\.?$/i)?.[1]
    const topics = one ? [one] : request.message.match(/^add slides about (.+?)\.?$/i)?.[1].split(/\s+and\s+/) ?? []
    if (topics.length) {
      const slides = slideTexts(request.markdown)
      onEvent({ type: 'text', text: 'Adding' })
      if (this.holdChanges)
        await this.holdChanges
      for (const [index, topic] of topics.entries()) {
        if (index > 0 && this.pauseBetweenChanges)
          await new Promise(resolve => setTimeout(resolve, this.pauseBetweenChanges))
        slides.push(`# ${topic[0].toUpperCase()}${topic.slice(1)}\n`)
        onEvent({ type: 'deck', markdown: joinSlides(slides), change: `Added slide ${slides.length}`, slide: slides.length })
      }
      reply = `Added ${one ? 'a slide' : 'slides'} about ${topics.join(' and ')}.`
    }
    await this.hold
    this.usedPercent += 5
    return { reply, stop: 'done', allowance: await this.allowance() }
  }
}
