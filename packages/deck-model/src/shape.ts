// Which shape of the live document a client reads and writes. This file
// imports nothing, so the web app can load it with its first page.

/**
 * The shape of the live document this code reads and writes. Shape 1 held
 * each slide's frontmatter and each block's settings as one plain value.
 * Shape 2 holds them key by key (see `y-shape.ts`).
 */
export const LIVE_SHAPE = 2

/**
 * The query parameter on the live editing address that carries a client's
 * `LIVE_SHAPE`. Code for shape 1 reads a frontmatter map as empty and would
 * write that back over it, so the server turns away a client that sends
 * another shape, or none.
 */
export const SHAPE_PARAM = 'shape'

/** Why the server turned a client away for its shape, as the client receives it. */
export const SHAPE_REFUSED = 'update-required'

/** The live editing address with this code's shape on it. */
export function withLiveShape(url: string): string {
  const address = new URL(url)
  address.searchParams.set(SHAPE_PARAM, String(LIVE_SHAPE))
  return address.toString()
}
