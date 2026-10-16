import type { Awareness } from 'y-protocols/awareness'
import type { Peer } from './session'

// Presence: what each page with a deck open tells the others about itself,
// and how the page shows who else is here.

/** The fields of this page's presence. Others read them as its `Peer`. On the server, `user` is filled in from the account. */
export type PresenceFields = Omit<Peer, 'clientId'>

function same(a: unknown, b: unknown) {
  return a === b || JSON.stringify(a) === JSON.stringify(b)
}

/**
 * Sets fields of this page's presence in one message, and sends nothing
 * when none of them changed. Does nothing once the page let go of the deck.
 */
export function publishPresence(awareness: Awareness, fields: Partial<PresenceFields>) {
  const state = awareness.getLocalState()
  if (state === null)
    return
  const changed = Object.entries(fields).filter(([key, value]) => !same(state[key], value))
  if (changed.length > 0)
    awareness.setLocalState({ ...state, ...Object.fromEntries(changed) })
}

/** Everyone else here, once each (a person may have the deck open twice), without the signed in person. */
export function peopleHere(peers: Peer[], selfId?: string): Peer['user'][] {
  const seen = new Set<string | undefined>([selfId])
  const people: Peer['user'][] = []
  for (const { user } of peers) {
    if (seen.has(user.id))
      continue
    seen.add(user.id)
    people.push(user)
  }
  return people
}

/** The first letter of a name, for an avatar. */
export function personInitial(name: string) {
  return Array.from(name.trim())[0]?.toUpperCase() ?? '?'
}
