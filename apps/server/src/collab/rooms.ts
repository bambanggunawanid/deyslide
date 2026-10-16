import type { Connection, Document, Hocuspocus } from '@hocuspocus/server'

/** A deck's live room, as WebSocket clients and server writers name it. */
export function roomName(deckId: string) {
  return `deck:${deckId}`
}

/** The deck a room belongs to, or undefined for a name that is not a deck's room. */
export function deckIdOf(name: string): string | undefined {
  return name.startsWith('deck:') && name.length > 'deck:'.length ? name.slice('deck:'.length) : undefined
}

/** A WebSocket close code and reason, which clients receive. */
export interface CloseReason {
  code: number
  reason: string
}

/** Sent when someone's access changed: their client joins again with what they may do now. */
export const ACCESS_CHANGED: CloseReason = { code: 4001, reason: 'access-changed' }

/** Lets people go from live rooms when their access changes. */
export interface CollabRooms {
  /** Closes the connections to these decks' rooms, only `userId`'s when given. */
  revoke: (deckIds: string[], userId?: string) => void
}

/**
 * Lets one connection go at once. The socket closes with `reason`, which the
 * client receives. The connection leaves the room right away, so whatever
 * the client still sends before its socket is closed changes nothing.
 */
export function closeConnection(connection: Connection, { code, reason }: CloseReason) {
  // The socket closes first: Hocuspocus then sends no close message of its
  // own, which would reach the client before this code.
  connection.webSocket.close(code, reason)
  connection.readOnly = true
  connection.close({ code, reason })
}

/**
 * Closes a room's connections (those of one person when `userId` is
 * given). Clients reconnect on their own and are checked again, so people
 * who keep access come back at once.
 */
export function closeRoom(document: Document, reason: CloseReason, userId?: string) {
  for (const connection of document.getConnections()) {
    if (userId === undefined || connection.context?.userId === userId)
      closeConnection(connection, reason)
  }
}

/** `CollabRooms.revoke` for the rooms of one Hocuspocus instance. */
export function revokeRooms(hocuspocus: Hocuspocus, deckIds: string[], userId?: string) {
  for (const deckId of deckIds) {
    const document = hocuspocus.documents.get(roomName(deckId))
    if (document)
      closeRoom(document, ACCESS_CHANGED, userId)
  }
}
