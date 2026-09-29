import type { AppDb, Role, SharedRole } from './db.ts'
import type { Mailer } from './mailer.ts'
import type { Person, ProjectStore } from './projects.ts'
import { inviteEmail, sharedEmail } from './emails.ts'
import { atLeast, ForbiddenError, higher } from './projects.ts'

/** A project or a single deck. */
export interface ShareTarget {
  type: 'project' | 'deck'
  id: string
}

export interface Member extends Person {
  userId: string
  role: SharedRole
}

export interface Invite {
  id: string
  email: string
  role: SharedRole
}

/** Who has access to a project or deck, as the sharing dialog shows it. */
export interface ShareList {
  owner: Person
  /** The signed in person's role here. */
  role: Role
  members: Member[]
  invites: Invite[]
}

/** Someone on the list: an account, or an address that has not signed up yet. */
export type ListEntry = { userId: string } | { inviteId: string }

/** A sharing request that cannot go through. The message says why. */
export class ShareError extends Error {}

/** People and invites one project or deck can hold, so no one can mass mail through Deyslide. */
export const MAX_SHARES = 50

export interface SharingDependencies {
  db: AppDb
  projects: ProjectStore
  publicUrl: string
  /** Without a mailer, sharing still works; nobody is emailed. */
  mailer?: Mailer
  newId?: () => string
}

interface ResolvedTarget {
  name: string
  projectId: string
  ownerId: string
  /** The acting person's role on the target. */
  role: Role
}

/**
 * Sharing projects and decks. Owners and editors share, as an editor or a
 * viewer. Only the owner changes roles or removes people, and anyone can
 * leave. An address without an account gets an invite, which becomes access
 * when someone signs in with that address, confirmed.
 */
export class SharingStore {
  private readonly db: AppDb
  private readonly projects: ProjectStore
  private readonly publicUrl: string
  private readonly mailer?: Mailer
  private readonly newId: () => string

  constructor({ db, projects, publicUrl, mailer, newId = () => crypto.randomUUID() }: SharingDependencies) {
    this.db = db
    this.projects = projects
    this.publicUrl = publicUrl
    this.mailer = mailer
    this.newId = newId
  }

  /** Undefined when the target is missing or not shared with the person. */
  async list(actorId: string, target: ShareTarget): Promise<ShareList | undefined> {
    const resolved = await this.resolve(actorId, target)
    return resolved && this.listOf(target, resolved)
  }

  /** Gives `email` access as `role`, and tells them by email. Undefined when the target is not the person's to see. */
  async share(actorId: string, target: ShareTarget, email: string, role: SharedRole): Promise<ShareList | undefined> {
    const resolved = await this.resolve(actorId, target)
    if (!resolved)
      return undefined
    if (!atLeast(resolved.role, 'editor'))
      throw new ForbiddenError('Only the owner and editors can share.')

    const address = email.trim().toLowerCase()
    const people = await this.db.selectFrom('user').select(['id', 'name', 'email']).where('id', 'in', [actorId, resolved.ownerId]).execute()
    const actor = people.find(person => person.id === actorId)!
    const owner = people.find(person => person.id === resolved.ownerId)!
    if (owner.email.toLowerCase() === address)
      throw new ShareError(actorId === owner.id ? 'You already own this.' : `${address} owns this.`)
    if (actor.email.toLowerCase() === address)
      throw new ShareError('You already have access.')

    const current = await this.listOf(target, resolved)
    if (current.members.length + current.invites.length >= MAX_SHARES)
      throw new ShareError(`This is shared with ${MAX_SHARES} people already. Remove someone first.`)
    if (current.members.some(member => member.email.toLowerCase() === address))
      throw new ShareError(`${address} already has access. Change the role in the list instead.`)
    if (current.invites.some(invite => invite.email === address))
      throw new ShareError(`${address} is already invited. Change the role in the list instead.`)

    const account = await this.db.selectFrom('user').select(['id']).where('email', '=', address).executeTakeFirst()
    const created_at = new Date()
    if (account) {
      if (target.type === 'project')
        await this.db.insertInto('project_member').values({ project_id: target.id, user_id: account.id, role, created_at }).execute()
      else
        await this.db.insertInto('deck_member').values({ deck_id: target.id, user_id: account.id, role, created_at }).execute()
    }
    else {
      await this.db.insertInto('invite').values({ id: this.newId(), email: address, target_type: target.type, target_id: target.id, role, invited_by: actorId, created_at }).execute()
    }

    const url = account
      ? target.type === 'project' ? `${this.publicUrl}/p/${resolved.projectId}` : `${this.publicUrl}/p/${resolved.projectId}/d/${target.id}`
      : `${this.publicUrl}/sign-up`
    try {
      await this.mailer?.send(account
        ? sharedEmail(address, actor.name, resolved.name, role, url)
        : inviteEmail(address, actor.name, resolved.name, role, url))
    }
    catch (error) {
      // The access is saved either way; the email is only a heads up.
      console.error('Could not send the sharing email', error)
    }
    return this.listOf(target, resolved)
  }

  /** The owner only. Returns false when the target or the entry is missing. */
  async changeRole(actorId: string, target: ShareTarget, entry: ListEntry, role: SharedRole): Promise<boolean> {
    const resolved = await this.resolve(actorId, target)
    if (!resolved)
      return false
    if (resolved.role !== 'owner')
      throw new ForbiddenError('Only the owner can change roles.')
    const result = 'inviteId' in entry
      ? await this.db.updateTable('invite').set({ role }).where('id', '=', entry.inviteId).where('target_type', '=', target.type).where('target_id', '=', target.id).executeTakeFirst()
      : target.type === 'project'
        ? await this.db.updateTable('project_member').set({ role }).where('project_id', '=', target.id).where('user_id', '=', entry.userId).executeTakeFirst()
        : await this.db.updateTable('deck_member').set({ role }).where('deck_id', '=', target.id).where('user_id', '=', entry.userId).executeTakeFirst()
    return result.numUpdatedRows > 0n
  }

  /** The owner removes anyone. Everyone else can only remove themselves, which is leaving. */
  async remove(actorId: string, target: ShareTarget, entry: ListEntry): Promise<boolean> {
    const resolved = await this.resolve(actorId, target)
    if (!resolved)
      return false
    const leaving = 'userId' in entry && entry.userId === actorId
    if (resolved.role !== 'owner' && !leaving)
      throw new ForbiddenError('Only the owner can remove people.')
    if (resolved.role === 'owner' && leaving)
      throw new ShareError('The owner cannot leave. Delete the project instead.')
    const result = 'inviteId' in entry
      ? await this.db.deleteFrom('invite').where('id', '=', entry.inviteId).where('target_type', '=', target.type).where('target_id', '=', target.id).executeTakeFirst()
      : target.type === 'project'
        ? await this.db.deleteFrom('project_member').where('project_id', '=', target.id).where('user_id', '=', entry.userId).executeTakeFirst()
        : await this.db.deleteFrom('deck_member').where('deck_id', '=', target.id).where('user_id', '=', entry.userId).executeTakeFirst()
    return result.numDeletedRows > 0n
  }

  /**
   * Turns invites to `email` into access for the account. Call it only for
   * a confirmed address. Someone invited twice keeps the higher role.
   */
  async claimInvites(userId: string, email: string) {
    const invites = await this.db.selectFrom('invite').selectAll().where('email', '=', email.trim().toLowerCase()).execute()
    if (invites.length === 0)
      return
    await this.db.transaction().execute(async (trx) => {
      for (const invite of invites) {
        const created_at = new Date()
        if (invite.target_type === 'project') {
          const project = await trx.selectFrom('project').select('owner_id').where('id', '=', invite.target_id).executeTakeFirst()
          if (project && project.owner_id !== userId) {
            const existing = await trx.selectFrom('project_member').select('role').where('project_id', '=', invite.target_id).where('user_id', '=', userId).executeTakeFirst()
            const role = higher(existing?.role, invite.role) as SharedRole
            await trx.insertInto('project_member').values({ project_id: invite.target_id, user_id: userId, role, created_at })
              .onConflict(conflict => conflict.columns(['project_id', 'user_id']).doUpdateSet({ role }))
              .execute()
          }
        }
        else {
          const deck = await trx.selectFrom('deck').innerJoin('project', 'project.id', 'deck.project_id').select('project.owner_id').where('deck.id', '=', invite.target_id).executeTakeFirst()
          if (deck && deck.owner_id !== userId) {
            const existing = await trx.selectFrom('deck_member').select('role').where('deck_id', '=', invite.target_id).where('user_id', '=', userId).executeTakeFirst()
            const role = higher(existing?.role, invite.role) as SharedRole
            await trx.insertInto('deck_member').values({ deck_id: invite.target_id, user_id: userId, role, created_at })
              .onConflict(conflict => conflict.columns(['deck_id', 'user_id']).doUpdateSet({ role }))
              .execute()
          }
        }
      }
      await trx.deleteFrom('invite').where('id', 'in', invites.map(invite => invite.id)).execute()
    })
  }

  private async resolve(actorId: string, target: ShareTarget): Promise<ResolvedTarget | undefined> {
    if (target.type === 'project') {
      const role = await this.projects.projectRole(actorId, target.id)
      if (!role)
        return undefined
      const project = await this.db.selectFrom('project').select(['name', 'owner_id']).where('id', '=', target.id).executeTakeFirstOrThrow()
      return { name: project.name, projectId: target.id, ownerId: project.owner_id, role }
    }
    const access = await this.projects.deckAccess(actorId, target.id)
    if (!access)
      return undefined
    const deck = await this.db.selectFrom('deck').innerJoin('project', 'project.id', 'deck.project_id')
      .select(['deck.name', 'project.owner_id'])
      .where('deck.id', '=', target.id)
      .executeTakeFirstOrThrow()
    return { name: deck.name, projectId: access.projectId, ownerId: deck.owner_id, role: access.role }
  }

  private async listOf(target: ShareTarget, resolved: ResolvedTarget): Promise<ShareList> {
    const owner = await this.db.selectFrom('user').select(['name', 'email']).where('id', '=', resolved.ownerId).executeTakeFirstOrThrow()
    const members = target.type === 'project'
      ? await this.db.selectFrom('project_member').innerJoin('user', 'user.id', 'project_member.user_id')
        .select(['user.id as userId', 'user.name', 'user.email', 'project_member.role'])
        .where('project_member.project_id', '=', target.id)
        .orderBy('project_member.created_at', 'asc')
        .execute()
      : await this.db.selectFrom('deck_member').innerJoin('user', 'user.id', 'deck_member.user_id')
        .select(['user.id as userId', 'user.name', 'user.email', 'deck_member.role'])
        .where('deck_member.deck_id', '=', target.id)
        .orderBy('deck_member.created_at', 'asc')
        .execute()
    const invites = await this.db.selectFrom('invite').select(['id', 'email', 'role'])
      .where('target_type', '=', target.type)
      .where('target_id', '=', target.id)
      .orderBy('created_at', 'asc')
      .execute()
    return { owner, role: resolved.role, members, invites }
  }
}
