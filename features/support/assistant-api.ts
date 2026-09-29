import type { AssistantAllowance, AssistantApi, AssistantDone, AssistantEvent, AssistantRequest } from '../../apps/web/src/assistant/api'
import { AssistantError } from '../../apps/web/src/assistant/api'
import { joinSlides, slideTexts } from '../../packages/deck-model/src'

/**
 * The assistant API for page scenarios. "Add a slide about <topic>" adds a
 * slide at the end, like the real assistant would. The API has its own scenarios.
 */
export class FakeAssistantApi implements AssistantApi {
  readonly requests: { deckId: string, request: AssistantRequest }[] = []
  on: boolean
  usedPercent = 0
  /** When set, the next request fails with this message. */
  failWith = ''
  /** When set, a reply waits for this after its changes arrive. */
  hold?: Promise<void>

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
    const topic = request.message.match(/^add a slide about (.+?)\.?$/i)?.[1]
    if (topic) {
      const title = topic[0].toUpperCase() + topic.slice(1)
      const slides = [...slideTexts(request.markdown), `# ${title}\n`]
      onEvent({ type: 'text', text: 'Adding' })
      onEvent({ type: 'deck', markdown: joinSlides(slides), change: `Added slide ${slides.length}`, slide: slides.length })
      reply = `Added a slide about ${topic}.`
    }
    await this.hold
    this.usedPercent += 5
    return { reply, stop: 'done', allowance: await this.allowance() }
  }
}
