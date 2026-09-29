import type { Person, Role, SharedRole } from '../guest/types'

/** A project, or a single deck in one. */
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

/** Who has access to a project or deck. */
export interface ShareList {
  owner: Person
  /** The signed in person's role here. */
  role: Role
  members: Member[]
  invites: Invite[]
}

/** Someone on the list: an account, or an address that has not signed up yet. */
export type ListEntry = { userId: string } | { inviteId: string }

/** Sharing, for signed in people. */
export interface SharingApi {
  /** Who has access, and the signed in person's own role. */
  members: (target: ShareTarget) => Promise<ShareList>
  share: (target: ShareTarget, email: string, role: SharedRole) => Promise<ShareList>
  changeRole: (target: ShareTarget, entry: ListEntry, role: SharedRole) => Promise<void>
  /** The owner removes anyone; anyone else removes only themselves, which is leaving. */
  remove: (target: ShareTarget, entry: ListEntry) => Promise<void>
}
