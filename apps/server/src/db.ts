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

export type Role = 'owner' | 'editor' | 'viewer'
/** The roles that can be given to someone else. There is one owner, who made the project. */
export type SharedRole = Exclude<Role, 'owner'>

export interface ProjectMemberTable {
  project_id: string
  user_id: string
  role: SharedRole
  created_at: Timestamp
}

export interface DeckMemberTable {
  deck_id: string
  user_id: string
  role: SharedRole
  created_at: Timestamp
}

/** Access waiting for someone without an account. It becomes a member row when they sign in verified. */
export interface InviteTable {
  id: string
  email: string
  target_type: 'project' | 'deck'
  target_id: string
  role: SharedRole
  invited_by: string
  created_at: Timestamp
}

/** The columns of Better Auth's `user` table that the app reads. */
export interface UserTable {
  id: string
  name: string
  email: string
  emailVerified: boolean
}

/** The app's own tables, plus Better Auth's `user` for reading names and emails. */
export interface Database {
  project: ProjectTable
  deck: DeckTable
  project_member: ProjectMemberTable
  deck_member: DeckMemberTable
  invite: InviteTable
  user: UserTable
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
  '2026-09-29-sharing': {
    async up(db) {
      for (const [table, target, targetTable] of [['project_member', 'project_id', 'project'], ['deck_member', 'deck_id', 'deck']] as const) {
        await db.schema.createTable(table)
          .addColumn(target, 'text', column => column.notNull().references(`${targetTable}.id`).onDelete('cascade'))
          .addColumn('user_id', 'text', column => column.notNull().references('user.id').onDelete('cascade'))
          .addColumn('role', 'text', column => column.notNull().check(sql`role in ('editor', 'viewer')`))
          .addColumn('created_at', 'timestamptz', column => column.notNull().defaultTo(sql`now()`))
          .addPrimaryKeyConstraint(`${table}_primary_key`, [target, 'user_id'])
          .execute()
        await db.schema.createIndex(`${table}_user_id_index`).on(table).column('user_id').execute()
      }

      await db.schema.createTable('invite')
        .addColumn('id', 'text', column => column.primaryKey())
        .addColumn('email', 'text', column => column.notNull())
        .addColumn('target_type', 'text', column => column.notNull().check(sql`target_type in ('project', 'deck')`))
        .addColumn('target_id', 'text', column => column.notNull())
        .addColumn('role', 'text', column => column.notNull().check(sql`role in ('editor', 'viewer')`))
        .addColumn('invited_by', 'text', column => column.notNull().references('user.id').onDelete('cascade'))
        .addColumn('created_at', 'timestamptz', column => column.notNull().defaultTo(sql`now()`))
        .addUniqueConstraint('invite_target_email_unique', ['target_type', 'target_id', 'email'])
        .execute()
      await db.schema.createIndex('invite_email_index').on('invite').column('email').execute()
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
