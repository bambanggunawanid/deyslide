// What the slide strip shows for each slide, and where a slide dragged in it lands.

/** Markup that shows no words: tags, comments and Vue bindings. */
function words(line: string) {
  return line
    .replace(/<!--.*?-->/g, '')
    .replace(/<[^>]*>/g, '')
    .replace(/\{\{.*?\}\}/g, '')
    .replace(/[*_`~]+/g, '')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^\s*(?:[-+>]|\d+\.)\s+/, '')
    .trim()
}

/**
 * A slide's title for the strip: its first heading, else its first line
 * with words, from the slide's Markdown without frontmatter. Code blocks
 * do not count.
 */
export function slideTitle(content: string): string {
  let fence: string | undefined
  let first: string | undefined
  for (const line of content.split('\n')) {
    const marker = line.match(/^\s*(`{3,}|~{3,})/)?.[1]
    if (marker && (!fence || (marker[0] === fence[0] && marker.length >= fence.length))) {
      fence = fence ? undefined : marker
      continue
    }
    if (fence)
      continue
    const heading = line.match(/^\s*#{1,6}\s+(.*)$/)
    if (heading) {
      const title = words(heading[1].replace(/\s#+\s*$/, ''))
      if (title)
        return title
    }
    if (first === undefined) {
      const text = words(line)
      if (text)
        first = text
    }
  }
  return first ?? ''
}

export interface ItemRect {
  left: number
  top: number
  width: number
  height: number
}

/**
 * Where a slide dropped at `point` goes, as the index it takes in the list
 * without it. `rects` are the strip's items in order, `from` is the dragged
 * one. The strip may run across (phones) or down; the items say which.
 */
export function dropIndex(rects: ItemRect[], from: number, point: { x: number, y: number }): number {
  const across = rects.length > 1 && rects[1].left >= rects[0].left + rects[0].width
  let before = 0
  for (const rect of rects) {
    const middle = across ? rect.left + rect.width / 2 : rect.top + rect.height / 2
    if ((across ? point.x : point.y) > middle)
      before++
  }
  // Past its own place, the dragged slide no longer counts.
  return before > from ? before - 1 : before
}

/**
 * Which slides show a live picture in the strip: those on screen, the ones
 * nearest the current slide first, at most `max`. Each picture is a preview
 * frame of its own, so a tall screen or a long deck never runs too many.
 */
export function thumbnailsToShow(ids: string[], onScreen: ReadonlySet<string>, currentId: string | undefined, max: number): Set<string> {
  const current = Math.max(0, ids.indexOf(currentId ?? ''))
  return new Set(ids
    .map((id, index) => ({ id, distance: Math.abs(index - current), index }))
    .filter(({ id }) => onScreen.has(id))
    .sort((a, b) => a.distance - b.distance || a.index - b.index)
    .slice(0, Math.max(0, max))
    .map(({ id }) => id))
}

/** One axis of `scrollToShow`: the scroll offset that brings the item in, moving as little as it can. */
function nearest(viewStart: number, viewSize: number, itemStart: number, itemSize: number, scroll: number) {
  const before = itemStart - viewStart
  const after = itemStart + itemSize - (viewStart + viewSize)
  // Cut off at the start, or too big to fit: line its start up with the view's.
  if (before < 0 || itemSize > viewSize)
    return scroll + before
  if (after > 0)
    return scroll + after
  return scroll
}

/**
 * Where the strip scrolls to show one of its items, the way the browser's
 * "nearest" does: not at all when the item is already in sight, else just
 * far enough for its nearer edge to come in. `view` and `item` are on screen,
 * `scroll` is how far the strip is scrolled now. Works down the side and
 * across a phone alike.
 */
export function scrollToShow(view: ItemRect, item: ItemRect, scroll: { left: number, top: number }): { left: number, top: number } {
  return {
    left: nearest(view.left, view.width, item.left, item.width, scroll.left),
    top: nearest(view.top, view.height, item.top, item.height, scroll.top),
  }
}
