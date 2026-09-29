import type { Mailer } from './mailer.ts'
import process from 'node:process'
import { serve } from '@hono/node-server'
import { Kysely, PostgresDialect } from 'kysely'
import pg from 'pg'
import { readConfig } from './config.ts'
import { CloudflareMailer, ConsoleMailer } from './mailer.ts'
import { createServer } from './server.ts'

const config = readConfig()

// pg reads PGHOST, PGPORT, PGUSER, PGPASSWORD and PGDATABASE itself.
const pool = new pg.Pool({ max: 10 })
const db = new Kysely<any>({ dialect: new PostgresDialect({ pool }) })

let mailer: Mailer | undefined
if (config.cloudflareEmail)
  mailer = new CloudflareMailer({ ...config.cloudflareEmail, from: config.emailFrom })
else if (!config.production)
  mailer = new ConsoleMailer()
else
  console.warn('CLOUDFLARE_ACCOUNT_ID or CLOUDFLARE_EMAIL_TOKEN is missing, so email sign in is off')

const { app } = await createServer({ config, db, mailer })

const server = serve({ fetch: app.fetch, port: config.port, hostname: config.host }, (info) => {
  console.info(`Deyslide API listening on http://${info.address}:${info.port}`)
})

function shutdown() {
  server.close(() => {
    void db.destroy().finally(() => process.exit(0))
  })
}
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
