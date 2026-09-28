import type { Position } from './schema'

/**
 * Slidev's `v-drag` position string: "x,y,w,h,rotate".
 * Slidev writes a missing height as NaN, which means "grow with the content".
 */
export function formatPos(pos: Position): string {
  const height = pos.h === null ? 'NaN' : String(pos.h)
  return [pos.x, pos.y, pos.w, height, pos.rotate].map(String).join(',')
}

/** Returns undefined when the string is not a usable position. */
export function parsePos(raw: string): Position | undefined {
  const parts = raw.split(',').map(part => part.trim())
  if (parts.length < 3 || parts.length > 5)
    return undefined

  const [x, y, w, h, rotate] = parts.map(Number)
  if (![x, y, w].every(Number.isFinite) || w < 0)
    return undefined

  const height = parts[3] === undefined || Number.isNaN(h) ? null : h
  if (height !== null && (!Number.isFinite(height) || height < 0))
    return undefined

  const angle = parts[4] === undefined ? 0 : rotate
  if (!Number.isFinite(angle))
    return undefined

  return { x, y, w, h: height, rotate: angle }
}
