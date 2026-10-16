import type * as Y from 'yjs'
import diff from 'fast-diff'

/** One change against the text before it: replace `from` to `to` with `insert`. */
export interface TextChange {
  from: number
  to: number
  insert: string
}

/**
 * The changes that turn `before` into `after`, in order and never
 * overlapping, with positions in `before`. fast-diff keeps UTF-16 surrogate
 * pairs whole, so no change starts or ends inside an emoji.
 */
export function textChanges(before: string, after: string): TextChange[] {
  const changes: TextChange[] = []
  let position = 0
  for (const [operation, text] of diff(before, after)) {
    if (operation === diff.EQUAL) {
      position += text.length
      continue
    }
    const last = changes.at(-1)
    const change = last && last.to === position ? last : { from: position, to: position, insert: '' }
    if (change !== last)
      changes.push(change)
    if (operation === diff.DELETE) {
      change.to += text.length
      position += text.length
    }
    else {
      change.insert += text
    }
  }
  return changes
}

/**
 * Turns a shared text into `next` with the smallest edits, so typing other
 * people do in the same text at the same time survives. Call it inside the
 * caller's transaction. Returns whether anything changed.
 */
export function applyTextDiff(text: Y.Text, next: string): boolean {
  const changes = textChanges(text.toString(), next)
  // Later changes first, so earlier positions stay valid.
  for (let index = changes.length - 1; index >= 0; index--) {
    const change = changes[index]
    if (change.to > change.from)
      text.delete(change.from, change.to - change.from)
    if (change.insert)
      text.insert(change.from, change.insert)
  }
  return changes.length > 0
}
