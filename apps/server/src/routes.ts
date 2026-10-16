import type { Context } from 'hono'
import type { Auth } from './auth.ts'
import type { DeckDocuments } from './collab/documents.ts'
import type { MediaStore } from './media/store.ts'
import type { ProjectStore } from './projects.ts'
import { applyDeck } from '@deyslide/deck-model'
import { Hono } from 'hono'
import { createMiddleware } from 'hono/factory'
import * as Y from 'yjs'
import { z } from 'zod'
import { bearerToken, verifyAccessToken } from './access-token.ts'
import { apiUrl } from './auth.ts'
import { DeckNotSavedError } from './collab/documents.ts'
import { DeckGoneError } from './collab/hocuspocus.ts'
import { DeckTooBigError } from './collab/limits.ts'
import { DeckContentError, deckOfState, ForbiddenError, NameSchema } from './projects.ts'

export interface Env {
  Variables: { userId: string }
}

export class BadRequest extends Error {}

const Base64Schema = z.base64('The deck content must be base64').transform(value => new Uint8Array(Buffer.from(value, 'base64')))
const NameBody = z.object({ name: NameSchema })
const NewDeckBody = z.object({ name: NameSchema, state: Base64Schema })
const StateBody = z.object({ state: Base64Schema })
const TimeSchema = z.number().int().nonnegative()
const IdSchema = z.string().min(1).max(100)
const ImportBody = z.object({
  projects: z.array(z.object({
    id: IdSchema,
    name: NameSchema,
    createdAt: TimeSchema,
    updatedAt: TimeSchema,
    decks: z.array(z.object({
      id: IdSchema,
      name: NameSchema,
      createdAt: TimeSchema,
      updatedAt: TimeSchema,
      state: Base64Schema,
    })).max(200),
  })).max(100),
})

export async function body<T extends z.ZodType>(c: Context, schema: T): Promise<z.output<T>> {
  const json = await c.req.json().catch(() => {
    throw new BadRequest('The request body must be JSON')
  })
  const parsed = schema.safeParse(json)
  if (!parsed.success)
    throw new BadRequest(parsed.error.issues[0]?.message ?? 'The request is not valid')
  return parsed.data
}

export const notFound = (c: Context) => c.json({ error: 'Not found' }, 404)

/** What an older page that saves whole decks is told while others edit the deck live. */
export const LIVE_EDITING = 'This deck is open for live editing. Reload the page to keep editing.'

/**
 * Lets a request through only with a session, or with an access token for
 * the API (the Deyslide apps), and names its user.
 */
export function signedInOnly(auth: Auth) {
  // createAuth sets Better Auth's base URL to the public URL.
  const config = { publicUrl: String(auth.options.baseURL) }
  const audience = apiUrl(config)
  return createMiddleware<Env>(async (c, next) => {
    const token = bearerToken(c.req.header('authorization'))
    if (token) {
      const userId = await verifyAccessToken(auth, config, token, audience)
      if (!userId)
        return c.json({ error: 'Sign in first' }, 401, { 'www-authenticate': 'Bearer error="invalid_token"' })
      c.set('userId', userId)
      return next()
    }
    const session = await auth.api.getSession({ headers: c.req.raw.headers })
    if (!session)
      return c.json({ error: 'Sign in first' }, 401)
    c.set('userId', session.user.id)
    await next()
  })
}

/**
 * Projects and decks of the signed in user, under /api. Deck content goes
 * through each deck's live room. With media on, deleting a project deletes
 * its stored files too.
 */
export function projectRoutes(auth: Auth, store: ProjectStore, documents: DeckDocuments, media?: MediaStore) {
  const signedIn = signedInOnly(auth)

  const api = new Hono<Env>()

  api.onError((error, c) => {
    if (error instanceof BadRequest || error instanceof DeckContentError || error instanceof DeckTooBigError)
      return c.json({ error: error.message }, 400)
    if (error instanceof ForbiddenError)
      return c.json({ error: error.message }, 403)
    if (error instanceof DeckGoneError)
      return notFound(c)
    if (error instanceof DeckNotSavedError)
      return c.json({ error: error.message }, 503)
    throw error
  })

  /** Who is signed in. The apps ask, since they hold a token and no session. */
  api.get('/me', signedIn, async (c) => {
    const user = await (await auth.$context).internalAdapter.findUserById(c.var.userId)
    if (!user)
      return c.json({ error: 'Sign in first' }, 401)
    return c.json({ id: user.id, name: user.name, email: user.email })
  })

  api.get('/projects', signedIn, async c => c.json(await store.list(c.var.userId)))

  api.post('/projects', signedIn, async (c) => {
    const { name } = await body(c, NameBody)
    return c.json(await store.createProject(c.var.userId, name), 201)
  })

  api.patch('/projects/:id', signedIn, async (c) => {
    const { name } = await body(c, NameBody)
    return await store.renameProject(c.var.userId, c.req.param('id'), name) ? c.body(null, 204) : notFound(c)
  })

  api.delete('/projects/:id', signedIn, async (c) => {
    const id = c.req.param('id')
    const stored = await media?.keysOf(id)
    if (!(await store.deleteProject(c.var.userId, id)))
      return notFound(c)
    if (stored)
      await media!.deleteStored(stored)
    return c.body(null, 204)
  })

  api.post('/projects/:id/decks', signedIn, async (c) => {
    const { name, state } = await body(c, NewDeckBody)
    const deck = await store.createDeck(c.var.userId, c.req.param('id'), name, state)
    return deck ? c.json(deck, 201) : notFound(c)
  })

  api.patch('/decks/:id', signedIn, async (c) => {
    const { name } = await body(c, NameBody)
    return await store.renameDeck(c.var.userId, c.req.param('id'), name) ? c.body(null, 204) : notFound(c)
  })

  api.delete('/decks/:id', signedIn, async (c) => {
    return await store.deleteDeck(c.var.userId, c.req.param('id')) ? c.body(null, 204) : notFound(c)
  })

  /** The deck as it is in its live room right now. Anyone the deck is shared with can read it. */
  api.get('/decks/:id/state', signedIn, async (c) => {
    const deckId = c.req.param('id')
    if (!(await store.deckAccess(c.var.userId, deckId)))
      return notFound(c)
    const state = await documents.read(deckId, doc => Y.encodeStateAsUpdate(doc), { userId: c.var.userId })
    return c.body(state.slice().buffer, 200, { 'content-type': 'application/octet-stream', 'cache-control': 'no-store' })
  })

  /**
   * Saves a whole deck, as pages from before live editing do. It is merged
   * into the live deck, so only what differs changes. While people have the
   * deck open live it is refused: a page that saves whole decks would undo
   * their edits on every save.
   */
  api.put('/decks/:id/state', signedIn, async (c) => {
    const { state } = await body(c, StateBody)
    const deck = deckOfState(state)
    const deckId = c.req.param('id')
    if (!(await store.editableDeck(c.var.userId, deckId, 'You can view this deck but not change it.')))
      return notFound(c)
    if (documents.hasClients(deckId))
      return c.json({ error: LIVE_EDITING }, 400)
    await documents.change(deckId, doc => applyDeck(doc, deck), { userId: c.var.userId })
    return c.body(null, 204)
  })

  api.post('/import', signedIn, async (c) => {
    const { projects } = await body(c, ImportBody)
    return c.json({ imported: await store.import(c.var.userId, projects) })
  })

  return api
}
