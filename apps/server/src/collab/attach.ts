import type { Hocuspocus, WebSocketLike } from '@hocuspocus/server'
import type { Peer } from 'crossws'
import type { IncomingMessage, Server } from 'node:http'
import type { Duplex } from 'node:stream'
import crossws from 'crossws/adapters/node'
import { CHANGE_MAX_BYTES } from './limits.ts'

/** Where clients open the live editing socket. */
export const COLLAB_PATH = '/api/collab'

/** Idle sockets get a ping this often, so proxies and the server's own idle check keep them. */
export const PING_INTERVAL_MS = 30_000

/**
 * The largest message a client may send. A change up to twice the largest
 * one a room takes still arrives, so the room can tell the page it is too
 * big; a larger message closes the socket.
 */
const MAX_MESSAGE_BYTES = CHANGE_MAX_BYTES * 2

type ClientConnection = ReturnType<Hocuspocus['handleConnection']>

/** The parts of a `ws` socket crossws keeps out of its types. */
interface NodeSocket {
  ping: () => void
  on: (event: 'pong', listener: () => void) => void
}

/** What `attachCollab` set up, to take it down when the server stops. */
export interface CollabSockets {
  /** Stops taking new sockets and drops the open ones. Store the rooms first. */
  close: () => void
}

export interface CollabSocketOptions {
  /** How often open sockets get a ping. Tests make it short. */
  pingIntervalMs?: number
}

/**
 * Serves live editing on `server` at /api/collab: upgrades those requests
 * to WebSockets with crossws, the way Hocuspocus's own server does, and
 * hands each socket to `hocuspocus`. Other upgrade requests are refused.
 * The hooks get the upgrade request as crossws builds it from the Node
 * request: a Fetch `Request` with the headers the client sent, such as its
 * cookies and Origin, on the address the client asked for.
 */
export function attachCollab(server: Server, hocuspocus: Hocuspocus, publicUrl: string, { pingIntervalMs = PING_INTERVAL_MS }: CollabSocketOptions = {}): CollabSockets {
  const connections = new Map<Peer, ClientConnection>()

  const sockets = crossws({
    serverOptions: { maxPayload: MAX_MESSAGE_BYTES },
    hooks: {
      open(peer) {
        const connection = hocuspocus.handleConnection(peer.websocket as unknown as WebSocketLike, peer.request)
        connections.set(peer, connection)
        // A pong is activity too, so a client that only listens is not dropped as idle.
        const socket = peer.websocket as unknown as NodeSocket
        socket.on('pong', () => connection.touch())
      },
      message(peer, message) {
        connections.get(peer)?.handleMessage(message.uint8Array())
      },
      close(peer, { code, reason }) {
        connections.get(peer)?.handleClose({ code: code ?? 1005, reason: reason ?? '' })
        connections.delete(peer)
      },
      error(_peer, error) {
        console.error('A live editing socket failed', error)
      },
    },
  })

  function onUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer) {
    if (new URL(request.url ?? '/', publicUrl).pathname !== COLLAB_PATH) {
      socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n')
      return
    }
    sockets.handleUpgrade(request, socket, head).catch((error) => {
      console.error('Could not open a live editing socket', error)
      socket.destroy()
    })
  }
  server.on('upgrade', onUpgrade)

  const ping = setInterval(() => {
    for (const peer of connections.keys())
      (peer.websocket as unknown as NodeSocket).ping()
  }, pingIntervalMs)
  ping.unref()

  return {
    close() {
      clearInterval(ping)
      server.off('upgrade', onUpgrade)
      sockets.closeAll(1012, 'The server is restarting', true)
    },
  }
}
