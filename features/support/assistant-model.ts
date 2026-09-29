import type { BetaContentBlock, BetaMessageStreamParams, BetaUsage } from '@anthropic-ai/sdk/resources/beta/messages'
import type { AssistantModel, ModelTurn, TurnOptions } from '../../apps/server/src/assistant/model'

/** A tool call the fake model makes. */
export interface FakeCall {
  name: string
  input: Record<string, unknown>
}

export interface FakeTurnOptions {
  text?: string
  calls?: FakeCall[]
  stop?: ModelTurn['stop_reason']
  /** Token counts. The default is small enough to cost a fraction of a cent. */
  usage?: Partial<BetaUsage>
  model?: string
}

let nextId = 1

/** Builds a response the way the API shapes it: text first, then tool calls. */
export function fakeTurn({ text, calls = [], stop, usage, model = 'claude-opus-5-5' }: FakeTurnOptions): ModelTurn {
  const content: BetaContentBlock[] = []
  if (text)
    content.push({ type: 'text', text, citations: null } as BetaContentBlock)
  for (const call of calls)
    content.push({ type: 'tool_use', id: `toolu_fake_${nextId++}`, name: call.name, input: call.input } as BetaContentBlock)
  return {
    model,
    content,
    stop_reason: stop ?? (calls.length > 0 ? 'tool_use' : 'end_turn'),
    usage: { input_tokens: 1000, output_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, iterations: null, ...usage } as BetaUsage,
  }
}

/**
 * Plays back queued responses and records every request, so scenarios can
 * check what Claude would have been sent without calling the real API.
 * With nothing queued it answers "Done." and stops.
 */
export class ScriptedModel implements AssistantModel {
  readonly requests: BetaMessageStreamParams[] = []
  private readonly script: ModelTurn[] = []
  /** When set, each call waits for this before answering. */
  hold?: Promise<void>

  queue(...turns: ModelTurn[]) {
    this.script.push(...turns)
  }

  async turn(params: BetaMessageStreamParams, { onText }: TurnOptions): Promise<ModelTurn> {
    this.requests.push(structuredClone(params))
    await this.hold
    const turn = this.script.shift() ?? fakeTurn({ text: 'Done.' })
    for (const block of turn.content) {
      if (block.type === 'text')
        onText(block.text)
    }
    return turn
  }
}
