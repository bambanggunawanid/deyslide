import type { Hocuspocus } from '@hocuspocus/server'
import type { Kysely } from 'kysely'
import type { AssistantModel } from './assistant/model.ts'
import type { CollabContext } from './collab/hocuspocus.ts'
import type { CollabRooms } from './collab/rooms.ts'
import type { MediaStorage } from './media/storage.ts'
import type { SlideRenderer } from './mcp/renderer.ts'
import type { ServerConfig } from './config.ts'
import type { Mailer } from './mailer.ts'
import { createApp } from './app.ts'
import { UsageStore } from './assistant/usage.ts'
import { LiveDeckDocuments } from './collab/documents.ts'
import { createCollab } from './collab/hocuspocus.ts'
import { revokeRooms } from './collab/rooms.ts'
import { R2MediaStorage } from './media/storage.ts'
import { MediaStore } from './media/store.ts'
import { MarkdownDecks } from './mcp/decks.ts'
import { createAuth, migrateAuth } from './auth.ts'
import { migrateApp } from './db.ts'
import { ProjectStore } from './projects.ts'
import { SharingStore } from './sharing.ts'

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
  /** Storage for media uploads in place of R2, for tests. Without it, R2 is used when the settings name it. */
  mediaStorage?: MediaStorage
  /** How often live editing connections check their session. Tests make it short. */
  signInCheckMs?: number
}

/**
 * Wires the pieces together and brings the database schema up to date.
 * `collab` is the live editing server; attach it to the HTTP server with
 * `attachCollab`. Server writers use its rooms whether or not it is attached.
 */
export async function createServer({ config, db, mailer, assistantModel, now, renderer, mediaStorage, signInCheckMs }: ServerDependencies) {
  // The stores let people go from live rooms when their access changes, and
  // the rooms check access through the stores, so the rooms come last.
  let collab: Hocuspocus<CollabContext> | undefined
  const rooms: CollabRooms = {
    revoke(deckIds, userId) {
      if (collab)
        revokeRooms(collab, deckIds, userId)
    },
  }
  const projects = new ProjectStore(db, { rooms })
  const sharing = new SharingStore({ db, projects, publicUrl: config.publicUrl, mailer, rooms })
  const auth = createAuth({ config, db, mailer, onConfirmedSignIn: user => sharing.claimInvites(user.id, user.email) })
  await migrateAuth(auth)
  await migrateApp(db)
  collab = createCollab({ auth, projects, publicUrl: config.publicUrl, signInCheckMs })
  const documents = new LiveDeckDocuments(collab)
  const usage = new UsageStore(db)
  const assistant = config.assistant && assistantModel
    ? { model: assistantModel, usage, monthlyLimitUsd: config.assistant.monthlyLimitUsd, now }
    : undefined
  const mcp = { decks: new MarkdownDecks(projects, documents, config.publicUrl), renderer, version: SERVER_VERSION }
  const storage = mediaStorage ?? (config.r2 && new R2MediaStorage(config.r2))
  const media = storage && new MediaStore(db, storage, projects, { accountLimitBytes: config.mediaAccountLimitBytes, now })
  const app = createApp({ config, auth, projects, sharing, documents, emailEnabled: Boolean(mailer), assistant, mcp, media })
  return { app, auth, projects, sharing, usage, media, collab }
}
