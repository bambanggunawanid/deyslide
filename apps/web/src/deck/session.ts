import type { InjectionKey, Ref } from 'vue'
import type { Awareness } from 'y-protocols/awareness'
import { computed, shallowRef } from 'vue'
import * as Y from 'yjs'

// A deck while it is open: one live document that every view of the page
// (canvas, Markdown, assistant, preview) reads and changes, plus what the
// page shows about it: whether it is saved, who else is here, and one undo
// history for everything the person did.

/** Canvas and other edits made in the page's own controls. */
export const LOCAL_ORIGIN: unique symbol = Symbol('local')
/** Loads and merges from a file or a store. Never undoable. */
export const EXTERNAL_ORIGIN: unique symbol = Symbol('external')
/** The assistant's changes. Only the assistant's own undo history tracks them. */
export const ASSISTANT_ORIGIN: unique symbol = Symbol('assistant')

/**
 * The origin of one Markdown view's merges. Each binding has its own
 * instance, so it can tell its merges from everyone else's changes, while
 * the session's undo history tracks the class and so all of them.
 */
export class MarkdownOrigin {}

export type SessionStatus = 'connecting' | 'saved' | 'saving' | 'offline' | 'failed'

/**
 * What the page says for each status. A failure also says why: show
 * `statusLabel(status, error)` rather than this label alone.
 */
export const STATUS_LABEL: Record<SessionStatus, string> = {
  connecting: 'Connecting...',
  saving: 'Saving...',
  saved: 'Saved',
  offline: 'Offline. Changes sync when you are back online.',
  failed: 'Not saved',
}

/** The status as the page says it. A failure says why: "Not saved: <error>". */
export function statusLabel(status: SessionStatus, error: string): string {
  return status === 'failed' && error ? `${STATUS_LABEL.failed}: ${error}` : STATUS_LABEL[status]
}

/** Someone else with the deck open, from their presence. */
export interface Peer {
  clientId: number
  user: { id: string, name: string, color: string }
  view?: 'design' | 'markdown' | 'present'
  slideId?: string
  selection?: string[]
  pointer?: { x: number, y: number } | null
}

/** What a Markdown view tells the session about its typing, next to its flush. */
export interface TypingState {
  /** True from a keystroke until the typing is in the deck, and while a problem in the Markdown holds it back. */
  pending: Readonly<Ref<boolean>>
  /** Drops typing the deck could not take, so the editor shows the deck again. */
  revert: () => void
}

export interface DeckSession {
  doc: Y.Doc
  /** Presence. Only on this page for decks in the browser or on the device. */
  awareness: Awareness
  /** True until the first sync (cloud) or load (guest, device), for viewers, and after a failure. */
  readOnly: Readonly<Ref<boolean>>
  /** The document holds the deck. */
  ready: Readonly<Ref<boolean>>
  /** The store's status, and `saving` while a Markdown view waits to merge typing into a saved deck. */
  status: Readonly<Ref<SessionStatus>>
  /** True while a Markdown view has typing the deck does not have yet, also when a problem in the Markdown holds it back. */
  typingPending: Readonly<Ref<boolean>>
  error: Readonly<Ref<string>>
  peers: Readonly<Ref<Peer[]>>
  /**
   * Tracks LOCAL_ORIGIN, every MarkdownOrigin and y-codemirror's sync
   * origins. Never ASSISTANT_ORIGIN: the assistant undoes its own replies.
   */
  undo: Y.UndoManager
  /** Runs `fn` as one change with LOCAL_ORIGIN. Does nothing while the session is read only. */
  transact: (fn: () => void) => void
  /** Groups everything until end() into one undo step (drags). */
  group: () => { end: () => void }
  /**
   * Flushes pending Markdown typing first, then undoes. Typing the deck
   * cannot take yet (the Markdown has a problem) is what the first undo
   * removes, so the deck is left as it is.
   */
  undoStep: () => void
  /** Flushes pending Markdown typing first, then redoes. Does nothing while typing is held back. */
  redoStep: () => void
  /**
   * The Markdown binding registers its synchronous flush here, with what
   * it holds. Returns a function that removes it.
   */
  registerFlush: (fn: () => void, typing?: TypingState) => () => void
  /** Merges pending typing, then waits until the store has the changes (or gives up for now). */
  flush: () => Promise<void>
  close: () => void
}

export interface OpenDeckOptions {
  readOnly?: boolean
}

/** The deck page provides its open session, so editors inside it can undo and redo through it. */
export const DECK_SESSION_KEY: InjectionKey<Readonly<Ref<DeckSession | undefined>>> = Symbol('deck-session')

/** How long typing or a drag keeps adding to the same undo step. */
export const CAPTURE_TIMEOUT_MS = 500

/**
 * The document's root map (`DECK_KEY` in the deck model). Spelled out so the
 * stores, which load the deck model only when a deck is touched, can import
 * this file.
 */
const DECK_ROOT = 'deck'

/** Whether the document received a deck, even a broken one. A document before its first sync or load has none. */
export function holdsDeck(doc: Y.Doc) {
  const root = doc.getMap<unknown>(DECK_ROOT)
  return root.has('slides') || root.has('version')
}

/** Where an open deck lives: the browser, the device or the server. Each store provides one. */
export interface SessionSource {
  status: Readonly<Ref<SessionStatus>>
  error: Readonly<Ref<string>>
  /** The document holds the deck. */
  ready: Readonly<Ref<boolean>>
  /** Changes would not be kept: not synced yet, a viewer, or a failure. */
  readOnly: Readonly<Ref<boolean>>
  /** Waits until the changes so far are stored, as far as the source can tell. */
  flush: () => Promise<void>
  /** Lets go of the document, its presence and any connection. */
  close: () => void
}

/** Who else is here, from presence states. People show up once they say who they are. */
function peersOf(awareness: Awareness): Peer[] {
  const peers: Peer[] = []
  for (const [clientId, state] of awareness.getStates()) {
    const user = state.user as Partial<Peer['user']> | undefined
    if (clientId === awareness.clientID || !user?.id || typeof user.name !== 'string')
      continue
    peers.push({
      clientId,
      user: { id: user.id, name: user.name, color: typeof user.color === 'string' && user.color ? user.color : '#94a3b8' },
      ...(state.view ? { view: state.view } : {}),
      ...(typeof state.slideId === 'string' ? { slideId: state.slideId } : {}),
      ...(Array.isArray(state.selection) ? { selection: state.selection } : {}),
      ...(state.pointer !== undefined ? { pointer: state.pointer } : {}),
    })
  }
  return peers
}

/** A session over a document a store opened. The store's source says how it is kept. */
export function createDeckSession(doc: Y.Doc, awareness: Awareness, source: SessionSource, options: OpenDeckOptions = {}): DeckSession {
  const undo = new Y.UndoManager(doc.getMap(DECK_ROOT), {
    trackedOrigins: new Set<unknown>([LOCAL_ORIGIN, MarkdownOrigin]),
    captureTimeout: CAPTURE_TIMEOUT_MS,
  })
  const readOnly = computed(() => Boolean(options.readOnly) || source.readOnly.value || !source.ready.value)

  const peers = shallowRef<Peer[]>(peersOf(awareness))
  const readPeers = () => {
    peers.value = peersOf(awareness)
  }
  awareness.on('change', readPeers)

  const flushers = new Set<() => void>()
  /** What each Markdown view holds, read reactively for the status. */
  const typing = shallowRef<TypingState[]>([])
  const flushTyping = () => {
    for (const fn of [...flushers])
      fn()
  }
  /** After a flush: typing still held back by a problem in its Markdown. */
  const heldTyping = () => typing.value.filter(state => state.pending.value)

  const typingPending = computed(() => typing.value.some(state => state.pending.value))
  const status = computed<SessionStatus>(() => {
    const stored = source.status.value
    return stored === 'saved' && typingPending.value ? 'saving' : stored
  })

  let groups = 0
  let closed = false

  return {
    doc,
    awareness,
    readOnly,
    ready: source.ready,
    status,
    typingPending,
    error: source.error,
    peers,
    undo,
    transact(fn) {
      if (readOnly.value)
        return
      doc.transact(fn, LOCAL_ORIGIN)
    },
    group() {
      if (groups++ === 0) {
        undo.stopCapturing()
        undo.captureTimeout = Number.POSITIVE_INFINITY
      }
      let ended = false
      return {
        end() {
          if (ended)
            return
          ended = true
          if (--groups === 0) {
            undo.captureTimeout = CAPTURE_TIMEOUT_MS
            undo.stopCapturing()
          }
        },
      }
    },
    undoStep() {
      flushTyping()
      const held = heldTyping()
      if (held.length > 0) {
        // The person sees that typing, not the deck's last change: undo it first.
        for (const state of held)
          state.revert()
        return
      }
      if (!readOnly.value)
        undo.undo()
    },
    redoStep() {
      flushTyping()
      // New typing ends what redo could bring back, as in any editor.
      if (heldTyping().length === 0 && !readOnly.value)
        undo.redo()
    },
    registerFlush(fn, state) {
      flushers.add(fn)
      if (state)
        typing.value = [...typing.value, state]
      return () => {
        flushers.delete(fn)
        if (state)
          typing.value = typing.value.filter(item => item !== state)
      }
    },
    flush() {
      // Typing merges right away, before anything waits.
      flushTyping()
      return source.flush()
    },
    close() {
      if (closed)
        return
      closed = true
      flushTyping()
      flushers.clear()
      typing.value = []
      awareness.off('change', readPeers)
      undo.destroy()
      source.close()
    },
  }
}
