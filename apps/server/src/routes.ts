import type { Context } from 'hono'
import type { Auth } from './auth.ts'
import type { ProjectStore } from './projects.ts'
import { Hono } from 'hono'
import { createMiddleware } from 'hono/factory'
import { z } from 'zod'
import { DeckContentError, NameSchema } from './projects.ts'

interface Env {
  Variables: { userId: string }
}

class BadRequest extends Error {}

const Base64Schema = z.base64('The deck content must be base64').transform(value => new Uint8Array(Buffer.from(value, 'base64')))
const NameBody = z.object({ name: NameSchema })
const NewDeckBody = z.object({ name: NameSchema, state: Base64Schema })
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

async function body<T extends z.ZodType>(c: Context, schema: T): Promise<z.output<T>> {
  const json = await c.req.json().catch(() => {
    throw new BadRequest('The request body must be JSON')
  })
  const parsed = schema.safeParse(json)
  if (!parsed.success)
    throw new BadRequest(parsed.error.issues[0]?.message ?? 'The request is not valid')
  return parsed.data
}

const notFound = (c: Context) => c.json({ error: 'Not found' }, 404)

/** Projects and decks of the signed in user, under /api. */
export function projectRoutes(auth: Auth, store: ProjectStore) {
  const signedIn = createMiddleware<Env>(async (c, next) => {
    const session = await auth.api.getSession({ headers: c.req.raw.headers })
    if (!session)
      return c.json({ error: 'Sign in first' }, 401)
    c.set('userId', session.user.id)
    await next()
  })

  const api = new Hono<Env>()

  api.onError((error, c) => {
    if (error instanceof BadRequest || error instanceof DeckContentError)
      return c.json({ error: error.message }, 400)
    throw error
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
    return await store.deleteProject(c.var.userId, c.req.param('id')) ? c.body(null, 204) : notFound(c)
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

  api.get('/decks/:id/state', signedIn, async (c) => {
    const state = await store.deckState(c.var.userId, c.req.param('id'))
    if (!state)
      return notFound(c)
    return c.body(state.slice().buffer, 200, { 'content-type': 'application/octet-stream', 'cache-control': 'no-store' })
  })

  api.post('/import', signedIn, async (c) => {
    const { projects } = await body(c, ImportBody)
    return c.json({ imported: await store.import(c.var.userId, projects) })
  })

  return api
}
