// The Deyslide API for end to end tests: the real server code on PGlite
// (in-memory Postgres), with sent emails kept in memory. Never deployed.
import type { Email, Mailer } from '../apps/server/src/mailer.ts'
import process from 'node:process'
import { PGlite } from '@electric-sql/pglite'
import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { Kysely } from 'kysely'
import { PGliteDialect } from 'kysely-pglite-dialect'
import { readConfig } from '../apps/server/src/config.ts'
import { createServer } from '../apps/server/src/server.ts'

const port = Number(process.env.E2E_API_PORT ?? 3101)
const outbox: Email[] = []
const mailer: Mailer = {
  async send(email) {
    outbox.push(email)
  },
}

const config = readConfig({ PUBLIC_URL: process.env.E2E_PUBLIC_URL ?? 'http://127.0.0.1:4180' })
const db = new Kysely<any>({ dialect: new PGliteDialect(new PGlite()) })
const { app } = await createServer({ config, db, mailer })

const root = new Hono()
// The newest email to an address, so a test can open the link in it.
root.get('/__e2e/emails/:to', (c) => {
  const email = outbox.findLast(item => item.to === c.req.param('to'))
  return email ? c.json(email) : c.json({ error: 'No email' }, 404)
})
root.route('/', app)

serve({ fetch: root.fetch, port, hostname: '127.0.0.1' }, info => console.info(`e2e API on http://127.0.0.1:${info.port}`))
