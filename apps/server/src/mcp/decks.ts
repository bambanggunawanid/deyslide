import type { DeckSummary, Project, ProjectStore } from '../projects.ts'
import { deckToYDoc, fromMarkdown, frontmatterErrors, toMarkdown, yDocToDeck } from '@deyslide/deck-model'
import * as Y from 'yjs'
import { MARKDOWN_MAX_LENGTH } from '../assistant/draft.ts'

/** A problem an agent can fix. The message says what went wrong and how to fix it. */
export class DeckInputError extends Error {}

/** Checks Markdown before it is saved: size, frontmatter YAML and the deck format. */
export function checkMarkdown(markdown: string) {
  if (markdown.length > MARKDOWN_MAX_LENGTH)
    throw new DeckInputError(`The deck is ${markdown.length} characters long. The limit is ${MARKDOWN_MAX_LENGTH}. Split it into several decks.`)
  const problems = frontmatterErrors(markdown)
  if (problems.length > 0)
    throw new DeckInputError(`The frontmatter is not valid YAML. ${problems.join(' ')}`)
  try {
    return fromMarkdown(markdown)
  }
  catch (error) {
    throw new DeckInputError(`Deyslide cannot read this deck: ${error instanceof Error ? error.message : String(error)}`)
  }
}

function encode(markdown: string) {
  const doc = deckToYDoc(checkMarkdown(markdown))
  try {
    return Y.encodeStateAsUpdate(doc)
  }
  finally {
    doc.destroy()
  }
}

/**
 * Decks as Slidev Markdown, for MCP clients. It goes through the same store
 * as the web app, so every call only reaches the signed in person's decks.
 */
export class MarkdownDecks {
  private readonly projects: ProjectStore
  private readonly publicUrl: string

  constructor(projects: ProjectStore, publicUrl: string) {
    this.projects = projects
    this.publicUrl = publicUrl
  }

  /** Where the deck opens in the web editor. */
  editorUrl(projectId: string, deckId: string) {
    return `${this.publicUrl}/p/${encodeURIComponent(projectId)}/d/${encodeURIComponent(deckId)}`
  }

  list(userId: string): Promise<Project[]> {
    return this.projects.list(userId)
  }

  createProject(userId: string, name: string) {
    return this.projects.createProject(userId, name)
  }

  /** The deck's summary and project, or undefined when it is not the person's. */
  async find(userId: string, deckId: string): Promise<{ project: Project, deck: DeckSummary } | undefined> {
    for (const project of await this.projects.list(userId)) {
      const deck = project.decks.find(item => item.id === deckId)
      if (deck)
        return { project, deck }
    }
    return undefined
  }

  /** The deck's Markdown as people edit it, without internal slide ids. */
  async read(userId: string, deckId: string): Promise<string | undefined> {
    const state = await this.projects.deckState(userId, deckId)
    if (!state)
      return undefined
    const doc = new Y.Doc()
    try {
      Y.applyUpdate(doc, state)
      return toMarkdown(yDocToDeck(doc), { ids: false })
    }
    finally {
      doc.destroy()
    }
  }

  /** Returns false when the deck is not the person's. */
  save(userId: string, deckId: string, markdown: string) {
    return this.projects.saveDeckState(userId, deckId, encode(markdown))
  }

  /** Returns undefined when the project is not the person's. */
  create(userId: string, projectId: string, name: string, markdown: string) {
    return this.projects.createDeck(userId, projectId, name, encode(markdown))
  }
}
