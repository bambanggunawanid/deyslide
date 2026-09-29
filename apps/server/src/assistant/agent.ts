import type { BetaContentBlock, BetaContentBlockParam, BetaMessageParam, BetaToolResultBlockParam, BetaToolUseBlock } from '@anthropic-ai/sdk/resources/beta/messages'
import type { AssistantModel, ModelTurn } from './model.ts'
import { DeckDraft } from './draft.ts'
import { UnreadableTurnError } from './model.ts'
import { SYSTEM_PROMPT } from './prompt.ts'
import { runTool, TOOLS } from './tools.ts'

export const ASSISTANT_MODEL = 'claude-opus-5-5'
/** Model calls in one request. Each call can edit several slides. */
export const MAX_TURNS = 12
/** Retries of a turn whose streamed tool input could not be read. */
const MAX_UNREADABLE_RETRIES = 2

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

export type AssistantEvent =
  | { type: 'text', text: string }
  /** The deck after a change, with a short note for the chat and the slide it touched, counted from 1. */
  | { type: 'deck', markdown: string, change: string, slide: number }

export type StopReason = 'done' | 'refused' | 'too-long' | 'turn-limit' | 'allowance' | 'unreadable' | 'cancelled'

export interface AssistantResult {
  reply: string
  stop: StopReason
}

export interface RunOptions {
  model: AssistantModel
  request: AssistantRequest
  /** Sent to the API as an opaque id, so abuse can be traced to an account. */
  userId: string
  /**
   * Stops the work between model calls, for example when the person leaves.
   * A call that already started finishes, so its cost is always counted.
   */
  signal: AbortSignal
  emit: (event: AssistantEvent) => void | Promise<void>
  /** Records what a model call cost. Resolves to false when the account has no allowance left. */
  charge: (turn: ModelTurn) => Promise<boolean>
}

/** Earlier chat as plain text turns. The API needs the first message to come from the user. */
function historyMessages(history: ChatMessage[]): BetaMessageParam[] {
  const first = history.findIndex(message => message.role === 'user')
  return first === -1 ? [] : history.slice(first).map(({ role, text }) => ({ role, content: text }))
}

/**
 * Blocks to send back after a turn. When a fallback model took over part way,
 * the declined model's thinking and tool calls before the last switch point
 * are left out, as the API asks.
 */
function echoContent(content: BetaContentBlock[]): BetaContentBlockParam[] {
  const boundary = content.findLastIndex(block => block.type === 'fallback')
  const dropped = new Set(['thinking', 'redacted_thinking', 'tool_use', 'server_tool_use'])
  return content.filter((block, index) => index > boundary || !dropped.has(block.type)) as BetaContentBlockParam[]
}

/** Tool calls of the model that answered last, after any fallback switch point. */
function toolCalls(content: BetaContentBlock[]): BetaToolUseBlock[] {
  const boundary = content.findLastIndex(block => block.type === 'fallback')
  return content.slice(boundary + 1).filter((block): block is BetaToolUseBlock => block.type === 'tool_use')
}

function replyText(content: BetaContentBlock[]) {
  return content.map(block => block.type === 'text' ? block.text : '').join('').trim()
}

/**
 * Runs Claude on the open deck until it stops asking for tools. The model
 * only ever sees the Markdown and chat that came with this request, and its
 * only tools edit that Markdown, so it cannot reach any other deck or account.
 */
export async function runAssistant({ model, request, userId, signal, emit, charge }: RunOptions): Promise<AssistantResult> {
  const draft = new DeckDraft(request.markdown)
  const messages: BetaMessageParam[] = [
    ...historyMessages(request.history),
    {
      role: 'user',
      content: [
        { type: 'text', text: `The deck as it is now:\n\n${draft.numbered()}` },
        { type: 'text', text: request.message },
      ],
    },
  ]
  const replies: string[] = []
  let unreadable = 0

  const finish = (stop: StopReason): AssistantResult => ({ reply: replies.filter(Boolean).join('\n\n'), stop })

  for (let turnNumber = 0; turnNumber < MAX_TURNS; turnNumber++) {
    let turn: ModelTurn
    try {
      turn = await model.turn({
        model: ASSISTANT_MODEL,
        max_tokens: 16_000,
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        thinking: { type: 'adaptive' },
        output_config: { effort: 'medium' },
        // Caches the system prompt, the tools and the conversation so far, so each later turn reads them cheaply.
        cache_control: { type: 'ephemeral' },
        system: SYSTEM_PROMPT,
        tools: TOOLS,
        messages,
        metadata: { user_id: userId },
      }, {
        onText: text => void emit({ type: 'text', text }),
      })
      unreadable = 0
    }
    catch (error) {
      if (!(error instanceof UnreadableTurnError))
        throw error
      if (++unreadable > MAX_UNREADABLE_RETRIES)
        return finish('unreadable')
      turnNumber--
      continue
    }

    const hasAllowance = await charge(turn)
    replies.push(replyText(turn.content))

    // A refusal can cut a tool call off part way, so none of this turn's calls run.
    if (turn.stop_reason === 'refusal')
      return finish('refused')
    const calls = toolCalls(turn.content)
    if (calls.length === 0)
      return finish('done')
    // A tool input cut off by the token limit can still look complete, so it never runs.
    if (turn.stop_reason === 'max_tokens')
      return finish('too-long')

    const results: BetaToolResultBlockParam[] = []
    for (const call of calls) {
      const outcome = runTool(draft, call)
      results.push({ type: 'tool_result', tool_use_id: call.id, content: outcome.content, is_error: outcome.isError })
      if (outcome.edit)
        await emit({ type: 'deck', markdown: draft.markdown, ...outcome.edit })
    }

    if (!hasAllowance)
      return finish('allowance')
    if (signal.aborted)
      return finish('cancelled')

    messages.push({ role: 'assistant', content: echoContent(turn.content) })
    messages.push({ role: 'user', content: results })
  }
  return finish('turn-limit')
}
