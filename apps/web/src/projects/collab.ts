import type { HocuspocusProvider } from '@hocuspocus/provider'
import type { Ref } from 'vue'
import type { Awareness } from 'y-protocols/awareness'
import type * as Y from 'yjs'
import type { SessionStatus } from '../deck/session'
import { SHAPE_REFUSED, withLiveShape } from '@deyslide/deck-model/shape'
import { ref } from 'vue'

/** A deck's live connection to the server, as the deck session sees it. */
export interface DeckConnection {
  status: Ref<SessionStatus>
  /** True once the deck synced with the server. It stays true while the connection is down afterwards. */
  synced: Ref<boolean>
  /** True until the first sync, for viewers, while access is checked again, and after a failure. */
  readOnly: Ref<boolean>
  error: Ref<string>
  /**
   * True while changes made here wait for the server: sent and not
   * confirmed yet, or made while the connection was down. Nothing that
   * can never be saved (a failure, a viewer) counts.
   */
  unsaved: Ref<boolean>
  /**
   * Why the connection stopped for good, once it failed: the server refused
   * the deck for good (`refused`: access removed, the deck deleted), turned
   * down changes made here (`turned-down`: view only now, too big), or the
   * sign in ended (`signed-out`).
   */
  failure: Ref<DeckFailure | undefined>
  /** Waits until the server has every change so far, or the connection is down. */
  flush: () => Promise<void>
  destroy: () => void
}

/** What kind of failure stopped a connection. See `DeckConnection.failure`. */
export type DeckFailure = 'refused' | 'turned-down' | 'signed-out' | 'outdated'

/** Why a connection stopped for good, as the page says it. */
export const NO_ACCESS = 'You no longer have access to this deck.'
export const SIGNED_OUT = 'Your sign in ended. Sign in again to save your changes.'
export const TOO_BIG = 'This deck is too big to save. Remove some content.'
/** The server holds the deck in a shape this code does not read and write: the page or the app is out of date. */
export const UPDATE_REQUIRED = 'Deyslide was updated. Reload the page, or update the app, to keep editing this deck.'
/** The server turned down a change because the person may only view the deck now. */
export const VIEW_ONLY_NOW = 'You can only view this deck now. Reload the page to see it as it is.'

/** Close codes the server sends. Access changed: the client joins again and is checked again. */
const ACCESS_CHANGED_CODE = 4001
/**
 * Why the server refused to let the page in (see REFUSALS on the server).
 * Anything else, `permission-denied` included, is a refusal for good.
 */
const SIGNED_OUT_REASON = 'signed-out'
const TRY_AGAIN_REASON = 'try-again'
/** How long to wait before joining again after the server could not check access, at first and at most. */
const AUTH_RETRY_MS = 2000
const AUTH_RETRY_MAX_MS = 30_000
/** The deck grew too big to save. */
const TOO_BIG_CODE = 4002
/** How long `flush` waits for the server before giving up for now. */
const FLUSH_TIMEOUT_MS = 5000
/** The kind of message that says whether the server took a change, and the value for "no". */
const SYNC_STATUS_MESSAGE = 8
const REFUSED = 0
/** How long to wait before loading the live editing code again after it failed to load, at first and at most. */
const LOAD_RETRY_MS = 1000
const LOAD_RETRY_MAX_MS = 30_000

/** The live editing address on the page's own server: wss on https, ws on http. */
export function collabUrl(location: { protocol: string, host: string } = window.location) {
  return `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/collab`
}

export interface LiveDeckOptions {
  url: string
  deckId: string
  doc: Y.Doc
  awareness: Awareness
  /** Called on every connect, so a fresh token goes with each one. */
  token: () => Promise<string>
  /** A WebSocket class for places without one, such as Node. */
  WebSocketPolyfill?: unknown
}

/** Joins a deck's live room with Hocuspocus. */
export function connectLiveDeck({ url, deckId, doc, awareness, token, WebSocketPolyfill }: LiveDeckOptions): DeckConnection {
  const status = ref<SessionStatus>('connecting')
  const synced = ref(false)
  const readOnly = ref(true)
  const error = ref('')
  const unsaved = ref(false)
  const failure = ref<DeckFailure>()
  /** Synced with the room since the socket last opened. */
  let live = false
  /** The connection dropped or never came up, so the page is offline. */
  let lost = false
  /** Access changed: the room is joined again with what the person may do now. */
  let rejoining = false
  let viewer = false
  let failed = false
  let unsynced = 0
  const waiting = new Set<() => void>()

  let provider: HocuspocusProvider | undefined
  let destroyed = false
  let retry: ReturnType<typeof setTimeout> | undefined
  let authRetry: ReturnType<typeof setTimeout> | undefined
  let authRetryMs = AUTH_RETRY_MS

  function update() {
    if (failed) {
      status.value = 'failed'
      readOnly.value = true
    }
    else {
      readOnly.value = !synced.value || viewer || rejoining
      if (!live)
        status.value = lost && !rejoining ? 'offline' : 'connecting'
      else
        status.value = unsynced > 0 && !viewer ? 'saving' : 'saved'
    }
    // Only after the first sync: before it the page changed nothing.
    unsaved.value = synced.value && !failed && !viewer && unsynced > 0
    if (failed || !live || viewer || unsynced === 0) {
      for (const done of [...waiting])
        done()
    }
  }

  function fail(message: string, kind: DeckFailure) {
    failed = true
    failure.value = kind
    error.value = message
    live = false
    provider?.disconnect()
    update()
  }

  function listen(room: HocuspocusProvider) {
    room.on('authenticated', ({ scope }: { scope: string }) => {
      viewer = scope === 'readonly'
      authRetryMs = AUTH_RETRY_MS
      update()
    })
    room.on('authenticationFailed', ({ reason }: { reason?: string }) => {
      if (reason === SHAPE_REFUSED)
        return fail(UPDATE_REQUIRED, 'outdated')
      if (reason === TRY_AGAIN_REASON)
        return tryAgainLater()
      if (reason === SIGNED_OUT_REASON)
        return fail(SIGNED_OUT, 'signed-out')
      fail(NO_ACCESS, 'refused')
    })
    room.on('synced', ({ state }: { state: boolean }) => {
      if (!state || failed)
        return
      live = true
      synced.value = true
      rejoining = false
      update()
    })
    room.on('unsyncedChanges', ({ number }: { number: number }) => {
      unsynced = number
      update()
    })
    // A viewer's change is turned down, not saved: the page now holds what the deck does not.
    room.on('message', ({ message }: { message: { readVarString: () => string, readVarUint: () => number } }) => {
      try {
        message.readVarString()
        if (message.readVarUint() === SYNC_STATUS_MESSAGE && message.readVarUint() === REFUSED)
          fail(VIEW_ONLY_NOW, 'turned-down')
      }
      catch {
        // Not a message this page reads.
      }
    })
    room.on('close', ({ event }: { event?: { code?: number } }) => {
      if (failed)
        return
      live = false
      if (event?.code === TOO_BIG_CODE)
        return fail(TOO_BIG, 'turned-down')
      if (event?.code === ACCESS_CHANGED_CODE)
        rejoining = true
      else
        lost = true
      update()
    })
  }

  /**
   * A fresh token for each connect. Without one (no network to refresh it,
   * say) the page is offline, not refused: the socket closes, and the
   * provider connects again a little later and asks once more.
   */
  async function connectToken() {
    try {
      return await token()
    }
    catch {
      lost = true
      update()
      provider?.configuration.websocketProvider.webSocket?.close()
      return new Promise<string>(() => {})
    }
  }

  /**
   * The server could not check access just now: nothing was refused, so the
   * page keeps what it has and joins again a little later, waiting longer
   * each time.
   */
  function tryAgainLater() {
    live = false
    rejoining = false
    provider?.disconnect()
    update()
    clearTimeout(authRetry)
    authRetry = setTimeout(() => {
      if (!destroyed && !failed)
        void provider?.connect()
    }, authRetryMs)
    authRetryMs = Math.min(authRetryMs * 2, AUTH_RETRY_MAX_MS)
  }

  /**
   * Back online: the provider waits longer after each failed attempt, up to
   * half a minute, so it tries again at once instead.
   */
  function reconnectNow() {
    if (!destroyed && !failed && !live)
      void provider?.connect()
  }

  // The provider loads with the first open deck, not with the app.
  function load(delay: number) {
    void import('@hocuspocus/provider').then(({ HocuspocusProvider }) => {
      if (destroyed)
        return
      provider = new HocuspocusProvider({
        // The server turns away code that reads the deck in another shape.
        url: withLiveShape(url),
        name: `deck:${deckId}`,
        document: doc,
        awareness,
        token: connectToken,
        ...(WebSocketPolyfill ? { WebSocketPolyfill } : {}),
      })
      listen(provider)
      if (typeof window !== 'undefined')
        window.addEventListener('online', reconnectNow)
    }, () => {
      if (destroyed)
        return
      // Offline before the code arrived: try again, less often each time.
      lost = true
      update()
      retry = setTimeout(() => load(Math.min(delay * 2, LOAD_RETRY_MAX_MS)), delay)
    })
  }
  load(LOAD_RETRY_MS)

  return {
    status,
    synced,
    readOnly,
    error,
    unsaved,
    failure,
    flush() {
      provider?.flushPendingUpdates()
      if (failed || !live || viewer || unsynced === 0)
        return Promise.resolve()
      return new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(timer)
          waiting.delete(done)
          resolve()
        }
        const timer = setTimeout(done, FLUSH_TIMEOUT_MS)
        waiting.add(done)
      })
    },
    destroy() {
      destroyed = true
      clearTimeout(retry)
      clearTimeout(authRetry)
      if (typeof window !== 'undefined')
        window.removeEventListener('online', reconnectNow)
      for (const done of [...waiting])
        done()
      provider?.destroy()
    },
  }
}
