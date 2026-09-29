import type { BetaTool, BetaToolUseBlock } from '@anthropic-ai/sdk/resources/beta/messages'
import type { DeckDraft } from './draft.ts'
import { z } from 'zod'
import { EditError } from './draft.ts'

const SLIDE_TEXT = 'The whole slide: optional frontmatter between --- lines, the Markdown content, then optional speaker notes in an HTML comment.'

/**
 * The only things the assistant can do: change the Markdown it was given.
 * Strict schemas keep calls well formed, and inputs stream as they are
 * written, so every input is still checked with Zod before it runs.
 */
const DEFINITIONS: BetaTool[] = [
  {
    name: 'replace_slide',
    description: 'Replace one slide with new text. Use it to change a slide\'s content, layout or notes.',
    input_schema: {
      type: 'object',
      properties: {
        slide: { type: 'integer', description: 'Number of the slide to replace, starting at 1.' },
        text: { type: 'string', description: SLIDE_TEXT },
      },
      required: ['slide', 'text'],
      additionalProperties: false,
    },
  },
  {
    name: 'insert_slide',
    description: 'Add a new slide. It gets the given number and the slides from there on move down by one. Use the slide count plus 1 to add it at the end.',
    input_schema: {
      type: 'object',
      properties: {
        position: { type: 'integer', description: 'Number the new slide will have, starting at 1.' },
        text: { type: 'string', description: SLIDE_TEXT },
      },
      required: ['position', 'text'],
      additionalProperties: false,
    },
  },
  {
    name: 'delete_slide',
    description: 'Delete one slide. The slides after it move up by one.',
    input_schema: {
      type: 'object',
      properties: {
        slide: { type: 'integer', description: 'Number of the slide to delete, starting at 1.' },
      },
      required: ['slide'],
      additionalProperties: false,
    },
  },
  {
    name: 'move_slide',
    description: 'Move one slide so that it gets a new number.',
    input_schema: {
      type: 'object',
      properties: {
        slide: { type: 'integer', description: 'Number of the slide to move, starting at 1.' },
        to: { type: 'integer', description: 'Number the slide will have after the move.' },
      },
      required: ['slide', 'to'],
      additionalProperties: false,
    },
  },
]

export const TOOLS: BetaTool[] = DEFINITIONS.map(tool => ({ ...tool, strict: true, eager_input_streaming: true }))

const SlideNumber = z.number().int()
const Text = z.string().max(20_000)

/** Checks each tool's input and applies it. Returns the note shown in the chat and the slide to show. */
const HANDLERS = {
  replace_slide: (draft: DeckDraft, input: unknown) => {
    const { slide, text } = z.strictObject({ slide: SlideNumber, text: Text }).parse(input)
    draft.replace(slide, text)
    return { change: `Changed slide ${slide}`, slide }
  },
  insert_slide: (draft: DeckDraft, input: unknown) => {
    const { position, text } = z.strictObject({ position: SlideNumber, text: Text }).parse(input)
    draft.insert(position, text)
    return { change: `Added slide ${position}`, slide: position }
  },
  delete_slide: (draft: DeckDraft, input: unknown) => {
    const { slide } = z.strictObject({ slide: SlideNumber }).parse(input)
    draft.remove(slide)
    return { change: `Deleted slide ${slide}`, slide: Math.min(slide, draft.count) }
  },
  move_slide: (draft: DeckDraft, input: unknown) => {
    const { slide, to } = z.strictObject({ slide: SlideNumber, to: SlideNumber }).parse(input)
    draft.move(slide, to)
    return { change: `Moved slide ${slide} to ${to}`, slide: to }
  },
}

export interface ToolOutcome {
  /** What goes back to the model. */
  content: string
  isError: boolean
  /** When the deck changed: a short note for the chat and the slide it touched, counted from 1. */
  edit?: { change: string, slide: number }
}

/** Runs one tool call against the draft. Bad input and bad edits become error results the model can fix. */
export function runTool(draft: DeckDraft, call: Pick<BetaToolUseBlock, 'name' | 'input'>): ToolOutcome {
  if (!Object.hasOwn(HANDLERS, call.name))
    return { content: `There is no tool named ${call.name}.`, isError: true }
  try {
    const edit = HANDLERS[call.name as keyof typeof HANDLERS](draft, call.input)
    return { content: `Done. The deck now has these slides:\n${draft.outline()}`, isError: false, edit }
  }
  catch (error) {
    if (error instanceof z.ZodError)
      return { content: `The input was not valid: ${JSON.stringify(call.input)}. Send the call again with complete input.`, isError: true }
    if (error instanceof EditError)
      return { content: `Not changed: ${error.message}`, isError: true }
    throw error
  }
}
