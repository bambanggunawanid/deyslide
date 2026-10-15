import type { Hocuspocus } from '@hocuspocus/server'
import type { CollabContext } from './hocuspocus.ts'
import * as Y from 'yjs'
import { storeProblem } from './hocuspocus.ts'
import { DeckTooBigError, overLimit } from './limits.ts'
import { roomName } from './rooms.ts'

/**
 * A change reached the live deck and everyone in it, but saving it failed.
 * The room keeps the change and tries the save again on its own.
 */
export class DeckNotSavedError extends Error {
  constructor() {
    super('The change is in the deck, but the server could not save it yet. It keeps trying.')
  }
}

/**
 * Reads and changes decks the way people see them: in their live room,
 * which loads the deck when nobody has it open. There is no other way to a
 * deck's content, so a server writer and the people editing never overwrite
 * each other, and a reader never gets a copy that is seconds old.
 * The caller checks the person's role first.
 */
export interface DeckDocuments {
  /**
   * Runs `change` on the live deck in one transaction, then saves the deck
   * before it resolves. Everyone in the room gets the change at once.
   * Throws `DeckTooBigError`, changing nothing, when the change would make
   * the deck too big to save; `DeckNotSavedError` when the change was made
   * but saving it failed; `DeckGoneError` when the deck no longer exists.
   */
  change: <T>(deckId: string, change: (doc: Y.Doc) => T, context: CollabContext) => Promise<T>
  /** Runs `read` on the live deck. Throws `DeckGoneError` when the deck no longer exists. */
  read: <T>(deckId: string, read: (doc: Y.Doc) => T, context: CollabContext) => Promise<T>
  /** Whether someone has the deck open in an editor right now. */
  hasClients: (deckId: string) => boolean
}

/**
 * `DeckDocuments` through Hocuspocus direct connections. They need no
 * listening socket, so the server, its tests and any other caller all go
 * through the rooms, and nothing reads or writes deck content another way.
 */
export class LiveDeckDocuments implements DeckDocuments {
  private readonly hocuspocus: Hocuspocus<CollabContext>

  constructor(hocuspocus: Hocuspocus<CollabContext>) {
    this.hocuspocus = hocuspocus
  }

  async change<T>(deckId: string, change: (doc: Y.Doc) => T, context: CollabContext): Promise<T> {
    const connection = await this.hocuspocus.openDirectConnection(roomName(deckId), context)
    const document = connection.document!
    let result: { value: T } | undefined
    try {
      await connection.transact((doc) => {
        // The change is made on a copy first. One that would make the deck
        // too big to save never reaches the room, so the room keeps saving
        // what people do, and nobody sees content that is then refused.
        const copy = new Y.Doc()
        copy.clientID = doc.clientID
        try {
          Y.applyUpdate(copy, Y.encodeStateAsUpdate(doc))
          const value = change(copy)
          if (overLimit(copy))
            throw new DeckTooBigError()
          Y.applyUpdate(doc, Y.encodeStateAsUpdate(copy, Y.encodeStateVector(doc)))
          result = { value }
        }
        finally {
          copy.destroy()
        }
      })
    }
    finally {
      // Saves at once, and closes the room when nobody else is in it.
      await connection.disconnect()
    }
    // Others may have pushed the deck past a limit at the same moment.
    const problem = storeProblem(document)
    if (problem === 'too-big')
      throw new DeckTooBigError()
    if (problem === 'failed')
      throw new DeckNotSavedError()
    return result!.value
  }

  async read<T>(deckId: string, read: (doc: Y.Doc) => T, context: CollabContext): Promise<T> {
    const connection = await this.hocuspocus.openDirectConnection(roomName(deckId), context)
    try {
      return read(connection.document!)
    }
    finally {
      await connection.disconnect()
    }
  }

  hasClients(deckId: string) {
    return (this.hocuspocus.documents.get(roomName(deckId))?.connections.size ?? 0) > 0
  }
}
