/**
 * Line scanning that follows Slidev's own splitter (`parseSync` in
 * `@slidev/parser`), and the escapes that keep content written into a slide
 * from changing how the Markdown splits when it is read back.
 *
 * Slidev's splitter, line by line:
 * - inside an HTML comment, a line only moves the comment state;
 * - a line starting with `---` ends the slide;
 * - a line starting with backticks (after spaces) skips to the next line that
 *   starts with the same spaces and backticks, when there is one;
 * - any other line opens or closes HTML comments.
 */

const V_DRAG_OPEN = /^<v-drag\b/
const V_DRAG_CLOSE = /^<\/v-drag>[ \t]*$/
const ESCAPED_V_DRAG_CLOSE = /^ <\/v-drag>[ \t]*$/
/** A `v-drag` opening or closing tag anywhere in a line. */
const V_DRAG_TAG = /<v-drag\b[^>]*>|<\/v-drag\s*>/g
const LEADING_BACKTICKS = /^\s*`+/
const COMMENT_OPEN = '<!--'
const COMMENT_CLOSE = '-->'

/** Slidev's `advanceHtmlCommentState`, also saying where a comment left open on this line starts. */
function advanceComment(line: string, inComment: boolean): { inComment: boolean, openAt: number } {
  let cursor = 0
  while (cursor < line.length) {
    if (inComment) {
      const end = line.indexOf(COMMENT_CLOSE, cursor)
      if (end < 0)
        return { inComment: true, openAt: -1 }
      inComment = false
      cursor = end + 3
    }
    else {
      const start = line.indexOf(COMMENT_OPEN, cursor)
      if (start < 0)
        return { inComment: false, openAt: -1 }
      const end = line.indexOf(COMMENT_CLOSE, start + 4)
      if (end < 0)
        return { inComment: true, openAt: start }
      cursor = end + 3
    }
  }
  return { inComment, openAt: -1 }
}

/** The fence a line opens, with its leading spaces, or undefined. */
function fenceOf(line: string): string | undefined {
  const trimmed = line.trimEnd()
  return trimmed.trimStart().startsWith('```') ? trimmed.match(LEADING_BACKTICKS)![0] : undefined
}

/**
 * A fence CommonMark would also open: its info string has no backticks.
 * A line like "```a``` b" is inline code, even though Slidev's splitter
 * still pairs it with a later fence.
 */
function opensRealFence(line: string) {
  return /^\s*`{3,}[^`]*$/.test(line.trimEnd())
}

/** The line that closes the fence opened on line `index`, the way Slidev finds it. */
function fenceEnd(lines: string[], index: number, fence: string): number | undefined {
  for (let line = index + 1; line < lines.length; line++) {
    if (lines[line].startsWith(fence))
      return line
  }
  return undefined
}

/**
 * How Slidev sees a line: `comment` starts inside an HTML comment, `fence`
 * belongs to a closed code fence, `open-fence` starts a fence nothing closes,
 * and `text` is everything else. Lines starting with `---` count as text
 * here, because that is what they become once escaped.
 */
export type LineKind = 'comment' | 'fence' | 'open-fence' | 'text'

export interface LineScan {
  kinds: LineKind[]
  /** The first real code fence nothing closes, as a line index. */
  openFence?: number
  /** Where the HTML comment still open at the end starts. */
  openComment?: { line: number, column: number }
}

export function scanLines(lines: string[]): LineScan {
  const kinds: LineKind[] = []
  let openFence: number | undefined
  let inComment = false
  let openComment: LineScan['openComment']
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]
    if (inComment) {
      kinds[index] = 'comment'
      const state = advanceComment(line, true)
      inComment = state.inComment
      if (state.openAt >= 0)
        openComment = { line: index, column: state.openAt }
      continue
    }
    const fence = fenceOf(line)
    if (fence !== undefined) {
      const end = fenceEnd(lines, index, fence)
      if (end === undefined) {
        kinds[index] = 'open-fence'
        if (openFence === undefined && opensRealFence(line))
          openFence = index
        continue
      }
      for (; index <= end; index++)
        kinds[index] = 'fence'
      index = end
      continue
    }
    kinds[index] = 'text'
    const state = advanceComment(line, false)
    inComment = state.inComment
    openComment = inComment ? { line: index, column: state.openAt } : undefined
  }
  return { kinds, openFence, openComment: inComment ? openComment : undefined }
}

/**
 * Closes what would otherwise run past the end of the text: an HTML comment
 * left open has its opening written as `&lt;!--`, and a code fence left open
 * gets its closing line. Either would swallow the rest of the deck.
 */
function closeOpenings(lines: string[]): string[] {
  const result = [...lines]
  // Each round closes one fence or escapes one opening, so this many rounds always do.
  const rounds = lines.length + lines.join('\n').split(COMMENT_OPEN).length
  for (let round = 0; round < rounds; round++) {
    const scan = scanLines(result)
    if (scan.openFence !== undefined) {
      result.push(fenceOf(result[scan.openFence])!)
      continue
    }
    if (scan.openComment) {
      const { line, column } = scan.openComment
      const text = result[line]
      result[line] = `${text.slice(0, column)}&lt;!--${text.slice(column + COMMENT_OPEN.length)}`
      continue
    }
    break
  }
  return result
}

function isSeparator(line: string) {
  return line.trimEnd().startsWith('---')
}

function normalizeNewlines(text: string) {
  return text.replace(/\r\n?/g, '\n')
}

/**
 * The body of a text element as written inside its `v-drag` block. Lines
 * Slidev would split the slide on (`---`), and `</v-drag>` lines that would
 * end the block early, get one leading space, which Markdown ignores. A
 * `v-drag` box nested in the text keeps its tags when they pair up. A tag
 * that pairs with nothing in the text, or an opening that never ends (either
 * already breaks the slide's template), is written with `&lt;`, so it shows
 * as text and the block keeps its end. Escaping one never changes how the
 * other tags pair.
 */
export function escapeTextBody(markdown: string): string {
  const opening = closeOpenings(normalizeNewlines(markdown).trim().split('\n'))
  const { kinds } = scanLines(opening)
  // A `</v-drag>` line with one leading space reads back without it, so it
  // is written the way that text would be.
  const lines = opening.map((line, index) => kinds[index] === 'text' && ESCAPED_V_DRAG_CLOSE.test(line) ? line.slice(1) : line)
  const opened: { line: number, at: number }[] = []
  const loose: { line: number, at: number }[] = []
  const spaced = new Set<number>()
  walkTags(lines, {
    closeLine(line) {
      if (!opened.pop())
        spaced.add(line)
    },
    tag(line, tag) {
      if (tag.change > 0)
        opened.push({ line, at: tag.at })
      else if (!opened.pop())
        loose.push({ line, at: tag.at })
    },
    unfinished(line) {
      loose.push({ line, at: 0 })
    },
  })
  const escaped = [...lines]
  for (const { line, at } of [...loose, ...opened].sort((a, b) => b.line - a.line || b.at - a.at))
    escaped[line] = `${escaped[line].slice(0, at)}&lt;${escaped[line].slice(at + 1)}`
  return escaped
    .map((line, index) => (kinds[index] === 'text' && isSeparator(line)) || spaced.has(index) ? ` ${line}` : line)
    .join('\n')
}

/** Reverses `escapeTextBody` for a body read back from Markdown. */
export function unescapeTextBody(body: string): string {
  const lines = body.split('\n')
  const { kinds } = scanLines(lines)
  return lines
    .map((line, index) => kinds[index] === 'text' && (line.startsWith(' ---') || ESCAPED_V_DRAG_CLOSE.test(line)) ? line.slice(1) : line)
    .join('\n')
}

/** Spaces in place of `length` characters, so offsets in a masked line stay the same. */
function blank(length: number) {
  return ' '.repeat(length)
}

/** A line with its HTML comments blanked out, following `advanceComment`, and the comment state at its end. */
function maskComments(line: string, inComment: boolean): { text: string, inComment: boolean } {
  let text = ''
  let cursor = 0
  while (cursor < line.length) {
    if (inComment) {
      const end = line.indexOf(COMMENT_CLOSE, cursor)
      if (end < 0) {
        text += blank(line.length - cursor)
        break
      }
      text += blank(end + 3 - cursor)
      cursor = end + 3
      inComment = false
      continue
    }
    const start = line.indexOf(COMMENT_OPEN, cursor)
    if (start < 0) {
      text += line.slice(cursor)
      break
    }
    text += line.slice(cursor, start)
    const end = line.indexOf(COMMENT_CLOSE, start + 4)
    if (end < 0) {
      text += blank(line.length - start)
      inComment = true
      break
    }
    text += blank(end + 3 - start)
    cursor = end + 3
  }
  return { text, inComment }
}

/** A line with its inline code spans blanked out: a run of backticks up to the next run of the same length. */
function maskCodeSpans(line: string) {
  const runs = [...line.matchAll(/`+/g)]
  // For each run length, the runs of that length in order, and how far a search has got.
  const byLength = new Map<number, { runs: number[], next: number }>()
  for (const [index, run] of runs.entries()) {
    const same = byLength.get(run[0].length)
    if (same)
      same.runs.push(index)
    else
      byLength.set(run[0].length, { runs: [index], next: 0 })
  }
  let text = ''
  let cursor = 0
  for (let index = 0; index < runs.length; index++) {
    const same = byLength.get(runs[index][0].length)!
    while (same.next < same.runs.length && same.runs[same.next] <= index)
      same.next++
    if (same.next === same.runs.length)
      continue
    const closing = same.runs[same.next]
    const from = runs[index].index
    const to = runs[closing].index + runs[closing][0].length
    text += line.slice(cursor, from) + blank(to - from)
    cursor = to
    index = closing
  }
  return text + line.slice(cursor)
}

/** A `v-drag` tag in a line: where it starts, and +1 when it opens an element or -1 when it closes one. */
interface VDragTag {
  at: number
  change: 1 | -1
}

/**
 * The `v-drag` tags of a line, outside HTML comments and inline code, in
 * order. A self closing tag (`<v-drag ... />`) opens nothing.
 */
function vDragTags(line: string, inComment: boolean): { tags: VDragTag[], inComment: boolean } {
  const masked = maskComments(line, inComment)
  const tags: VDragTag[] = []
  for (const match of maskCodeSpans(masked.text).matchAll(V_DRAG_TAG)) {
    if (match[0].startsWith('</'))
      tags.push({ at: match.index, change: -1 })
    else if (!match[0].endsWith('/>'))
      tags.push({ at: match.index, change: 1 })
  }
  return { tags, inComment: masked.inComment }
}

/** What a walk over lines meets. */
interface TagVisitor {
  /** A line holding only `</v-drag>`, outside comments and code fences. */
  closeLine: (line: number) => void
  /** A tag inside any other line. `start` marks an opening at the start of a line, which may begin a block. */
  tag: (line: number, tag: VDragTag, start: boolean) => void
  /** An opening at the start of a line that never ends, or that another tag interrupts: it is still being typed. */
  unfinished?: (line: number) => void
}

/**
 * Where the opening tag that starts line `open` ends (its `>`), or
 * undefined when it never ends, or another tag or a code fence starts first.
 * The search stops at the first `<` or `>`, so it stays short.
 */
function openingEnd(lines: string[], open: number): { line: number, column: number } | undefined {
  for (let index = open; index < lines.length; index++) {
    const line = lines[index]
    if (index > open && fenceOf(line) !== undefined)
      return undefined
    const from = index === open ? 1 : 0
    const close = line.indexOf('>', from)
    const other = line.indexOf('<', from)
    if (other >= 0 && (close < 0 || other < close))
      return undefined
    if (close >= 0)
      return { line: index, column: close }
  }
  return undefined
}

/**
 * Walks lines from the top the way the reader follows `v-drag` blocks.
 * HTML comments and code fences are skipped, and so is a `</v-drag>` line
 * written with one leading space (an escaped one). An opening at the start
 * of a line may span lines; a self closing one opens nothing. The reader and
 * the text writer both walk with it, so they always agree.
 */
function walkTags(lines: string[], visitor: TagVisitor) {
  let inComment = false
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]
    if (!inComment) {
      if (V_DRAG_CLOSE.test(line)) {
        visitor.closeLine(index)
        continue
      }
      if (ESCAPED_V_DRAG_CLOSE.test(line))
        continue
      const fence = fenceOf(line)
      if (fence !== undefined) {
        index = fenceEnd(lines, index, fence) ?? index
        continue
      }
      if (V_DRAG_OPEN.test(line)) {
        const end = openingEnd(lines, index)
        if (end) {
          const closing = lines[end.line]
          if (closing[end.column - 1] !== '/')
            visitor.tag(index, { at: 0, change: 1 }, true)
          const rest = vDragTags(closing.slice(end.column + 1), false)
          for (const tag of rest.tags)
            visitor.tag(end.line, { at: tag.at + end.column + 1, change: tag.change }, false)
          inComment = rest.inComment
          index = end.line
          continue
        }
        visitor.unfinished?.(index)
      }
    }
    const found = vDragTags(line, inComment)
    for (const tag of found.tags)
      visitor.tag(index, tag, false)
    inComment = found.inComment
  }
}

/** Where a `v-drag` block sits in a text, as offsets. */
export interface VDragBlock {
  /** Offset of the `<` that opens the block. */
  from: number
  /** Offset just after the closing tag and its trailing spaces. */
  to: number
}

export interface VDragScan {
  blocks: VDragBlock[]
  /** Lines (0 based) whose `v-drag` opening nothing closes, outside blocks, comments and code. */
  unclosed: number[]
}

/**
 * Finds `v-drag` blocks: an opening tag at the start of a line, up to the
 * line holding only `</v-drag>` that closes it. Code fences and HTML comments
 * are skipped on the way, as Slidev skips them when it renders the block,
 * and tags pair up the way Vue pairs them: a nested `v-drag` closes first.
 * An opening closed inside a line of content (or a self closing tag) is not a
 * block: Vue closes it there, so it stays as written. An opening that nothing
 * closes is listed in `unclosed`. One pass pairs every tag.
 */
export function vDragBlocks(text: string): VDragScan {
  const lines = text.split('\n')
  const starts: number[] = []
  let offset = 0
  for (const line of lines) {
    starts.push(offset)
    offset += line.length + 1
  }

  /** Openings at the start of a line, in order. */
  const openings: number[] = []
  /** For each of them that something closes: the line of its block's closing tag, or `inline`. */
  const ends = new Map<number, number | 'inline'>()
  const open: { line: number, start: boolean }[] = []
  walkTags(lines, {
    closeLine(line) {
      const opening = open.pop()
      if (opening?.start)
        ends.set(opening.line, line)
    },
    tag(line, tag, start) {
      if (tag.change > 0) {
        open.push({ line, start })
        if (start)
          openings.push(line)
        return
      }
      const opening = open.pop()
      if (opening?.start)
        ends.set(opening.line, 'inline')
    },
    unfinished(line) {
      openings.push(line)
    },
  })

  const blocks: VDragBlock[] = []
  const unclosed: number[] = []
  let blockEnd = -1
  for (const line of openings) {
    // Openings inside a block belong to its content.
    if (line <= blockEnd)
      continue
    const end = ends.get(line)
    if (end === undefined) {
      unclosed.push(line)
    }
    else if (end !== 'inline') {
      blocks.push({ from: starts[line], to: starts[end] + lines[end].length })
      blockEnd = end
    }
  }
  return { blocks, unclosed }
}

/**
 * Raw Markdown as written into a slide. Besides the `---` lines, a
 * `</v-drag>` line that closes no block inside the raw text gets one leading
 * space, and a `<v-drag` opening that nothing closes is written as
 * `&lt;v-drag`, so neither can pair with another element's tag. (Slidev trims
 * the start of a slide's content, which would undo a space on the first line,
 * and a tag left open breaks the slide's template anyway.) An opening closed
 * inside the raw text stays as it is.
 */
export function escapeRaw(markdown: string): string {
  const lines = closeOpenings(normalizeNewlines(markdown).trim().split('\n'))
  const text = lines.join('\n')
  const { blocks, unclosed } = vDragBlocks(text)
  const open = new Set(unclosed)
  const { kinds } = scanLines(lines)
  let offset = 0
  return lines.map((line, index) => {
    const start = offset
    offset += line.length + 1
    if (kinds[index] !== 'text')
      return line
    if (isSeparator(line))
      return ` ${line}`
    if (blocks.some(block => start >= block.from && start < block.to))
      return line
    if (open.has(index))
      return `&lt;${line.slice(1)}`
    return V_DRAG_CLOSE.test(line) ? ` ${line}` : line
  }).join('\n')
}

/**
 * Speaker notes as written inside their HTML comment: `-->` and `<!--` are
 * written as `--&gt;` and `&lt;!--`. Those two escapes typed as they are get
 * one more `amp;`, so reading the notes back always gives the same text.
 */
export function escapeNotes(notes: string): string {
  return normalizeNewlines(notes).trim()
    .replace(/&((?:amp;)*)lt;!--/g, '&amp;$1lt;!--')
    .replace(/--&((?:amp;)*)gt;/g, '--&amp;$1gt;')
    .replace(/-->/g, '--&gt;')
    .replace(/<!--/g, '&lt;!--')
}

/** Reverses `escapeNotes`. */
export function unescapeNotes(notes: string): string {
  return notes
    .replace(/&lt;!--/g, '<!--')
    .replace(/--&gt;/g, '-->')
    .replace(/&amp;((?:amp;)*)lt;!--/g, '&$1lt;!--')
    .replace(/--&amp;((?:amp;)*)gt;/g, '--&$1gt;')
}
