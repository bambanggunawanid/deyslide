import type { Auth } from '../auth.ts'
import type { Env } from '../routes.ts'
import type { MediaStore } from './store.ts'
import { Hono } from 'hono'
import { z } from 'zod'
import { ForbiddenError } from '../projects.ts'
import { BadRequest, body, notFound, signedInOnly } from '../routes.ts'
import { MediaError } from './store.ts'

const UploadBody = z.object({
  name: z.string().max(500),
  type: z.string().max(100),
  size: z.number(),
})

/**
 * Each project's media library under /api/projects/:id/media, and single
 * files under /api/media. Files go straight between the browser and storage
 * through signed links; the API only hands out links it checked.
 */
export function mediaRoutes(auth: Auth, media: MediaStore) {
  const signedIn = signedInOnly(auth)
  const api = new Hono<Env>()

  api.onError((error, c) => {
    if (error instanceof BadRequest || error instanceof MediaError)
      return c.json({ error: error.message }, 400)
    if (error instanceof ForbiddenError)
      return c.json({ error: error.message }, 403)
    throw error
  })

  api.get('/projects/:id/media', signedIn, async (c) => {
    const library = await media.list(c.var.userId, c.req.param('id'))
    return library ? c.json(library) : notFound(c)
  })

  api.post('/projects/:id/media', signedIn, async (c) => {
    const ticket = await media.startUpload(c.var.userId, c.req.param('id'), await body(c, UploadBody))
    return ticket ? c.json(ticket, 201) : notFound(c)
  })

  api.post('/media/:id/finish', signedIn, async (c) => {
    const file = await media.finishUpload(c.var.userId, c.req.param('id'))
    return file ? c.json(file) : notFound(c)
  })

  api.get('/media/:id', signedIn, async (c) => {
    const link = await media.link(c.var.userId, c.req.param('id'))
    return link ? c.json(link) : notFound(c)
  })

  // For <img> and <video> in the web app: the address stays the same, the link behind it is fresh.
  api.get('/media/:id/file', signedIn, async (c) => {
    const link = await media.link(c.var.userId, c.req.param('id'))
    return link ? c.redirect(link.url, 302) : notFound(c)
  })

  api.delete('/media/:id', signedIn, async (c) => {
    return await media.delete(c.var.userId, c.req.param('id')) ? c.body(null, 204) : notFound(c)
  })

  return api
}
