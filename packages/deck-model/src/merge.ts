import * as Y from 'yjs'
import { parseMarkdown } from './markdown.ts'
import { applyDeck } from './reconcile.ts'
import { DeckNotLoadedError, slidesOf } from './y-shape.ts'

// Merging Markdown written against an older state of the deck.
//
// The Markdown is applied to a fork: a document holding only the older state
// (`base`). Its changes then reach the live document as if another person had
// made them at that moment, so whatever changed in the live document since
// `base` (typing, moves, deletions) survives. A deletion leaves the state
// vector as it was, so comparing state vectors cannot tell whether the live
// document moved on: every merge goes through a fork.

/**
 * One writer of merges (a Markdown binding, a file watcher, a server writer
 * for one deck). Its forks reuse one client id, so a long session adds one
 * entry to the document's state vector instead of one per merge. It must
 * never be the live document's own client id.
 */
export interface MergeWriter {
  clientID: number
}

export function newMergeWriter(): MergeWriter {
  return { clientID: crypto.getRandomValues(new Uint32Array(1))[0] }
}

export interface MergeOptions {
  writer?: MergeWriter
}

export interface MergeResult {
  /** The state the merged Markdown corresponds to. A writer that builds its next text on this one keeps it as its next base. */
  textBase: Uint8Array
  /** The live document's state after the merge, for a writer that now shows the live deck. */
  liveState: Uint8Array
  /** True when `base` was not part of the live document, so the Markdown replaced the deck instead of merging. */
  fallback: boolean
}

interface Fork {
  doc: Y.Doc
  /** The state vector of `base`: what the live document has already seen. */
  baseVector: Uint8Array
}

/**
 * A document holding `base`, or undefined when the live document lacks some
 * of `base` (say a room reloaded from an older store), so it cannot be merged.
 * Throws `DeckNotLoadedError` when `base` holds no deck (it was taken before
 * the deck loaded): Markdown written on it has nothing to merge with.
 */
function forkOf(live: Y.Doc, base: Uint8Array, writer?: MergeWriter): Fork | undefined {
  const baseVector = Y.encodeStateVectorFromUpdate(base)
  for (const [client, clock] of Y.decodeStateVector(baseVector)) {
    if (Y.getState(live.store, client) < clock)
      return undefined
  }
  const doc = new Y.Doc({ gc: false })
  Y.applyUpdate(doc, base)
  if (!slidesOf(doc)) {
    doc.destroy()
    throw new DeckNotLoadedError()
  }
  // Set after the base is in, or Yjs would pick a new id on seeing it in the
  // base. The writer continues its own clock only when the live document has
  // nothing newer from it.
  if (writer && Y.getState(doc.store, writer.clientID) === Y.getState(live.store, writer.clientID))
    doc.clientID = writer.clientID
  return { doc, baseVector }
}

/**
 * Applies the fork's change to the live document. The change only builds on
 * `base`, which the live document holds, so it never waits for missing
 * content. A live document that already waits for an update it has not
 * received yet (from another peer) keeps waiting; only a wait this change
 * starts would be a bug, and throws.
 */
function push(live: Y.Doc, update: Uint8Array, origin: unknown) {
  const pendingBefore = live.store.pendingStructs
  Y.applyUpdate(live, update, origin)
  if (pendingBefore === null && live.store.pendingStructs !== null)
    throw new Error('The merged change refers to content the live document does not have')
}

/**
 * Merges Markdown written against `base` (an encoded state the live document
 * already contains) into `live`, with `origin` as the transaction origin.
 * Throws `DeckMarkdownError` first, without touching anything, when the
 * Markdown cannot be read. When `base` is not part of `live`, the Markdown
 * is applied directly instead, and the result says `fallback: true`. Throws
 * `DeckNotLoadedError`, changing nothing, when `base` or `live` holds no deck.
 */
export function mergeMarkdown(live: Y.Doc, base: Uint8Array, markdown: string, origin?: unknown, options: MergeOptions = {}): MergeResult {
  const parsed = parseMarkdown(markdown)
  if (options.writer?.clientID === live.clientID)
    throw new Error('A merge writer cannot use the client id of the document it merges into')
  const fork = forkOf(live, base, options.writer)
  if (!fork) {
    applyDeck(live, parsed, origin)
    const state = Y.encodeStateAsUpdate(live)
    return { textBase: state, liveState: state, fallback: true }
  }
  try {
    applyDeck(fork.doc, parsed, origin)
    push(live, Y.encodeStateAsUpdate(fork.doc, fork.baseVector), origin)
    return { textBase: Y.encodeStateAsUpdate(fork.doc), liveState: Y.encodeStateAsUpdate(live), fallback: false }
  }
  finally {
    fork.doc.destroy()
  }
}

/** One fork kept for a writer that sends several versions of the deck in a row. */
export interface MarkdownFork {
  /**
   * Merges the next version of the Markdown, which builds on `base` and on
   * every version applied before it. Only what changed since the last call
   * reaches the live document.
   */
  apply: (markdown: string) => void
  /** The state the last applied Markdown corresponds to. */
  textBase: () => Uint8Array
  /** True when `base` was not part of the live document, so each version replaces the deck directly. */
  readonly fallback: boolean
}

/**
 * A fork for a writer that streams cumulative versions of the deck, like the
 * assistant's reply: every version is a whole deck built on `base`. Applying
 * each one to its own fresh fork would insert a new slide once per version.
 * Throws `DeckNotLoadedError` when `base` holds no deck.
 */
export function forkMarkdown(live: Y.Doc, base: Uint8Array, origin?: unknown): MarkdownFork {
  const fork = forkOf(live, base)
  let pushed = fork?.baseVector
  return {
    fallback: !fork,
    apply(markdown) {
      const parsed = parseMarkdown(markdown)
      if (!fork) {
        applyDeck(live, parsed, origin)
        return
      }
      applyDeck(fork.doc, parsed, origin)
      push(live, Y.encodeStateAsUpdate(fork.doc, pushed), origin)
      pushed = Y.encodeStateVector(fork.doc)
    },
    textBase: () => Y.encodeStateAsUpdate(fork?.doc ?? live),
  }
}
