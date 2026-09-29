/** A message in the assistant chat. */
export interface ChatMessage {
  role: 'user' | 'assistant'
  text: string
}

export interface AssistantRequest {
  markdown: string
  message: string
  /** Earlier messages of this chat, oldest first. */
  history: ChatMessage[]
}

export interface AssistantAllowance {
  /** Share of this month's allowance used, from 0 to 100. */
  usedPercent: number
  /** When the allowance starts again, as an ISO date. */
  resetsAt: string
}

/** Why a reply ended. */
export type AssistantStop = 'done' | 'refused' | 'too-long' | 'turn-limit' | 'allowance' | 'unreadable' | 'cancelled'

export interface AssistantDone {
  reply: string
  stop: AssistantStop
  allowance: AssistantAllowance
}

export type AssistantEvent =
  | { type: 'text', text: string }
  /** The deck after a change. `slide` is the slide it touched, counted from 1. */
  | { type: 'deck', markdown: string, change: string, slide: number }

/** A failure to show in the chat, already in plain words. */
export class AssistantError extends Error {}

/** The deck assistant on the Deyslide API. */
export interface AssistantApi {
  /** Whether the server has the assistant turned on. */
  enabled: () => Promise<boolean>
  allowance: () => Promise<AssistantAllowance>
  /** Streams a reply. Changes arrive through `onEvent` as they happen. */
  ask: (deckId: string, request: AssistantRequest, onEvent: (event: AssistantEvent) => void) => Promise<AssistantDone>
}

const MESSAGES: Record<number, string> = {
  401: 'You are signed out. Sign in again to use the assistant.',
  404: 'This deck is not in your account.',
}

const UNREACHABLE = 'Deyslide is unreachable. Check your connection and try again.'

interface StreamMessage {
  event: string
  data: string
}

/** Splits a Server Sent Events stream into messages as the pieces arrive. */
async function* readEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<StreamMessage> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  while (true) {
    const { value, done } = await reader.read()
    if (done)
      return
    buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n')
    let end = buffer.indexOf('\n\n')
    while (end !== -1) {
      const lines = buffer.slice(0, end).split('\n')
      buffer = buffer.slice(end + 2)
      const event = lines.find(line => line.startsWith('event:'))?.slice(6).trim() ?? 'message'
      const data = lines.filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n')
      yield { event, data }
      end = buffer.indexOf('\n\n')
    }
  }
}

export class HttpAssistantApi implements AssistantApi {
  private readonly fetchImpl: typeof fetch

  constructor(fetchImpl: typeof fetch = (...args) => fetch(...args)) {
    this.fetchImpl = fetchImpl
  }

  async enabled() {
    try {
      const response = await this.fetchImpl('/api/config')
      return response.ok && Boolean((await response.json() as { assistant?: boolean }).assistant)
    }
    catch {
      return false
    }
  }

  async allowance() {
    return await (await this.send('GET', '/api/assistant')).json() as AssistantAllowance
  }

  async ask(deckId: string, request: AssistantRequest, onEvent: (event: AssistantEvent) => void) {
    const response = await this.send('POST', `/api/decks/${encodeURIComponent(deckId)}/assistant`, request)
    if (!response.body)
      throw new AssistantError(UNREACHABLE)
    try {
      for await (const { event, data } of readEvents(response.body)) {
        if (event === 'text' || event === 'deck')
          onEvent(JSON.parse(data) as AssistantEvent)
        else if (event === 'done')
          return JSON.parse(data) as AssistantDone
        else if (event === 'failed')
          throw new AssistantError((JSON.parse(data) as { error: string }).error)
      }
    }
    catch (error) {
      if (error instanceof AssistantError)
        throw error
      throw new AssistantError(UNREACHABLE)
    }
    throw new AssistantError('The reply stopped part way. Try again.')
  }

  private async send(method: string, path: string, body?: unknown) {
    let response: Response
    try {
      response = await this.fetchImpl(path, {
        method,
        credentials: 'same-origin',
        headers: body === undefined ? undefined : { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
    }
    catch {
      throw new AssistantError(UNREACHABLE)
    }
    if (response.ok)
      return response
    const reason = await response.json().then((data: { error?: string }) => data.error, () => undefined)
    throw new AssistantError(MESSAGES[response.status] ?? reason ?? 'The assistant could not answer. Try again.')
  }
}
