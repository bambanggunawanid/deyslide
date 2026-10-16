import type { DeckSession, OpenDeckOptions } from '../../apps/web/src/deck/session'
import type { MarkdownBinding } from '../../apps/web/src/editor/markdown-sync'
import type { ProjectStore } from '../../apps/web/src/projects/types'
import type { TextChange } from '../../packages/deck-model/src'
import type { FakeProjectApi } from './project-api'
import { expect, vi } from 'vitest'
import * as Y from 'yjs'
import { applyMarkdown, deckToYDoc, fromMarkdown, joinSlides, slideMarkdowns } from '../../packages/deck-model/src'

/** Adds a deck with this Markdown to the person's account on the fake API. */
export async function accountDeck(api: FakeProjectApi, markdown: string, name = 'Sorting') {
  const project = await api.createProject('Talks')
  const deck = await api.createDeck(project.id, name, Y.encodeStateAsUpdate(deckToYDoc(fromMarkdown(markdown))))
  return { projectId: project.id, deckId: deck.id }
}

/** Opens a deck and waits until the session holds it. */
export async function openReady(store: ProjectStore, projectId: string, deckId: string, options?: OpenDeckOptions) {
  const session = await store.openDeck(projectId, deckId, options)
  await vi.waitFor(() => expect(session.ready.value).toBe(true))
  return session
}

/** Says who a session's person is in presence, as the deck page does. */
export function introduce(session: DeckSession, id: string, name: string) {
  session.awareness.setLocalStateField('user', { id, name, color: '#46a758' })
}

/** Each slide's Markdown in a live document. */
export const slidesOf = (doc: Y.Doc) => slideMarkdowns(doc).map(slide => slide.markdown)

/** Replaces one slide's Markdown (counted from 1) in a session's deck, as someone editing it would. */
export function changeSlide(session: DeckSession, number: number, change: (markdown: string) => string) {
  const slides = slidesOf(session.doc)
  slides[number - 1] = change(slides[number - 1])
  // Only what differs changes, like any other client.
  session.transact(() => applyMarkdown(session.doc, joinSlides(slides)))
}

/** Makes a session's deck hold these slides, changing only what differs. */
export function setSlides(session: DeckSession, slides: string[]) {
  session.transact(() => applyMarkdown(session.doc, joinSlides(slides)))
}

/** Maps a position through edits the way CodeMirror maps a cursor: an insertion at the cursor goes after it. */
export function mapPosition(position: number, changes: TextChange[]) {
  let shift = 0
  for (const change of changes) {
    if (change.to <= position && !(change.from === change.to && change.from === position))
      shift += change.insert.length - (change.to - change.from)
    else if (change.from < position)
      return change.from + shift
  }
  return position + shift
}

/** Applies edits that refer to the text before any of them. */
function applyEdits(text: string, changes: TextChange[]) {
  let result = ''
  let position = 0
  for (const change of changes) {
    result += text.slice(position, change.from) + change.insert
    position = change.to
  }
  return result + text.slice(position)
}

/**
 * Stands in for CodeMirror around a Markdown binding: it holds the text and
 * a cursor, sends typing to the binding, and applies the binding's edits,
 * mapping the cursor through them.
 */
export class EditorModel {
  text: string
  cursor = 0
  /** Every set of edits the binding sent, in order. */
  readonly patches: { before: string, changes: TextChange[] }[] = []
  private readonly stop: () => void

  constructor(readonly binding: MarkdownBinding) {
    this.text = binding.text.value
    this.stop = binding.onPatch((changes) => {
      this.patches.push({ before: this.text, changes })
      this.text = applyEdits(this.text, changes)
      this.cursor = mapPosition(this.cursor, changes)
    })
  }

  /** Puts the cursor right after the first `marker` at or after `from`. */
  placeAfter(marker: string, from = 0) {
    const at = this.text.indexOf(marker, from)
    expect(at).toBeGreaterThanOrEqual(0)
    this.cursor = at + marker.length
  }

  /** Types `insert` in place of the first `search`, as keystrokes would. */
  replace(search: string, insert: string) {
    const from = this.text.indexOf(search)
    expect(from).toBeGreaterThanOrEqual(0)
    this.edit({ from, to: from + search.length, insert })
  }

  edit(change: TextChange) {
    this.text = applyEdits(this.text, [change])
    this.cursor = change.from + change.insert.length
    this.binding.applyLocalChanges([change])
    expect(this.binding.text.value).toBe(this.text)
  }

  /** The text from the cursor on, to see where it is. */
  afterCursor(length = 12) {
    return this.text.slice(this.cursor, this.cursor + length)
  }

  close() {
    this.stop()
  }
}
