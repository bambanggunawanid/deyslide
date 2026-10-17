import type { ParsedDeck, SourceSlide, TextChange } from '@deyslide/deck-model'
import type { Ref } from 'vue'
import type { DeckSession } from '../deck/session'
import {
  deckMarkdown,
  DeckMarkdownError,
  deckSlideTexts,
  joinSlides,
  mergeMarkdown,
  newMergeWriter,
  parseMarkdown,
  slideAtLine,
  slideMarkdowns,
  splitSlides,
  textChanges,
} from '@deyslide/deck-model'
import { computed, ref, shallowRef, watch } from 'vue'
import * as Y from 'yjs'
import { MarkdownOrigin } from '../deck/session'

// The Markdown view edits the same live document as every other view. The
// editor holds plain Markdown; typing merges into the document a moment
// after the last keystroke, against the state the text was last in sync
// with, so whatever others changed meanwhile survives. Changes from anyone
// else come back as small edits to the slides they touched, so the cursor
// stays where it is and untouched slides keep their exact text.

export interface MarkdownProblem {
  kind: 'invalid' | 'typing'
  message: string
}

export interface MarkdownBinding {
  /** The editor text. */
  readonly text: Ref<string>
  readonly problem: Ref<MarkdownProblem | undefined>
  /** True while the editor holds typing that is not in the deck: waiting to merge, or held back by `problem`. */
  readonly pending: Readonly<Ref<boolean>>
  /** Whole text input (tests and the editor double). */
  setText: (text: string) => void
  applyLocalChanges: (changes: TextChange[]) => void
  /** Edits for the editor, made by someone else, against the text before them. Returns a function that stops listening. */
  onPatch: (cb: (changes: TextChange[]) => void) => () => void
  /** Merges pending typing now (synchronous). */
  flush: () => void
  slideIdAtLine: (line: number) => string | undefined
  lineOfSlide: (slideId: string) => number | undefined
  destroy: () => void
}

/** Typing merges this long after the last keystroke. */
export const MERGE_DELAY_MS = 300
/** Others' changes reach the editor at most about this often. */
export const PATCH_INTERVAL_MS = 100

/** Shown while the editor waits for its text to parse before showing others' changes. */
export const WAITING_HINT = 'Fix the error to see others\' changes.'
/** The same, for Markdown that is only half typed. */
export const TYPING_WAITING_HINT = 'Finish this change to see others\' changes.'
/** Shown while a change would join slides the person did not touch, such as a comment opened above them. */
export const HOLD_MESSAGE = 'This change would join slides you did not edit. Close the block or comment you opened to keep it.'
/** Shown when the deck turned read only for good while typing waited to merge. */
export const NOT_KEPT_MESSAGE = 'Your last change was not saved, because this deck is read only now.'
/** Shown when typing leaves the deck as it was, because Slidev reads the new Markdown just like the old. */
export const NO_CHANGE_MESSAGE = 'Deyslide cannot keep this edit: Slidev reads the Markdown just as before, so the deck stays as it was. Undo it or write it another way.'

/** Shown when a slide break line (1 based) holds more than `---`. Slidev ignores the rest, so the deck cannot keep it. */
export function slideBreakMessage(line: number) {
  return `Line ${line} is a slide break, and Slidev ignores anything after its ---. Keep --- alone on that line.`
}

interface SlideText {
  id: string
  markdown: string
}

/** Applies changes that all refer to `text` as it was before any of them. */
function applyChanges(text: string, changes: TextChange[]) {
  let result = ''
  let position = 0
  for (const change of changes) {
    result += text.slice(position, change.from) + change.insert
    position = change.to
  }
  return result + text.slice(position)
}

/** Slides as Slidev splits the text, or none when it cannot. */
function splitOrNone(text: string): SourceSlide[] {
  try {
    return splitSlides(text)
  }
  catch {
    return []
  }
}

/** Where each line starts. */
function lineStarts(text: string) {
  const starts = [0]
  for (let index = text.indexOf('\n'); index !== -1; index = text.indexOf('\n', index + 1))
    starts.push(index + 1)
  return starts
}

/** Each slide's text as a range of the editor text. The text between two ranges is the separator. */
function slideRanges(text: string, slides: SourceSlide[]) {
  const starts = lineStarts(text)
  return slides.map(({ start, end }) => ({
    from: starts[start] ?? text.length,
    to: end < starts.length ? starts[end] - 1 : text.length,
  }))
}

/**
 * A part of the editor text typed since the text last matched the deck
 * (`from` to `to`), and the part of that older text it replaced
 * (`syncedFrom` to `syncedTo`). Everything between two typed parts is
 * the older text, untouched.
 */
interface TypedRange {
  from: number
  to: number
  syncedFrom: number
  syncedTo: number
}

/** Adds one edit, made to the editor text as it is now, to the typed parts. */
function recordTyping(typed: TypedRange[], { from, to, insert }: TextChange) {
  if (from === to && insert === '')
    return
  const shift = insert.length - (to - from)
  // Typed parts the edit overlaps or meets become one with it.
  let first = typed.findIndex(range => range.to >= from)
  if (first === -1)
    first = typed.length
  let last = first
  while (last < typed.length && typed[last].from <= to)
    last++
  const before = typed[first - 1]
  const touched = typed.slice(first, last)
  const start = touched[0] && touched[0].from <= from ? touched[0] : undefined
  const end = touched.at(-1) && touched.at(-1)!.to >= to ? touched.at(-1) : undefined
  /** Where an untouched position of the editor text was in the older text, from the typed part before it. */
  const older = (position: number, prior?: TypedRange) => prior ? position - prior.to + prior.syncedTo : position
  const joined: TypedRange = {
    from: start ? start.from : from,
    to: (end ? end.to : to) + shift,
    syncedFrom: start ? start.syncedFrom : older(from, before),
    syncedTo: end ? end.syncedTo : older(to, touched.at(-1) ?? before),
  }
  typed.splice(first, last - first, joined)
  for (const range of typed.slice(first + 1)) {
    range.from += shift
    range.to += shift
  }
}

/**
 * The first slide break line (1 based) that holds more than `---`, such as
 * `---x`. Slidev reads it as a plain `---` and drops the rest, so the deck
 * never has that text.
 */
function longSlideBreak(text: string): number | undefined {
  const slides = splitOrNone(text)
  const lines = text.split(/\r?\n/)
  const breaks: number[] = []
  for (const [index, slide] of slides.entries()) {
    // The line that ended the slide before, and the line this one starts on when it is a `---`.
    if (index > 0)
      breaks.push(slides[index - 1].end)
    if (lines[slide.start]?.startsWith('---'))
      breaks.push(slide.start)
  }
  const line = breaks.sort((a, b) => a - b).find(at => lines[at] !== undefined && lines[at].trimEnd() !== '---')
  return line === undefined ? undefined : line + 1
}

/** The text without its spaces and line breaks. */
const withoutSpaces = (text: string) => text.replace(/\s+/g, '')

/** Where each slide break (the `---` line after a slide) starts in a text. */
function slideBreaks(text: string) {
  const lines = lineStarts(text)
  return splitOrNone(text).slice(0, -1).map(slide => lines[slide.end] ?? text.length)
}

/**
 * True when a slide break of `synced` that nobody typed in or next to is
 * no longer a slide break in `text`: a comment or block opened while
 * typing reached into slides the person did not touch.
 */
function joinsUntouchedSlides(synced: string, text: string, typed: TypedRange[]) {
  const kept = new Set(slideBreaks(text))
  for (const at of slideBreaks(synced)) {
    // The `---` line with the line breaks around it.
    const lineEnd = synced.indexOf('\n', at)
    const from = Math.max(at - 1, 0)
    const to = lineEnd === -1 ? synced.length : lineEnd + 1
    if (typed.some(range => range.syncedFrom < to && range.syncedTo > from))
      continue
    const prior = typed.findLast(range => range.syncedTo <= from)
    if (!kept.has(prior ? at - prior.syncedTo + prior.to : at))
      return true
  }
  return false
}

/** Pairs of positions in `a` and `b` holding the same id, in order, as many as possible. */
function alignIds(a: string[], b: string[]): [number, number][] {
  if (a.length === b.length && a.every((id, index) => id === b[index]))
    return a.map((_, index) => [index, index])
  const width = b.length + 1
  const table = new Int32Array((a.length + 1) * width)
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      table[i * width + j] = a[i] === b[j]
        ? table[(i + 1) * width + j + 1] + 1
        : Math.max(table[(i + 1) * width + j], table[i * width + j + 1])
    }
  }
  const pairs: [number, number][] = []
  let i = 0
  let j = 0
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      pairs.push([i, j])
      i++
      j++
    }
    else if (table[(i + 1) * width + j] >= table[i * width + j + 1]) {
      i++
    }
    else {
      j++
    }
  }
  return pairs
}

/**
 * Edits that bring the changes from `base` to `theirs` into `mine`, which
 * is `base` as the editor shows it: with typing not merged yet, or with
 * spaces the deck does not keep, such as one typed at the end of a line.
 * Those stay. When both touch the same text, `mine` becomes `theirs`.
 */
function rebased(base: string, mine: string, theirs: string): TextChange[] {
  if (mine === base)
    return textChanges(mine, theirs)
  const own = textChanges(base, mine)
  const edits: TextChange[] = []
  let shift = 0
  let next = 0
  for (const change of textChanges(base, theirs)) {
    // The editor's own changes before this one move it.
    while (next < own.length && own[next].to <= change.from) {
      shift += own[next].insert.length - (own[next].to - own[next].from)
      next++
    }
    // An insert counts as one character wide here, so text typed inside the other's change is a clash.
    const overlaps = next < own.length && own[next].from < Math.max(change.to, change.from + 1) && change.from < Math.max(own[next].to, own[next].from + 1)
    if (overlaps)
      return textChanges(mine, theirs)
    edits.push({ from: change.from + shift, to: change.to + shift, insert: change.insert })
  }
  return edits
}

/** The separator Slidev's own joining puts before a slide that is not the first. */
function separatorFor(markdown: string) {
  if (markdown.startsWith('---'))
    return '\n'
  return markdown.startsWith('\n') ? '\n---\n' : '\n---\n\n'
}

/**
 * Edits that turn the editor's slides (`known`, in the editor's order) into
 * the document's (`live`): small diffs inside changed slides, whole slides
 * added or removed with their separators. Slides that did not change keep
 * their exact text. Undefined when the slides cannot be matched to the
 * text, or the first slide goes or gets something in front of it.
 */
function slideEdits(text: string, known: SlideText[], live: SlideText[]): TextChange[] | undefined {
  const slides = splitOrNone(text)
  if (slides.length !== known.length || known.length === 0)
    return undefined
  const ranges = slideRanges(text, slides)
  const pairs = alignIds(known.map(slide => slide.id), live.map(slide => slide.id))
  if (pairs[0]?.[0] !== 0 || pairs[0][1] !== 0)
    return undefined
  const edits: TextChange[] = []
  const keptAt = new Map(pairs)
  // Slides new to the editor go after the kept slide in front of them.
  const insertsAfter = new Map<number, string>()
  let previous = 0
  let pair = 0
  for (const [index, slide] of live.entries()) {
    if (pairs[pair]?.[1] === index) {
      previous = pairs[pair][0]
      pair++
      continue
    }
    insertsAfter.set(previous, (insertsAfter.get(previous) ?? '') + separatorFor(slide.markdown) + slide.markdown)
  }
  for (const [index, range] of ranges.entries()) {
    const match = keptAt.get(index)
    if (match === undefined) {
      // Gone, with the separator before it. The first slide always stays (see above).
      edits.push({ from: ranges[index - 1].to, to: range.to, insert: '' })
    }
    else if (known[index].markdown !== live[match].markdown) {
      for (const change of rebased(known[index].markdown, text.slice(range.from, range.to), live[match].markdown))
        edits.push({ from: change.from + range.from, to: change.to + range.from, insert: change.insert })
    }
    const inserted = insertsAfter.get(index)
    if (inserted)
      edits.push({ from: range.to, to: range.to, insert: inserted })
  }
  // Edits that touch become one, so none overlap.
  const merged: TextChange[] = []
  for (const edit of edits) {
    const last = merged.at(-1)
    if (last && edit.from <= last.to)
      merged[merged.length - 1] = { from: last.from, to: Math.max(last.to, edit.to), insert: last.insert + edit.insert }
    else
      merged.push({ ...edit })
  }
  return merged
}

/** The slides of an encoded deck state. */
function slidesOfState(state: Uint8Array) {
  const doc = new Y.Doc()
  try {
    Y.applyUpdate(doc, state)
    return slideMarkdowns(doc)
  }
  finally {
    doc.destroy()
  }
}

/** Binds a Markdown editor to a deck session. The session must be ready. */
export function createMarkdownBinding(session: DeckSession): MarkdownBinding {
  const { doc } = session
  const origin = new MarkdownOrigin()
  const writer = newMergeWriter()
  const text = ref(deckMarkdown(doc))
  const problem = shallowRef<MarkdownProblem>()
  const listeners = new Set<(changes: TextChange[]) => void>()

  /** The document's slides the editor text matches, by place in the text. */
  let known: SlideText[] = slideMarkdowns(doc)
  /** The editor text when it last matched the document. */
  const syncedText = shallowRef(text.value)
  /** What was typed since then. */
  let typed: TypedRange[] = []
  /** The document state `syncedText` matches. Typing merges against it. */
  let base = Y.encodeStateAsUpdate(doc)
  /** Someone else changed the document since the editor last showed it. */
  let waiting = false
  let mergeTimer: ReturnType<typeof setTimeout> | undefined
  let patchTimer: ReturnType<typeof setTimeout> | undefined
  let patchQueued = false
  let lastPatch = Number.NEGATIVE_INFINITY
  let destroyed = false
  /** Typing was dropped because the deck turned read only. Said until the deck can be changed again. */
  let dropped = false
  let layout: { text: string, slides: SourceSlide[] } = { text: '', slides: [] }

  const pending = computed(() => text.value !== syncedText.value)

  function show(found: MarkdownProblem) {
    const hint = found.kind === 'typing' ? TYPING_WAITING_HINT : WAITING_HINT
    problem.value = waiting ? { kind: found.kind, message: `${found.message} ${hint}` } : found
  }

  /** Hands edits of the editor text to the editor. */
  function emit(edits: TextChange[]) {
    for (const listener of [...listeners])
      listener(edits)
  }

  /** The editor and the document agree again: typing merges against `state` from now on. */
  function settle(slides: SlideText[], state: Uint8Array) {
    known = slides
    syncedText.value = text.value
    typed = []
    base = state
    waiting = false
    problem.value = dropped ? { kind: 'invalid', message: NOT_KEPT_MESSAGE } : undefined
  }

  /** Brings the editor to the document's slides with small edits, and moves the base along. */
  function showDocument() {
    const live = slideMarkdowns(doc)
    const before = text.value
    let edits = slideEdits(before, known, live)
    let after = edits && applyChanges(before, edits)
    if (!edits || splitOrNone(after!).length !== live.length) {
      after = joinSlides(live.map(slide => slide.markdown))
      edits = textChanges(before, after)
    }
    text.value = after!
    // Settled first, so the editor's cursor maps to the new slides when it moves.
    settle(live, Y.encodeStateAsUpdate(doc))
    if (edits.length > 0)
      emit(edits)
  }

  /** Puts the editor back to the text it had when it last matched the document, then shows what waited. */
  function revert() {
    clearTimeout(mergeTimer)
    mergeTimer = undefined
    const before = text.value
    if (before !== syncedText.value) {
      text.value = syncedText.value
      typed = []
      emit(textChanges(before, syncedText.value))
    }
    problem.value = undefined
    if (waiting)
      showDocument()
  }

  function flush() {
    clearTimeout(mergeTimer)
    mergeTimer = undefined
    const current = text.value
    const synced = syncedText.value
    if (current === synced) {
      // Back to the text the document had, by hand: show what others changed meanwhile.
      problem.value = undefined
      if (waiting && !destroyed)
        showDocument()
      return
    }
    // Nothing typed now could be kept: not synced yet, view only or failed.
    if (session.readOnly.value)
      return
    let parsed: ParsedDeck
    try {
      parsed = parseMarkdown(current)
    }
    catch (error) {
      if (error instanceof DeckMarkdownError)
        return show({ kind: error.kind, message: error.message })
      throw error
    }
    const longBreak = longSlideBreak(current)
    if (longBreak !== undefined)
      return show({ kind: 'invalid', message: slideBreakMessage(longBreak) })
    if (joinsUntouchedSlides(synced, current, typed))
      return show({ kind: 'typing', message: HOLD_MESSAGE })
    const meant = deckSlideTexts(parsed.deck, { ids: false })
    // Typing that the deck reads as no change at all would show text the deck
    // does not have. Spaces and blank lines are the person's own way of writing and
    // stay, as anywhere else; anything more waits, and says why.
    const unchanged = known.length === meant.length && known.every((slide, index) => slide.markdown === meant[index])
    if (unchanged && withoutSpaces(current) !== withoutSpaces(synced))
      return show({ kind: 'invalid', message: NO_CHANGE_MESSAGE })
    const { textBase, liveState } = mergeMarkdown(doc, base, current, origin, { writer })
    const live = slideMarkdowns(doc)
    if (live.length === meant.length && live.every((slide, index) => slide.markdown === meant[index])) {
      settle(live, liveState)
      return
    }
    // Someone else's change came in too. The editor shows it now.
    known = slidesOfState(textBase)
    showDocument()
  }

  function patch() {
    patchQueued = false
    patchTimer = undefined
    if (destroyed || !waiting)
      return
    lastPatch = Date.now()
    if (text.value !== syncedText.value) {
      // Typing first, merged three ways, so nothing anyone typed is reverted.
      // While the text does not parse, the editor keeps waiting, and says so.
      flush()
      return
    }
    showDocument()
  }

  function schedulePatch() {
    if (patchQueued || patchTimer !== undefined)
      return
    const wait = lastPatch + PATCH_INTERVAL_MS - Date.now()
    if (wait <= 0) {
      patchQueued = true
      queueMicrotask(patch)
    }
    else {
      patchTimer = setTimeout(patch, wait)
    }
  }

  const onUpdate = (_update: Uint8Array, from: unknown) => {
    if (from === origin)
      return
    waiting = true
    schedulePatch()
  }
  doc.on('update', onUpdate)
  const unregister = session.registerFlush(flush, { pending, revert })
  // Typing held while nothing could be kept merges once it can. A deck that
  // turned read only for good (view only now, or a failure) never takes it:
  // the editor shows the deck again and says the change was not saved. One
  // read only for a while (connecting, or its file is missing from disk for
  // a moment) keeps the typing until it can take it.
  const access = computed(() => {
    if (!session.readOnly.value)
      return 'writable'
    return session.status.value === 'connecting' || session.readOnlyForNow.value ? 'waiting' : 'never'
  })
  const stopWatching = watch(access, (now) => {
    if (now === 'writable' && dropped) {
      dropped = false
      problem.value = undefined
    }
    if (!pending.value || now === 'waiting')
      return
    if (now === 'writable') {
      flush()
      return
    }
    dropped = true
    revert()
    problem.value = { kind: 'invalid', message: NOT_KEPT_MESSAGE }
  })

  function applyLocalChanges(changes: TextChange[]) {
    if (destroyed || changes.length === 0)
      return
    // Edits all refer to the text before them, so the last goes first.
    for (const change of [...changes].reverse())
      recordTyping(typed, change)
    text.value = applyChanges(text.value, changes)
    clearTimeout(mergeTimer)
    mergeTimer = setTimeout(flush, MERGE_DELAY_MS)
  }

  function slidesOfText() {
    if (layout.text !== text.value)
      layout = { text: text.value, slides: splitOrNone(text.value) }
    return layout.slides
  }

  return {
    text,
    problem,
    pending,
    setText(next) {
      if (next !== text.value)
        applyLocalChanges(textChanges(text.value, next))
    },
    applyLocalChanges,
    onPatch(cb) {
      listeners.add(cb)
      return () => {
        listeners.delete(cb)
      }
    },
    flush,
    slideIdAtLine(line) {
      const slides = slidesOfText()
      if (slides.length === 0 || known.length === 0)
        return known[0]?.id
      return known[Math.min(slideAtLine(slides, line), known.length - 1)]?.id
    },
    lineOfSlide(slideId) {
      const index = known.findIndex(slide => slide.id === slideId)
      if (index === -1)
        return undefined
      const slides = slidesOfText()
      return slides[Math.min(index, slides.length - 1)]?.start
    },
    destroy() {
      if (destroyed)
        return
      if (pending.value)
        flush()
      destroyed = true
      clearTimeout(mergeTimer)
      clearTimeout(patchTimer)
      doc.off('update', onUpdate)
      unregister()
      stopWatching()
      listeners.clear()
    },
  }
}
