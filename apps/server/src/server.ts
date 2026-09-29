import type { Kysely } from 'kysely'
import type { AssistantModel } from './assistant/model.ts'
import type { SlideRenderer } from './mcp/renderer.ts'
import type { ServerConfig } from './config.ts'
import type { Mailer } from './mailer.ts'
import { createApp } from './app.ts'
import { UsageStore } from './assistant/usage.ts'
import { MarkdownDecks } from './mcp/decks.ts'
import { createAuth, migrateAuth } from './auth.ts'
import { migrateApp } from './db.ts'
import { ProjectStore } from './projects.ts'

/** Reported to MCP clients. */
export const SERVER_VERSION = '0.1.0'

export interface ServerDependencies {
  config: ServerConfig
  db: Kysely<any>
  mailer?: Mailer
  /** The model behind the deck assistant. Used only when the settings turn the assistant on. */
  assistantModel?: AssistantModel
  /** The clock for the assistant's monthly allowance. Tests move it. */
  now?: () => Date
  /** Draws slides for the MCP server's render_slides tool. */
  renderer?: SlideRenderer
}

/** Wires the pieces together and brings the database schema up to date. */
export async function createServer({ config, db, mailer, assistantModel, now, renderer }: ServerDependencies) {
  const auth = createAuth({ config, db, mailer })
  await migrateAuth(auth)
  await migrateApp(db)
  const projects = new ProjectStore(db)
  const usage = new UsageStore(db)
  const assistant = config.assistant && assistantModel
    ? { model: assistantModel, usage, monthlyLimitUsd: config.assistant.monthlyLimitUsd, now }
    : undefined
  const mcp = { decks: new MarkdownDecks(projects, config.publicUrl), renderer, version: SERVER_VERSION }
  const app = createApp({ config, auth, projects, emailEnabled: Boolean(mailer), assistant, mcp })
  return { app, auth, projects, usage }
}
