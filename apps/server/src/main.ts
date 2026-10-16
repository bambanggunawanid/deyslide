import type { Server } from 'node:http'
import type { Mailer } from './mailer.ts'
import process from 'node:process'
import Anthropic from '@anthropic-ai/sdk'
import { serve } from '@hono/node-server'
import { Kysely, PostgresDialect } from 'kysely'
import pg from 'pg'
import { ClaudeModel } from './assistant/model.ts'
import { attachCollab } from './collab/attach.ts'
import { storeAllRooms } from './collab/shutdown.ts'
import { readConfig } from './config.ts'
import { HttpSlideRenderer } from './mcp/renderer.ts'
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

// The SDK reads ANTHROPIC_API_KEY, or a local `ant auth login` profile.
const assistantModel = config.assistant ? new ClaudeModel(new Anthropic()) : undefined

const renderer = config.rendererUrl ? new HttpSlideRenderer(config.rendererUrl) : undefined

const { app, collab, exports } = await createServer({ config, db, mailer, assistantModel, renderer })

const server = serve({ fetch: app.fetch, port: config.port, hostname: config.host }, (info) => {
  console.info(`Deyslide API listening on http://${info.address}:${info.port}`)
})
// serve() makes a plain HTTP/1.1 server, which is what WebSockets upgrade from.
const sockets = attachCollab(server as Server, collab, config.publicUrl)

let stopping = false
/** Saves every open deck before the database goes away. Clients reconnect to the next server. */
async function shutdown() {
  if (stopping)
    return
  stopping = true
  // Exports in progress stop and their temp files go; people can start them again.
  const exportsClosed = exports?.close()
  const unsaved = await storeAllRooms(collab)
  if (unsaved.length)
    console.error(`These live decks were not saved before stopping: ${unsaved.join(', ')}`)
  sockets.close()
  await exportsClosed
  server.close(() => {
    void db.destroy().finally(() => process.exit(0))
  })
}
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
