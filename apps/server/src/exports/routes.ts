import type { Auth } from '../auth.ts'
import type { Env } from '../routes.ts'
import type { ExportJobs } from './jobs.ts'
import { createReadStream } from 'node:fs'
import { Readable } from 'node:stream'
import { Hono } from 'hono'
import { z } from 'zod'
import { DeckInputError } from '../mcp/decks.ts'
import { BadRequest, body, notFound, signedInOnly } from '../routes.ts'
import { ExportBusyError, ExportLimitError, ExportUnavailableError } from './jobs.ts'
import { MAX_DWELL_MS, MIN_DWELL_MS } from './video.ts'

const DWELL = `dwellMs must be a whole number of milliseconds from ${MIN_DWELL_MS} to ${MAX_DWELL_MS}`

const ExportBody = z.object({
  deckId: z.string().min(1).max(100).optional(),
  markdown: z.string().optional(),
  format: z.enum(['pdf', 'webm'], 'Choose the format pdf or webm'),
  options: z.object({
    clicks: z.enum(['last', 'each'], 'clicks must be last or each').optional(),
    dwellMs: z.number(DWELL).int(DWELL).min(MIN_DWELL_MS, DWELL).max(MAX_DWELL_MS, DWELL).optional(),
  }, 'options must be an object').optional(),
}).refine(input => (input.deckId === undefined) !== (input.markdown === undefined), 'Send either a deckId or the markdown')

/** A Content-Disposition header that keeps a name with any characters. */
function attachment(name: string) {
  const plain = name.replace(/[^\x20-\x7E]|["\\]/g, '_')
  const encoded = encodeURIComponent(name).replace(/['()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)
  return `attachment; filename="${plain}"; filename*=UTF-8''${encoded}`
}

/**
 * PDF and video exports under /api/exports: start one, follow its
 * progress, download the file. Without a slide renderer, export is
 * unavailable.
 */
export function exportRoutes(auth: Auth, exports?: ExportJobs) {
  const signedIn = signedInOnly(auth)
  const api = new Hono<Env>()
  const unavailable = 'Export is not available on this server.'

  api.onError((error, c) => {
    if (error instanceof BadRequest || error instanceof DeckInputError || error instanceof ExportLimitError)
      return c.json({ error: error.message }, 400)
    if (error instanceof ExportBusyError)
      return c.json({ error: error.message }, 429)
    if (error instanceof ExportUnavailableError)
      return c.json({ error: error.message }, 503)
    throw error
  })

  api.post('/exports', signedIn, async (c) => {
    if (!exports)
      return c.json({ error: unavailable }, 503)
    const id = await exports.start(c.var.userId, await body(c, ExportBody))
    return id ? c.json({ id }, 202) : notFound(c)
  })

  api.get('/exports/:id', signedIn, async (c) => {
    const state = await exports?.status(c.var.userId, c.req.param('id'))
    return state ? c.json(state, 200, { 'cache-control': 'no-store' }) : notFound(c)
  })

  api.get('/exports/:id/file', signedIn, async (c) => {
    const file = await exports?.download(c.var.userId, c.req.param('id'))
    if (!file)
      return notFound(c)
    if (file === 'unfinished')
      return c.json({ error: 'The export is not finished yet.' }, 409)
    if ('failed' in file)
      return c.json({ error: `The export failed, so there is no file. ${file.failed}` }, 409)
    return new Response(Readable.toWeb(createReadStream(file.path)) as ReadableStream, {
      headers: {
        'content-type': file.type,
        'content-length': String(file.size),
        'content-disposition': attachment(file.name),
        'cache-control': 'no-store',
      },
    })
  })

  return api
}
