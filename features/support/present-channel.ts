import type { PresentChannel } from '../../apps/web/src/platform/platform'
import type { PresentMessage } from '../../apps/web/src/present/presentation'
import { PRESENT_CHANNEL_KEY } from '../../apps/web/src/present/presentation'

/**
 * Stands in for the windows of a deck being presented: every page that
 * presents gets a channel here, and what one posts reaches the others of
 * the same deck a moment later, as BroadcastChannel and the app's events
 * deliver it. A scenario can post as a window of its own.
 */
export class FakePresentHub {
  /** Everything every window posted, in order. */
  readonly posted: { deckId: string, message: PresentMessage }[] = []
  /** Audience windows the pages asked to open. */
  readonly opened: { projectId: string, deckId: string, url: string }[] = []
  /** False as on Android, where the presenter has no second window. */
  canOpenAudience = true
  private readonly channels = new Set<{ deckId: string, deliver: (message: PresentMessage) => void }>()

  /** What a page gets in place of the platform's channel. */
  readonly channelFor = (deckId: string): PresentChannel<PresentMessage> => {
    const handlers = new Set<(message: PresentMessage) => void>()
    const self = { deckId, deliver: (message: PresentMessage) => handlers.forEach(handler => handler(message)) }
    this.channels.add(self)
    return {
      post: (message) => {
        this.posted.push({ deckId, message: structuredClone(message) })
        this.deliver(deckId, message, self)
      },
      listen: (handler) => {
        handlers.add(handler)
        return () => handlers.delete(handler)
      },
      canOpenAudience: this.canOpenAudience,
      openAudience: async (target) => {
        this.opened.push(target)
        return this.canOpenAudience
      },
      close: () => {
        this.channels.delete(self)
      },
    }
  }

  /** Provide this when mounting the app. */
  get provide() {
    return { [PRESENT_CHANNEL_KEY as symbol]: this.channelFor }
  }

  /** Posts as another window of the deck. */
  send(deckId: string, message: PresentMessage) {
    this.deliver(deckId, message)
  }

  /** What the pages posted for a deck. */
  messages(deckId: string) {
    return this.posted.filter(item => item.deckId === deckId).map(item => item.message)
  }

  private deliver(deckId: string, message: PresentMessage, from?: object) {
    const copy = structuredClone(message)
    for (const channel of [...this.channels]) {
      if (channel !== from && channel.deckId === deckId)
        queueMicrotask(() => this.channels.has(channel) && channel.deliver(copy))
    }
  }
}
