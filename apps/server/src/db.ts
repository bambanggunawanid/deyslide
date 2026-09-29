import type { ColumnType, Kysely } from 'kysely'
import type { Migration } from 'kysely/migration'
import { sql } from 'kysely'
import { Migrator } from 'kysely/migration'

type Timestamp = ColumnType<Date, Date | undefined, Date>

export interface ProjectTable {
  id: string
  owner_id: string
  name: string
  created_at: Timestamp
  updated_at: Timestamp
}

export interface DeckTable {
  id: string
  project_id: string
  name: string
  /** The deck's Yjs document, as one encoded update. */
  state: Uint8Array
  slide_count: number
  created_at: Timestamp
  updated_at: Timestamp
}

/** The app's own tables. Better Auth manages `user`, `session`, `account` and `verification`. */
export interface Database {
  project: ProjectTable
  deck: DeckTable
}

export type AppDb = Kysely<Database>

const MIGRATIONS: Record<string, Migration> = {
  '2026-09-29-projects-and-decks': {
    async up(db) {
      await db.schema.createTable('project')
        .addColumn('id', 'text', column => column.primaryKey())
        .addColumn('owner_id', 'text', column => column.notNull().references('user.id').onDelete('cascade'))
        .addColumn('name', 'text', column => column.notNull())
        .addColumn('created_at', 'timestamptz', column => column.notNull().defaultTo(sql`now()`))
        .addColumn('updated_at', 'timestamptz', column => column.notNull().defaultTo(sql`now()`))
        .execute()
      await db.schema.createIndex('project_owner_id_index').on('project').column('owner_id').execute()

      await db.schema.createTable('deck')
        .addColumn('id', 'text', column => column.primaryKey())
        .addColumn('project_id', 'text', column => column.notNull().references('project.id').onDelete('cascade'))
        .addColumn('name', 'text', column => column.notNull())
        .addColumn('state', 'bytea', column => column.notNull())
        .addColumn('slide_count', 'integer', column => column.notNull())
        .addColumn('created_at', 'timestamptz', column => column.notNull().defaultTo(sql`now()`))
        .addColumn('updated_at', 'timestamptz', column => column.notNull().defaultTo(sql`now()`))
        .execute()
      await db.schema.createIndex('deck_project_id_index').on('deck').column('project_id').execute()
    },
  },
}

export class MigrationError extends Error {}

/** Brings the app's tables up to date. Runs after Better Auth's, since projects reference users. */
export async function migrateApp(db: Kysely<any>) {
  const migrator = new Migrator({ db, provider: { getMigrations: async () => MIGRATIONS } })
  const { error } = await migrator.migrateToLatest()
  if (error)
    throw new MigrationError(`Database migration failed: ${error instanceof Error ? error.message : String(error)}`)
}
