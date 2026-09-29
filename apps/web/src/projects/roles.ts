import type { DeckSummary, Project, Role } from '../guest/types'

/** The signed in person's role on a project: owner for their own, the shared role otherwise. */
export function projectRole(project: Project): Role | undefined {
  return project.shared ? project.shared.role ?? undefined : 'owner'
}

/** The role on a deck: the deck's own role on shared projects, owner otherwise. */
export function deckRole(project: Project, deck: DeckSummary): Role {
  return project.shared ? deck.role ?? 'viewer' : 'owner'
}

/** Owners and editors can change things. */
export function canEdit(role: Role | undefined) {
  return role === 'owner' || role === 'editor'
}
