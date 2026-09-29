// A fake Claude for the end to end tests, so they never call the real API.
import type { BetaMessageStreamParams } from '@anthropic-ai/sdk/resources/beta/messages'
import type { AssistantModel, ModelTurn, TurnOptions } from '../apps/server/src/assistant/model.ts'
import { fakeTurn } from '../features/support/assistant-model.ts'

/**
 * "Add a slide about <topic>" adds a slide at the end, "Delete slide <n>"
 * deletes one, and anything else gets a short answer without changes.
 */
export class KeywordModel implements AssistantModel {
  async turn(params: BetaMessageStreamParams, { onText }: TurnOptions): Promise<ModelTurn> {
    const last = params.messages.at(-1)!
    // After the tools ran, the fake finishes its reply.
    if (Array.isArray(last.content) && last.content.some(block => block.type === 'tool_result')) {
      onText('Done. Have a look at the preview.')
      return fakeTurn({ text: 'Done. Have a look at the preview.' })
    }
    const blocks = Array.isArray(last.content) ? last.content : [{ type: 'text' as const, text: last.content }]
    const message = blocks.flatMap(block => block.type === 'text' ? [block.text] : []).at(-1) ?? ''
    const slideCount = (blocks[0]?.type === 'text' ? blocks[0].text.match(/<slide number=/g)?.length : 0) ?? 0

    const topic = message.match(/^add a slide about (.+?)\.?$/i)?.[1]
    if (topic) {
      const title = topic[0].toUpperCase() + topic.slice(1)
      return fakeTurn({ calls: [{ name: 'insert_slide', input: { position: slideCount + 1, text: `# ${title}\n\nA few words about ${topic}.` } }] })
    }
    const deleted = message.match(/^delete slide (\d+)\.?$/i)?.[1]
    if (deleted)
      return fakeTurn({ calls: [{ name: 'delete_slide', input: { slide: Number(deleted) } }] })

    onText('I can add a slide about a topic or delete a slide.')
    return fakeTurn({ text: 'I can add a slide about a topic or delete a slide.' })
  }
}
