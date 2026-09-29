import type { Kysely } from 'kysely'
import type { ServerConfig } from './config.ts'
import type { Mailer } from './mailer.ts'
import { createApp } from './app.ts'
import { createAuth, migrateAuth } from './auth.ts'
import { migrateApp } from './db.ts'
import { ProjectStore } from './projects.ts'

export interface ServerDependencies {
  config: ServerConfig
  db: Kysely<any>
  mailer?: Mailer
}

/** Wires the pieces together and brings the database schema up to date. */
export async function createServer({ config, db, mailer }: ServerDependencies) {
  const auth = createAuth({ config, db, mailer })
  await migrateAuth(auth)
  await migrateApp(db)
  const projects = new ProjectStore(db)
  const app = createApp({ config, auth, projects, emailEnabled: Boolean(mailer) })
  return { app, auth, projects }
}
