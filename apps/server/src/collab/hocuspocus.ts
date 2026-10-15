import type { Connection, Document } from '@hocuspocus/server'
import type { Auth } from '../auth.ts'
import type { Role } from '../db.ts'
import type { ProjectStore } from '../projects.ts'
import { Buffer } from 'node:buffer'
import { applyDeck, checkDeckDoc, DECK_KEY, readDeckDoc, repairDeckDoc } from '@deyslide/deck-model'
import { Hocuspocus, shouldSkipStoreHooks } from '@hocuspocus/server'
import * as Y from 'yjs'
import { verifyAccessToken } from '../access-token.ts'
import { apiUrl } from '../auth.ts'
import { atLeast } from '../projects.ts'
import { overLimit, TOO_BIG } from './limits.ts'
import { ACCESS_CHANGED, closeConnection, closeRoom, deckIdOf } from './rooms.ts'

// Live editing: one Hocuspocus room per open deck, named `deck:<deckId>`.
// People join over a WebSocket (see attach.ts); server writers such as the
// MCP tools join through direct connections (see documents.ts), so every
// change goes through the same live document and reaches everyone at once.

/** The token browsers send: they sign in with their session cookie instead. */
export const COOKIE_TOKEN = 'cookie'

/** Who a connection acts for. */
export interface CollabContext {
  userId: string
  /** Shown to others in presence. Server writers have none. */
  name?: string
  role?: Role
  /** When the sign in a WebSocket connection joined with ends, in milliseconds. Server writers have none. */
  signedInUntil?: number
  /** Whether that sign in is a session cookie, which signing out ends early. */
  cookie?: boolean
}

/**
 * Refuses a connection. It reads the same whether the deck is missing, not
 * shared with the person or their sign in failed, and Hocuspocus logs no
 * message for it.
 */
class NoAccess extends Error {
  readonly reason = 'permission-denied'
}

/** A room was opened for a deck that no longer exists. */
export class DeckGoneError extends Error {
  constructor() {
    super('This deck no longer exists')
  }
}

/** Colors for people in presence, picked by account so a person keeps theirs. */
const PRESENCE_COLORS = ['#e5484d', '#f76b15', '#d6a10a', '#46a758', '#12a594', '#0090ff', '#8e4ec6', '#d6409f']

export function presenceColor(userId: string) {
  let hash = 0
  for (const char of userId)
    hash = (hash * 31 + char.codePointAt(0)!) >>> 0
  return PRESENCE_COLORS[hash % PRESENCE_COLORS.length]
}

/** How long after a change the room checks its deck, at most once in that time. */
export const CHECK_DELAY_MS = 1000

/** How often an open connection checks that the session it joined with still holds. */
export const SIGN_IN_CHECK_MS = 5 * 60 * 1000

/** Why a room's last save did not go through. */
export type StoreProblem = 'too-big' | 'failed'

const storeProblems = new WeakMap<Y.Doc, StoreProblem>()

/**
 * Why the room's last save did not go through, or undefined when it did. A
 * deck too big to save is never saved; a failed save is tried again.
 */
export function storeProblem(document: Y.Doc): StoreProblem | undefined {
  return storeProblems.get(document)
}

/** Whether a document holds a deck at all, even a broken one. */
function holdsDeck(doc: Y.Doc) {
  const root = doc.getMap<unknown>(DECK_KEY)
  return root.has('slides') || root.has('version')
}

/** When an access token expires, in milliseconds. The token was verified before. */
function tokenExpiry(token: string) {
  try {
    const { exp } = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8')) as { exp?: unknown }
    return typeof exp === 'number' ? exp * 1000 : Number.POSITIVE_INFINITY
  }
  catch {
    return Number.POSITIVE_INFINITY
  }
}

export interface CollabDependencies {
  auth: Auth
  projects: ProjectStore
  /** The site's address. Browsers must open the socket from a page there. */
  publicUrl: string
  /** How often open connections check their session. Tests make it short. */
  signInCheckMs?: number
}

/** The Hocuspocus instance behind live editing, with Deyslide's access rules, loading and saving. */
export function createCollab({ auth, projects, publicUrl, signInCheckMs = SIGN_IN_CHECK_MS }: CollabDependencies): Hocuspocus<CollabContext> {
  const audience = apiUrl({ publicUrl })
  /** Rooms with changes since they loaded or last saved. */
  const unsaved = new WeakSet<Document>()
  const checks = new Map<string, ReturnType<typeof setTimeout>>()
  /** Per room, the person who first showed presence under each client id. */
  const presenceOwners = new WeakMap<Document, Map<number, string>>()
  /** The one client id a connection may show presence under. */
  const presenceIds = new WeakMap<Connection, number>()

  /** The person a session cookie belongs to now, without extending the session. */
  async function sessionPerson(headers: Headers) {
    const session = await auth.api.getSession({ headers, query: { disableRefresh: true } })
    return session ? { id: session.user.id, name: session.user.name, until: new Date(session.session.expiresAt).getTime(), cookie: true } : undefined
  }

  async function personOf(token: string, headers: Headers): Promise<{ id: string, name: string, until: number, cookie: boolean } | undefined> {
    if (token === COOKIE_TOKEN) {
      // A browser sends the cookie whichever page opens the socket, so only
      // Deyslide's own pages may use it.
      if (headers.get('origin') !== publicUrl)
        return undefined
      return sessionPerson(headers)
    }
    // The apps send an access token for the API.
    const userId = await verifyAccessToken(auth, { publicUrl }, token, audience)
    const user = userId && await (await auth.$context).internalAdapter.findUserById(userId)
    return user ? { id: user.id, name: user.name, until: tokenExpiry(token), cookie: false } : undefined
  }

  /**
   * Lets a connection go once the sign in it joined with ends: the token or
   * session expires, or the person signs out. A client that is still signed
   * in joins again at once, with a fresh token.
   */
  function watchSignIn(connection: Connection<CollabContext>, context: CollabContext) {
    if (context.signedInUntil === undefined)
      return
    let timer: ReturnType<typeof setTimeout> | undefined
    let open = true
    connection.onClose(() => {
      open = false
      clearTimeout(timer)
    })
    const later = () => {
      timer = setTimeout(check, Math.max(0, Math.min(context.signedInUntil! - Date.now(), signInCheckMs)))
      timer.unref?.()
    }
    async function check() {
      if (context.cookie) {
        try {
          const person = await sessionPerson(connection.request.headers)
          context.signedInUntil = person?.id === context.userId ? person.until : 0
        }
        catch (error) {
          // The session could not be read just now. It is read again later.
          console.error('Could not check the session of a live editing connection', error)
        }
      }
      if (!open)
        return
      if (context.signedInUntil! <= Date.now())
        closeConnection(connection, ACCESS_CHANGED)
      else
        later()
    }
    later()
  }

  /**
   * A room whose whole deck is gone (a page cleared it) gets the deck back
   * as it was last saved, so every client keeps seeing a deck.
   */
  async function restore(document: Document, deckId: string, origin: unknown) {
    const state = await projects.storedState(deckId)
    if (!state || document.isDestroyed || holdsDeck(document))
      return
    const saved = new Y.Doc()
    try {
      Y.applyUpdate(saved, state)
      applyDeck(document, readDeckDoc(saved), origin, { create: true })
    }
    finally {
      saved.destroy()
    }
  }

  /**
   * Edits that are each fine can add up to a deck that is not valid, like
   * two people deleting the last two slides. The repair reaches everyone in
   * the room. Returns whether the room holds a deck afterwards, which it
   * does unless the deck was deleted.
   */
  async function repair(document: Document, deckId: string, origin: unknown) {
    if (!holdsDeck(document))
      await restore(document, deckId, origin)
    if (!holdsDeck(document))
      return false
    if (!checkDeckDoc(document).ok)
      repairDeckDoc(document, origin)
    return true
  }

  /** Repairs the deck soon after a change, and lets everyone go when it grew too big. */
  async function check(document: Document, deckId: string) {
    try {
      if (await repair(document, deckId, { source: 'local' }) && !document.isDestroyed && overLimit(document))
        closeRoom(document, TOO_BIG)
    }
    catch (error) {
      console.error(`Could not check the live deck ${document.name}`, error)
    }
  }

  return new Hocuspocus<CollabContext>({
    // Saves wait for 2 seconds without changes, and 10 seconds at most.
    debounce: 2000,
    maxDebounce: 10_000,
    quiet: true,

    async onAuthenticate({ token, requestHeaders, documentName, connectionConfig }) {
      const person = await personOf(token, requestHeaders)
      const deckId = deckIdOf(documentName)
      const access = person && deckId ? await projects.deckAccess(person.id, deckId) : undefined
      if (!person || !access)
        throw new NoAccess()
      // Viewers follow along: the room ignores their changes but shows their presence.
      if (!atLeast(access.role, 'editor'))
        connectionConfig.readOnly = true
      return { userId: person.id, name: person.name, role: access.role, signedInUntil: person.until, cookie: person.cookie } satisfies CollabContext
    },

    async connected({ connection, context, documentName }) {
      // Access may have changed while the room loaded: after the check above,
      // but before this connection was in the room for `revoke` to find.
      try {
        const deckId = deckIdOf(documentName)
        const access = deckId ? await projects.deckAccess(context.userId, deckId) : undefined
        if (access?.role !== context.role) {
          closeConnection(connection, ACCESS_CHANGED)
          return
        }
      }
      catch (error) {
        // The person had access a moment ago, so the connection stays.
        console.error(`Could not check access again for the live deck ${documentName}`, error)
      }
      watchSignIn(connection, context)
    },

    async onLoadDocument({ documentName, document }) {
      const deckId = deckIdOf(documentName)
      const state = deckId && await projects.storedState(deckId)
      if (!state)
        throw new DeckGoneError()
      Y.applyUpdate(document, state)
    },

    async afterLoadDocument({ document }) {
      document.on('update', (_update: Uint8Array, origin: unknown) => {
        if (!shouldSkipStoreHooks(origin))
          unsaved.add(document)
      })
    },

    async onChange({ documentName, instance }) {
      const deckId = deckIdOf(documentName)
      if (!deckId || checks.has(documentName))
        return
      const timer = setTimeout(() => {
        checks.delete(documentName)
        const document = instance.documents.get(documentName)
        if (document && !document.isDestroyed)
          void check(document, deckId)
      }, CHECK_DELAY_MS)
      timer.unref?.()
      checks.set(documentName, timer)
    },

    async onStoreDocument(payload) {
      const { documentName, document, instance } = payload
      const deckId = deckIdOf(documentName)
      // A room that only read the deck has nothing to save.
      if (!deckId || !unsaved.has(document))
        return
      try {
        // The repair is saved right here, so it schedules no other save.
        if (!(await repair(document, deckId, { source: 'local', skipStoreHooks: true }))) {
          // The deck was deleted: there is nowhere to save it.
          unsaved.delete(document)
          return
        }
        const state = Y.encodeStateAsUpdate(document)
        const problem = overLimit(document, state)
        if (problem) {
          // Nothing is saved, and everyone in the room is told why.
          storeProblems.set(document, 'too-big')
          console.warn(`The deck ${deckId} was not saved: it has ${problem}.`)
          closeRoom(document, TOO_BIG)
          return
        }
        unsaved.delete(document)
        await projects.storeState(deckId, state, readDeckDoc(document).slides.length)
        storeProblems.delete(document)
      }
      catch (error) {
        // Nothing is lost: the room stays loaded, since a save is pending,
        // and tries again after the usual delay until the save goes through.
        unsaved.add(document)
        storeProblems.set(document, 'failed')
        void instance.storeDocumentHooks(document, payload)
        throw error
      }
    },

    async beforeHandleAwareness({ states, removedClients, connection, context, document }) {
      if (!connection || !context)
        return
      // Presence says who someone is from their sign in, never from what
      // their client claims. A connection shows one presence, under the
      // client id it uses first, and only if nobody else showed presence
      // under that id in this room. So nobody can change or end another
      // person's presence, even when their page reconnects.
      let owners = presenceOwners.get(document)
      if (!owners) {
        owners = new Map()
        presenceOwners.set(document, owners)
      }
      const own = (clientId: number) => {
        const used = presenceIds.get(connection)
        if (used !== undefined)
          return used === clientId
        const owner = owners.get(clientId)
        if (owner !== undefined && owner !== context.userId)
          return false
        owners.set(clientId, context.userId)
        presenceIds.set(connection, clientId)
        return true
      }
      for (const [clientId, state] of states) {
        if (own(clientId))
          state.user = { id: context.userId, name: context.name ?? '', color: presenceColor(context.userId) }
        else
          states.delete(clientId)
      }
      for (const clientId of removedClients) {
        if (presenceIds.get(connection) !== clientId)
          removedClients.delete(clientId)
      }
    },

    async afterUnloadDocument({ documentName }) {
      clearTimeout(checks.get(documentName))
      checks.delete(documentName)
    },
  })
}
