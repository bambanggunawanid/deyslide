import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import type { DeckWrite, MarkdownDecks } from './decks.ts'
import type { RenderedSlide, SlideRenderer } from './renderer.ts'
import type { LeftOut, LeftOutReason, SlideMedia } from './slide-media.ts'
import { splitSlides } from '@deyslide/deck-model'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { DeckDraft, EditError } from '../assistant/draft.ts'
import { DeckNotSavedError } from '../collab/documents.ts'
import { DeckTooBigError } from '../collab/limits.ts'
import { MAX_INLINE_MEDIA_BYTES } from '../exports/media.ts'
import { ForbiddenError, NameSchema } from '../projects.ts'
import { DeckInputError } from './decks.ts'
import { MCP_GUIDE, MCP_INSTRUCTIONS } from './guide.ts'
import { RendererUnavailableError } from './renderer.ts'
import { MediaBusyError } from './slide-media.ts'

/** Slides one render_slides call draws, so a result stays well inside client size limits. */
export const MAX_RENDERED_SLIDES = 6

export interface McpDependencies {
  decks: MarkdownDecks
  /** Missing when no renderer is set up. render_slides then says so. */
  renderer?: SlideRenderer
  /** The media library's files for slide images, when media is on. */
  media?: SlideMedia
  version: string
}

const DeckId = z.string().min(1).max(100).describe('The deck id from list_decks or create_deck.')
const SlideNumber = z.number().int().min(1).describe('Slide number, starting at 1.')
const SlideText = z.string().max(20_000).describe('The whole slide: optional frontmatter between --- lines, Markdown content, then optional speaker notes in an HTML comment. No --- separator between slides.')

const Edit = z.discriminatedUnion('action', [
  z.object({ action: z.literal('replace'), slide: SlideNumber, text: SlideText }),
  z.object({ action: z.literal('insert'), position: SlideNumber.describe('Number the new slide gets. Use the slide count plus 1 to add it at the end.'), text: SlideText }),
  z.object({ action: z.literal('delete'), slide: SlideNumber }),
  z.object({ action: z.literal('move'), slide: SlideNumber, to: SlideNumber.describe('Number the slide has after the move.') }),
])

function text(value: string, structured?: Record<string, unknown>): CallToolResult {
  return { content: [{ type: 'text', text: value }], ...(structured && { structuredContent: structured }) }
}

function problem(message: string): CallToolResult {
  return { content: [{ type: 'text', text: message }], isError: true }
}

/** A save that went wrong in a way Claude can act on, said so; anything else is rethrown. */
function notSaved(error: unknown): CallToolResult {
  if (error instanceof DeckInputError || error instanceof ForbiddenError || error instanceof EditError || error instanceof DeckTooBigError)
    return problem(`Nothing was saved. ${error.message}`)
  // The change reached the deck, so sending it again would make it twice.
  if (error instanceof DeckNotSavedError)
    return problem(`${error.message} Do not send the change again.`)
  throw error
}

type SlideEdit = z.infer<typeof Edit>

/** Applies the edits in order. A failing edit throws an `EditError` that says which one. */
function applyEdits(draft: DeckDraft, edits: SlideEdit[]) {
  for (const [index, edit] of edits.entries()) {
    try {
      if (edit.action === 'replace')
        draft.replace(edit.slide, edit.text)
      else if (edit.action === 'insert')
        draft.insert(edit.position, edit.text)
      else if (edit.action === 'delete')
        draft.remove(edit.slide)
      else
        draft.move(edit.slide, edit.to)
    }
    catch (error) {
      if (error instanceof EditError)
        throw new EditError(`Edit ${index + 1} (${edit.action}) failed: ${error.message}`)
      throw error
    }
  }
}

const NOT_FOUND = 'There is no deck with that id in this account. Call list_decks to see the decks.'

/** The first heading of a slide, or its first line. */
function titleOf(content: string) {
  const line = content.split('\n').map(item => item.trim()).find(item => item && !item.startsWith('<!--')) ?? ''
  return line.replace(/^#{1,6}\s+/, '').slice(0, 80) || '(empty)'
}

function outline(markdown: string) {
  return splitSlides(markdown).map((slide, index) => `${index + 1}. ${titleOf(slide.content)}`).join('\n')
}

const LEFT_OUT_BECAUSE: Record<LeftOutReason, string> = {
  'too-big': 'larger than that on its own',
  'no-room': 'no room left after the other files',
  'unreadable': 'storage could not read it just now',
}

/** Which project files the images do not show, and why, so Claude does not take them for faults in the slides. */
function leftOutNote(left: LeftOut[]) {
  const files = left.map(file => `- ${file.link}: ${LEFT_OUT_BECAUSE[file.why]}`)
  return [`Media left out of these images (one call carries at most ${MAX_INLINE_MEDIA_BYTES / 1024 / 1024} MB):`, ...files].join('\n')
}

/**
 * The MCP server for one signed in person. Every tool acts as that person
 * through the same store as the web app, so no call reaches another account.
 * `session` tells apart the person's Claude Code sessions (the MCP session
 * id), so each one's writes merge with what that session read.
 */
export function createMcpServer(userId: string, { decks, renderer, media, version }: McpDependencies, session?: string) {
  const server = new McpServer({ name: 'deyslide', title: 'Deyslide', version }, { instructions: MCP_INSTRUCTIONS })
  const reader = { userId, session }

  async function deckOrNull(deckId: string, options: { remember?: boolean } = {}) {
    const found = await decks.find(userId, deckId)
    const markdown = found && await decks.read(reader, deckId, options)
    return found && markdown !== undefined ? { ...found, markdown } : undefined
  }

  server.registerTool('get_guide', {
    title: 'Deyslide writing guide',
    description: 'How to write Deyslide slides: the workflow, Slidev Markdown syntax, layouts, click animations, Magic Move code, Deyslide components and design rules. Read it once before writing slides.',
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async () => text(MCP_GUIDE))

  server.registerTool('list_decks', {
    title: 'List projects and decks',
    description: 'Lists the person\'s projects and the decks in each, then projects and decks other people shared with them and the role they have. Includes deck ids, slide counts and editor links.',
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async () => {
    const projects = (await decks.list(userId)).map(project => ({
      id: project.id,
      name: project.name,
      decks: project.decks.map(deck => ({
        id: deck.id,
        name: deck.name,
        slideCount: deck.slideCount,
        updatedAt: new Date(deck.updatedAt).toISOString(),
        editorUrl: decks.editorUrl(project.id, deck.id),
      })),
    }))
    const shared = (await decks.shared(userId)).map(project => ({
      id: project.id,
      name: project.name,
      owner: project.owner,
      role: project.role,
      decks: project.decks.map(deck => ({
        id: deck.id,
        name: deck.name,
        slideCount: deck.slideCount,
        updatedAt: new Date(deck.updatedAt).toISOString(),
        role: deck.role,
        editorUrl: decks.editorUrl(project.id, deck.id),
      })),
    }))
    if (projects.length === 0 && shared.length === 0)
      return text('This account has no projects yet. Create one with create_project.', { projects, shared })
    const lines = projects.flatMap(project => [
      `Project "${project.name}" (id ${project.id})`,
      ...(project.decks.length
        ? project.decks.map(deck => `  - Deck "${deck.name}" (id ${deck.id}), ${deck.slideCount} slides, ${deck.editorUrl}`)
        : ['  (no decks)']),
    ])
    if (shared.length) {
      lines.push('', 'Shared with you:')
      for (const project of shared) {
        lines.push(`Project "${project.name}" (id ${project.id}) by ${project.owner.name}${project.role ? `, you are ${project.role === 'editor' ? 'an editor' : 'a viewer'}` : ', some decks only'}`)
        lines.push(...project.decks.map(deck => `  - Deck "${deck.name}" (id ${deck.id}), ${deck.slideCount} slides, ${deck.role === 'editor' ? 'you can edit' : 'view only'}, ${deck.editorUrl}`))
      }
    }
    return text(lines.join('\n'), { projects, shared })
  })

  server.registerTool('create_project', {
    title: 'Create a project',
    description: 'Creates a project, a folder for decks. Returns its id for create_deck.',
    inputSchema: { name: NameSchema.describe('Project name, up to 80 characters.') },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, async ({ name }) => {
    const project = await decks.createProject(userId, name)
    return text(`Created the project "${project.name}" with id ${project.id}.`, { project: { id: project.id, name: project.name } })
  })

  server.registerTool('create_deck', {
    title: 'Create a deck',
    description: 'Creates a deck in a project from Slidev Markdown. Without markdown the deck starts with one title slide. Returns the deck id and its editor link.',
    inputSchema: {
      projectId: z.string().min(1).max(100).describe('The project id from list_decks or create_project.'),
      name: NameSchema.describe('Deck name, up to 80 characters.'),
      markdown: z.string().optional().describe('The whole deck as Slidev Markdown. Call get_guide first for the syntax.'),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, async ({ projectId, name, markdown }) => {
    const source = markdown?.trim() ? markdown : `---\ntitle: ${JSON.stringify(name)}\nlayout: cover\n---\n\n# ${name}\n`
    try {
      const deck = await decks.create(reader, projectId, name, source)
      if (!deck)
        return problem('There is no project with that id in this account. Call list_decks, or create_project first.')
      const editorUrl = decks.editorUrl(projectId, deck.id)
      return text(`Created the deck "${deck.name}" with id ${deck.id} and ${deck.slideCount} slides. Open it at ${editorUrl}\n\n${outline(source)}`, {
        deck: { id: deck.id, name: deck.name, slideCount: deck.slideCount, editorUrl },
      })
    }
    catch (error) {
      if (error instanceof DeckInputError || error instanceof ForbiddenError)
        return problem(error.message)
      throw error
    }
  })

  server.registerTool('read_deck', {
    title: 'Read a deck',
    description: 'Returns a deck\'s Slidev Markdown with each slide wrapped in <slide number="N">, plus its editor link.',
    inputSchema: { deckId: DeckId },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async ({ deckId }) => {
    // What Claude sees here is what its next write_deck or edit_slides builds on.
    const found = await deckOrNull(deckId, { remember: true })
    if (!found)
      return problem(NOT_FOUND)
    const draft = new DeckDraft(found.markdown)
    const editorUrl = decks.editorUrl(found.project.id, deckId)
    return text(`Deck "${found.deck.name}" (${draft.count} slides) in project "${found.project.name}". Editor: ${editorUrl}\n\n${draft.numbered()}`, {
      deck: { id: deckId, name: found.deck.name, slideCount: draft.count, editorUrl },
      markdown: found.markdown,
    })
  })

  server.registerTool('write_deck', {
    title: 'Replace a whole deck',
    description: 'Replaces all of a deck\'s Markdown. Use it for a first draft or a full rewrite; edit_slides is safer for a few slides. Call read_deck first: edits people make while you work are then kept. Writing a deck you have not read overwrites them. The first slide\'s frontmatter holds the deck settings.',
    inputSchema: { deckId: DeckId, markdown: z.string().min(1).describe('The whole deck as Slidev Markdown.') },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  }, async ({ deckId, markdown }) => {
    const found = await decks.find(userId, deckId)
    if (!found)
      return problem(NOT_FOUND)
    let written: DeckWrite | undefined
    try {
      written = await decks.write(reader, deckId, markdown)
    }
    catch (error) {
      return notSaved(error)
    }
    if (!written)
      return problem(NOT_FOUND)
    const how = written.replaced
      ? 'Saved. There was no read of this deck to merge with (reads are kept for an hour), so your Markdown replaced the whole deck.'
      : 'Saved, merged with what people changed since you read the deck.'
    return text(`${how} The deck now has these slides:\n${outline(written.markdown)}\n\nCheck them with render_slides.`)
  })

  server.registerTool('edit_slides', {
    title: 'Edit slides',
    description: 'Applies a list of slide edits in order: replace, insert, delete or move. Slide numbers in each edit refer to the deck after the edits before it. Either every edit is saved or none is.',
    inputSchema: { deckId: DeckId, edits: z.array(Edit).min(1).max(50) },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  }, async ({ deckId, edits }) => {
    const found = await decks.find(userId, deckId)
    if (!found)
      return problem(NOT_FOUND)
    let written: DeckWrite | undefined
    try {
      written = await decks.edit(reader, deckId, draft => applyEdits(draft, edits))
    }
    catch (error) {
      return notSaved(error)
    }
    if (!written)
      return problem(NOT_FOUND)
    const saved = `Saved ${edits.length} edit${edits.length === 1 ? '' : 's'}.`
    const how = written.replaced ? ' The deck no longer holds the version you read, so the edited version replaced the whole deck.' : ''
    return text(`${saved}${how} The deck now has these slides:\n${new DeckDraft(written.markdown).outline()}\n\nCheck them with render_slides.`)
  })

  server.registerTool('render_slides', {
    title: 'Render slides to images',
    description: `Draws slides as PNG images with Deyslide's real renderer, so you can see the design. Also reports each slide's click count, content overflow and render errors. At most ${MAX_RENDERED_SLIDES} slides per call.`,
    inputSchema: {
      deckId: DeckId,
      slides: z.array(SlideNumber).min(1).max(MAX_RENDERED_SLIDES).optional().describe(`Slide numbers to draw. Defaults to the first ${MAX_RENDERED_SLIDES}.`),
      click: z.union([z.literal('first'), z.literal('last'), z.number().int().min(0)]).optional().describe('Which click step to show: "last" (default) shows everything, "first" shows the slide before any click, a number shows that step.'),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async ({ deckId, slides, click = 'last' }) => {
    const found = await deckOrNull(deckId)
    if (!found)
      return problem(NOT_FOUND)
    if (!renderer)
      return problem('Slide images are not available on this Deyslide server. Check the Markdown with read_deck instead.')
    const source = splitSlides(found.markdown)
    const numbers = slides ?? source.slice(0, MAX_RENDERED_SLIDES).map((_, index) => index + 1)
    const missing = numbers.filter(number => number > source.length)
    if (missing.length)
      return problem(`The deck has ${source.length} slides, so there is no slide ${missing.join(', ')}.`)
    const clicks = click === 'first' ? 0 : click === 'last' ? 1000 : click
    const drawing = numbers.map(number => ({
      content: source[number - 1].content,
      frontmatter: source[number - 1].frontmatter,
      headmatter: source[0].frontmatter,
      first: number === 1,
      clicks,
    }))
    const draw = (links: Record<string, string>) => renderer.render(drawing, Object.keys(links).length ? { media: links } : undefined)
    let rendered: RenderedSlide[]
    let left: LeftOut[] = []
    try {
      // The renderer has no network, so the project media these slides use goes inside the request.
      if (media)
        ({ drawn: rendered, left } = await media.draw(userId, drawing, draw))
      else
        rendered = await draw({})
    }
    catch (error) {
      if (error instanceof MediaBusyError)
        return problem(error.message)
      if (error instanceof RendererUnavailableError)
        return problem(`Slide images are unavailable right now (${error.message}). Try again in a minute.`)
      throw error
    }
    const content: CallToolResult['content'] = []
    for (const [index, result] of rendered.entries()) {
      const details = [
        `${result.clicks} click${result.clicks === 1 ? '' : 's'}`,
        result.overflow ? 'content overflows the slide: shorten it or split it' : 'fits the slide',
        ...(result.error ? [`render error: ${result.error}`] : []),
      ]
      content.push({ type: 'text', text: `Slide ${numbers[index]}: ${details.join(', ')}.` })
      if (result.png)
        content.push({ type: 'image', data: result.png, mimeType: 'image/png' })
    }
    if (left.length)
      content.push({ type: 'text', text: leftOutNote(left) })
    const more = source.length > numbers.length && !slides ? `\n\nThe deck has ${source.length} slides. Ask for the others by number.` : ''
    content.push({ type: 'text', text: `Editor: ${decks.editorUrl(found.project.id, deckId)}${more}` })
    return {
      content,
      structuredContent: { slides: rendered.map((result, index) => ({ number: numbers[index], clicks: result.clicks, overflow: result.overflow, error: result.error ?? null })) },
    }
  })

  return server
}
