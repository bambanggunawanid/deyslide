import type { Hocuspocus } from '@hocuspocus/server'

/**
 * How long a stopping server waits for its rooms to be saved. Container
 * runtimes kill a process 10 seconds after asking it to stop, and the
 * server still logs and closes the database after this wait.
 */
export const STORE_TIMEOUT_MS = 8000

/**
 * Closes every room, saves each deck and waits until all of them are
 * unloaded, or until `timeoutMs` passes. A room whose save failed is tried
 * again meanwhile. Returns the names of the rooms still open by then, whose
 * latest changes may not be saved. Clients keep their changes and send
 * them again when they reconnect.
 */
export async function storeAllRooms(hocuspocus: Hocuspocus, timeoutMs = STORE_TIMEOUT_MS): Promise<string[]> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const unloaded = new Promise<void>((resolve) => {
    hocuspocus.configuration.extensions.push({
      async afterUnloadDocument({ instance }) {
        if (instance.getDocumentsCount() === 0)
          resolve()
      },
    })
    if (hocuspocus.getDocumentsCount() === 0)
      resolve()
    timer = setTimeout(resolve, timeoutMs)
  })
  // Saving is not awaited by either call: the unload hook says when it is done.
  hocuspocus.closeConnections()
  hocuspocus.flushPendingStores()
  await unloaded
  clearTimeout(timer)
  return [...hocuspocus.documents.keys()]
}
