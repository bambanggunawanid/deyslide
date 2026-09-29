import type { Context } from 'hono'
import type { Auth } from './auth.ts'
import type { ProjectStore } from './projects.ts'
import type { Env } from './routes.ts'
import type { ListEntry, SharingStore, ShareTarget } from './sharing.ts'
import { Hono } from 'hono'
import { z } from 'zod'
import { ForbiddenError } from './projects.ts'
import { BadRequest, body, notFound, signedInOnly } from './routes.ts'
import { ShareError } from './sharing.ts'

const RoleSchema = z.enum(['editor', 'viewer'], 'Choose editor or viewer')
const ShareBody = z.object({
  email: z.email('Enter a valid email address').max(254),
  role: RoleSchema,
})
const RoleBody = z.object({ role: RoleSchema })

/**
 * Sharing, under /api: what is shared with the signed in person, and the
 * people and invites of each project and deck.
 */
export function sharingRoutes(auth: Auth, projects: ProjectStore, sharing: SharingStore) {
  const signedIn = signedInOnly(auth)
  const api = new Hono<Env>()

  api.onError((error, c) => {
    if (error instanceof BadRequest || error instanceof ShareError)
      return c.json({ error: error.message }, 400)
    if (error instanceof ForbiddenError)
      return c.json({ error: error.message }, 403)
    throw error
  })

  api.get('/shared', signedIn, async c => c.json(await projects.shared(c.var.userId)))

  for (const [path, type] of [['projects', 'project'], ['decks', 'deck']] as const) {
    const target = (c: Context): ShareTarget => ({ type, id: c.req.param('id')! })
    const entry = (c: Context): ListEntry => c.req.param('userId') ? { userId: c.req.param('userId')! } : { inviteId: c.req.param('inviteId')! }

    api.get(`/${path}/:id/sharing`, signedIn, async (c) => {
      const list = await sharing.list(c.var.userId, target(c))
      return list ? c.json(list) : notFound(c)
    })

    api.post(`/${path}/:id/sharing`, signedIn, async (c) => {
      const { email, role } = await body(c, ShareBody)
      const list = await sharing.share(c.var.userId, target(c), email, role)
      return list ? c.json(list, 201) : notFound(c)
    })

    for (const kind of ['members/:userId', 'invites/:inviteId']) {
      api.patch(`/${path}/:id/sharing/${kind}`, signedIn, async (c) => {
        const { role } = await body(c, RoleBody)
        return await sharing.changeRole(c.var.userId, target(c), entry(c), role) ? c.body(null, 204) : notFound(c)
      })
      api.delete(`/${path}/:id/sharing/${kind}`, signedIn, async (c) => {
        return await sharing.remove(c.var.userId, target(c), entry(c)) ? c.body(null, 204) : notFound(c)
      })
    }
  }

  return api
}
