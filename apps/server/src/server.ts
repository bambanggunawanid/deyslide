import type { Kysely } from 'kysely'
import type { ServerConfig } from './config.ts'
import type { Mailer } from './mailer.ts'
import { createApp } from './app.ts'
import { createAuth, migrateAuth } from './auth.ts'

export interface ServerDependencies {
  config: ServerConfig
  db: Kysely<any>
  mailer?: Mailer
}

/** Wires the pieces together and brings the database schema up to date. */
export async function createServer({ config, db, mailer }: ServerDependencies) {
  const auth = createAuth({ config, db, mailer })
  await migrateAuth(auth)
  const app = createApp({ config, auth, emailEnabled: Boolean(mailer) })
  return { app, auth }
}
