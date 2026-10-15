import type { Position } from '@deyslide/deck-model'

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

/** The positions from a `deyslide:positions` message that an element can take; the rest are dropped. */
export function usablePositions(value: unknown): Record<string, Position> {
  if (typeof value !== 'object' || value === null)
    return {}
  // No prototype, so an id such as `__proto__` is a plain entry like any other.
  const usable = Object.create(null) as Record<string, Position>
  for (const [id, pos] of Object.entries(value as Record<string, Partial<Position>>)) {
    if (typeof pos !== 'object' || pos === null)
      continue
    const { x, y, w, h, rotate = 0 } = pos
    if (finite(x) && finite(y) && finite(w) && w >= 0 && finite(rotate) && (h === null || (finite(h) && h >= 0)))
      usable[id] = { x, y, w, h, rotate }
  }
  return usable
}
