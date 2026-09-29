import type { BetaMessage, BetaMessageStreamParams } from '@anthropic-ai/sdk/resources/beta/messages'
import Anthropic from '@anthropic-ai/sdk'

/** The parts of a model response the assistant reads. */
export type ModelTurn = Pick<BetaMessage, 'content' | 'stop_reason' | 'usage' | 'model'>

export interface TurnOptions {
  /** Called with each piece of reply text as it streams. */
  onText: (text: string) => void
}

/**
 * A streamed tool input that could not be read as JSON. Tool inputs stream
 * as they are written, so this can happen; the turn is worth asking again.
 */
export class UnreadableTurnError extends Error {}

/**
 * One model call. Claude in production, a scripted fake in tests, so tests
 * never reach the real API.
 */
export interface AssistantModel {
  turn: (params: BetaMessageStreamParams, options: TurnOptions) => Promise<ModelTurn>
}

/** Claude through the Anthropic SDK, streamed so long replies never time out. */
export class ClaudeModel implements AssistantModel {
  private readonly client: Anthropic

  constructor(client: Anthropic) {
    this.client = client
  }

  async turn(params: BetaMessageStreamParams, { onText }: TurnOptions): Promise<ModelTurn> {
    const stream = this.client.beta.messages.stream(params)
    stream.on('text', onText)
    try {
      return await stream.finalMessage()
    }
    catch (error) {
      // API errors are real failures. Anything else is the SDK failing to parse a tool input.
      if (error instanceof Anthropic.APIError)
        throw error
      throw new UnreadableTurnError('A tool input could not be read', { cause: error })
    }
  }
}
