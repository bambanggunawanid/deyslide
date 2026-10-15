import type { AttributeNode, DirectiveNode, ElementNode } from '@vue/compiler-dom'
import type {
  CodeStep,
  Deck,
  DeckElement,
  Position,
  PositionedElement,
  Slide,
} from './schema.ts'
import { parseSync, stringify } from '@slidev/parser/core'
import { NodeTypes, parse as parseTemplate } from '@vue/compiler-dom'
import { isMap, stringify as stringifyYaml } from 'yaml'
import { formatPos, parsePos } from './position.ts'
import {
  escapeNotes,
  escapeRaw,
  escapeTextBody,
  scanLines,
  unescapeNotes,
  unescapeTextBody,
  vDragBlocks,
} from './scan.ts'
import {
  AlgoPlayerElementSchema,
  CodeElementSchema,
  DECK_VERSION,
  DeckSchema,
  ElementSchema,
  SandboxElementSchema,
  Scene3DElementSchema,
  ShapeElementSchema,
} from './schema.ts'
import { zodMessage } from './y-shape.ts'

/**
 * Components the model understands, keyed by tag. Each one maps to an
 * element type whose `props` are written as tag attributes.
 */
const COMPONENTS = {
  'DeyslideShape': { type: 'shape', schema: ShapeElementSchema },
  'DeyslideScene3D': { type: 'scene3d', schema: Scene3DElementSchema },
  'DeyslideAlgoPlayer': { type: 'algo-player', schema: AlgoPlayerElementSchema },
  'DeyslideLiveSandbox': { type: 'sandbox', schema: SandboxElementSchema },
} as const

type ComponentTag = keyof typeof COMPONENTS
type ComponentElement = Extract<DeckElement, { props: unknown }>

const TAG_BY_TYPE = Object.fromEntries(
  Object.entries(COMPONENTS).map(([tag, { type }]) => [type, tag]),
) as Record<ComponentElement['type'], ComponentTag>

/** The slide frontmatter key that keeps a slide's id across round trips. */
export const SLIDE_ID_KEY = 'id'

// Serializing ----------------------------------------------------------------

function kebab(name: string) {
  return name.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`)
}

/**
 * Attribute values stay on one line and never open an HTML comment, so
 * nothing in them can split a slide.
 */
function escapeStatic(value: string) {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/\n/g, '&#10;').replace(/\r/g, '&#13;')
}

/** Bound JSON never opens a comment or holds a tag, such as a `</v-drag>` that would end its block. */
function escapeBound(json: string) {
  return json.replace(/&/g, '&amp;').replace(/'/g, '&#39;').replace(/</g, '&lt;')
}

/** Strings become static attributes. Everything else is bound as JSON. */
function formatAttributes(props: Record<string, unknown>) {
  return Object.entries(props)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => typeof value === 'string'
      ? `${kebab(key)}="${escapeStatic(value)}"`
      : `:${kebab(key)}='${escapeBound(JSON.stringify(value))}'`)
    .join(' ')
}

/** A fence one backtick longer than any run inside the content. */
function fenceFor(content: string, minimum: number) {
  const longest = Math.max(0, ...[...content.matchAll(/`+/g)].map(match => match[0].length))
  return '`'.repeat(Math.max(minimum, longest + 1))
}

/**
 * One step is a plain fenced block, with a fence long enough for its content.
 * Several steps use the exact fences Slidev's Magic Move expects: 4 backticks
 * outside, 3 for each step.
 */
function formatCode(steps: CodeStep[]) {
  if (steps.length === 1) {
    const [{ lang, code }] = steps
    const fence = fenceFor(code, 3)
    return `${fence}${lang}\n${code}\n${fence}`
  }
  const blocks = steps.map(step => `\`\`\`${step.lang}\n${step.code}\n\`\`\``)
  return `\`\`\`\`md magic-move\n${blocks.join('\n')}\n\`\`\`\``
}

function formatElementBody(element: PositionedElement): string {
  switch (element.type) {
    case 'text':
      return escapeTextBody(element.markdown)
    case 'image':
      return `<img src="${escapeStatic(element.src)}" alt="${escapeStatic(element.alt)}" class="h-full w-full object-contain">`
    case 'code':
      return formatCode(element.steps)
    default: {
      const attributes = formatAttributes(element.props)
      return `<${TAG_BY_TYPE[element.type]}${attributes ? ` ${attributes}` : ''} />`
    }
  }
}

const ANY_POS: Position = { x: 0, y: 0, w: 0, h: null, rotate: 0 }

/** Whether a body is read back as a text element, and not as an image, code or a component. */
function readsAsText(body: string) {
  return parseElementBody('text', ANY_POS, body.trim())?.type === 'text'
}

export function elementToMarkdown(element: DeckElement): string {
  if (element.type === 'raw')
    return escapeRaw(element.markdown)
  const body = formatElementBody(element)
  // A text that looks like an image, code or a component says it is text.
  const type = element.type === 'text' && !readsAsText(body) ? ' data-type="text"' : ''
  // `>` is escaped too: the opening tag ends at the first one.
  const open = `<v-drag pos="${formatPos(element.pos)}" data-id="${escapeStatic(element.id).replace(/>/g, '&gt;')}"${type}>`
  return `${open}\n\n${body}\n\n</v-drag>`
}

export interface ToMarkdownOptions {
  /**
   * Writes each slide's id into its frontmatter, so ids survive a round trip.
   * Editors that show Markdown to people turn this off to keep it clean.
   * @default true
   */
  ids?: boolean
}

/**
 * Frontmatter YAML. Slidev ends a frontmatter block at the first `---` it
 * finds, even inside a value, so when one appears every string is written
 * double quoted with its dashes as `-\x2D-`, which YAML reads back as `---`.
 */
function formatFrontmatter(frontmatter: Record<string, unknown>) {
  const yaml = stringifyYaml(frontmatter).trim()
  if (!yaml.includes('---'))
    return yaml
  return stringifyYaml(frontmatter, { defaultStringType: 'QUOTE_DOUBLE', defaultKeyType: 'QUOTE_DOUBLE', lineWidth: 0 })
    .trim()
    .replace(/---/g, '-\\x2D-')
}

/** Slidev reads a slide that starts with a YAML code block as that slide's frontmatter. */
const YAML_CODE_BLOCK = /^\s*```ya?ml[\s\S]*?```/
const HTML_COMMENT = /<!--[\s\S]*?-->/g
/** An empty frontmatter block. It changes nothing in Slidev but marks where a slide starts. */
const EMPTY_FRONTMATTER = '---\n---\n'
/** An empty HTML comment, which shows nothing. */
const EMPTY_COMMENT = '<!-- -->'

/**
 * How Slidev finds speaker notes in a slide's content: the last HTML comment,
 * when it ends the content. It looks inside code blocks too.
 */
function lastComment(content: string) {
  return [...content.matchAll(HTML_COMMENT)].at(-1)
}

/** Whether the content holds a comment opening that nothing after it closes, as Slidev's notes search sees it. */
function leavesCommentOpen(content: string) {
  const last = lastComment(content)
  return content.includes('<!--', last ? last.index + last[0].length : 0)
}

/**
 * Builds the slide text the same way Slidev's own `prettifySlide` does,
 * wherever the slide is in its deck (see `placeSlide` for the first one).
 */
function slideText(slide: Slide, ids: boolean) {
  const frontmatter = ids ? { ...slide.frontmatter, [SLIDE_ID_KEY]: slide.id } : { ...slide.frontmatter }
  const hasFrontmatter = Object.keys(frontmatter).length > 0
  let content = slide.elements.map(elementToMarkdown).filter(Boolean).join('\n\n')
  const notes = slide.notes ? escapeNotes(slide.notes) : ''
  // An opening left in the content (inside code, say) would pair with the
  // closing of the notes, so an empty comment closes it first.
  if (notes && leavesCommentOpen(content))
    content += `\n\n${EMPTY_COMMENT}`
  let raw = hasFrontmatter ? `---\n${formatFrontmatter(frontmatter)}\n---\n` : ''
  if (content)
    raw += `\n${content}\n`
  if (notes) {
    raw += `\n<!--\n${notes}\n-->\n`
  }
  else {
    // Empty notes keep a comment that ends the content from becoming the notes.
    const last = lastComment(content)
    if (last && last.index + last[0].length >= content.length)
      raw += '\n<!--\n\n-->\n'
  }
  // Slidev reads a leading YAML code block as frontmatter, unless the slide
  // has frontmatter already.
  return !hasFrontmatter && YAML_CODE_BLOCK.test(raw) ? EMPTY_FRONTMATTER + raw : raw
}

/**
 * Recent slide texts without ids, by content: most slides of a deck do not
 * change between two writes. The cache is shared by every deck in the
 * process, so it is bounded by size too: big slides (an inline image, say)
 * are not kept, and the oldest entries go first.
 */
const plainTexts = new Map<string, string>()
const PLAIN_TEXTS_KEPT = 1000
/** Characters of keys and texts kept in all. */
const PLAIN_TEXTS_SIZE = 4_000_000
/** Characters of key and text above which a slide is not kept. */
const PLAIN_TEXT_LARGEST = 100_000
let plainTextsSize = 0

/**
 * A key for a slide's content. Values JSON cannot tell apart (NaN,
 * Infinity, undefined) or cannot write (BigInt) are spelled out.
 */
function contentKey(slide: Slide) {
  return JSON.stringify([slide.frontmatter, slide.elements, slide.notes ?? ''], (_, value) =>
    value === undefined || typeof value === 'bigint' || (typeof value === 'number' && !Number.isFinite(value))
      ? `\u0000${typeof value}:${String(value)}`
      : value)
}

function plainSlideText(slide: Slide) {
  const key = contentKey(slide)
  const kept = plainTexts.get(key)
  if (kept !== undefined) {
    plainTexts.delete(key)
    plainTexts.set(key, kept)
    return kept
  }
  const text = slideText(slide, false)
  const size = key.length + text.length
  if (size > PLAIN_TEXT_LARGEST)
    return text
  plainTexts.set(key, text)
  plainTextsSize += size
  while (plainTexts.size > PLAIN_TEXTS_KEPT || plainTextsSize > PLAIN_TEXTS_SIZE) {
    const [oldest, oldText] = plainTexts.entries().next().value!
    plainTexts.delete(oldest)
    plainTextsSize -= oldest.length + oldText.length
  }
  return text
}

/**
 * Slidev drops an empty first slide when others follow, and trims the start
 * of the file, which would undo an escaped first line. An empty frontmatter
 * block keeps both.
 */
function placeSlide(text: string, index: number, count: number) {
  if (index !== 0 || text.startsWith('---'))
    return text
  return (text === '' && count > 1) || /^\n[ \t]/.test(text) ? EMPTY_FRONTMATTER + text : text
}

function slideRaw(slide: Slide, { ids = true }: ToMarkdownOptions, index: number, count: number) {
  return placeSlide(ids ? slideText(slide, true) : plainSlideText(slide), index, count)
}

function slideRaws(deck: Deck, options: ToMarkdownOptions) {
  return deck.slides.map((slide, index) => slideRaw(slide, options, index, deck.slides.length))
}

export function toMarkdown(deck: Deck, options: ToMarkdownOptions = {}): string {
  return joinSlides(slideRaws(DeckSchema.parse(deck), options))
}

/**
 * One slide's Markdown as `toMarkdown` writes it, before Slidev joins the
 * slides. Two slides with the same text here hold the same content.
 */
export function slideToMarkdown(slide: Slide, { ids = true }: ToMarkdownOptions = {}): string {
  return ids ? slideText(slide, true) : plainSlideText(slide)
}

/**
 * Each slide's text exactly as `slideTexts(toMarkdown(deck, options))` reads
 * it, without writing and splitting the whole deck, so `joinSlides` of the
 * result equals `toMarkdown(deck, options)`. The deck must already be valid.
 */
export function deckSlideTexts(deck: Deck, options: ToMarkdownOptions = {}): string[] {
  const raws = slideRaws(deck, options)
  return raws.map((raw, index) => {
    // Slidev trims the start of the file, and an empty slide reads as a blank
    // line unless it is the last one.
    if (index === 0)
      return raws.length === 1 && raw === '' ? '\n' : raw.trimStart()
    if (raw !== '')
      return raw
    return index === raws.length - 1 ? '' : '\n'
  })
}

// Parsing --------------------------------------------------------------------

const SINGLE_FENCE = /^(`{3,})([^\s`]*)\n([\s\S]*?)\n\1$/
const MAGIC_MOVE = /^````md magic-move\n([\s\S]*)\n````$/
const MAGIC_MOVE_STEPS = /^```([^\s`]*)\n([\s\S]*?)\n```$/gm

function camel(name: string) {
  return name.replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase())
}

/** The only top level element in a template, or undefined when there is not exactly one. */
function singleElement(template: string): ElementNode | undefined {
  let root
  try {
    root = parseTemplate(template)
  }
  catch {
    return undefined
  }
  const nodes = root.children.filter(node => !(node.type === NodeTypes.TEXT && !node.content.trim()))
  const [node] = nodes
  return nodes.length === 1 && node.type === NodeTypes.ELEMENT ? node : undefined
}

/**
 * Reads static attributes as strings and bound attributes as JSON.
 * Returns undefined for anything else, such as a bound JavaScript expression.
 */
function readAttributes(element: ElementNode): Record<string, unknown> | undefined {
  const props: Record<string, unknown> = {}
  for (const prop of element.props as (AttributeNode | DirectiveNode)[]) {
    if (prop.type === NodeTypes.ATTRIBUTE) {
      props[camel(prop.name)] = prop.value?.content ?? ''
      continue
    }
    const arg = prop.arg?.type === NodeTypes.SIMPLE_EXPRESSION && prop.arg.isStatic ? prop.arg.content : undefined
    const expression = prop.exp?.type === NodeTypes.SIMPLE_EXPRESSION ? prop.exp.content : undefined
    if (prop.name !== 'bind' || !arg || expression === undefined)
      return undefined
    try {
      props[camel(arg)] = JSON.parse(expression)
    }
    catch {
      return undefined
    }
  }
  return props
}

function parseCode(body: string): CodeStep[] | undefined {
  const magic = body.match(MAGIC_MOVE)
  if (magic) {
    const steps = [...magic[1].matchAll(MAGIC_MOVE_STEPS)].map(match => ({ lang: match[1], code: match[2] }))
    // Only accept it if writing the steps back gives the same text, so
    // anything unusual (options, extra lines) stays raw instead of changing,
    // and if the steps are valid ones (no fence lines inside).
    return steps.length > 1 && formatCode(steps) === body && CodeElementSchema.shape.steps.safeParse(steps).success ? steps : undefined
  }
  const single = body.match(SINGLE_FENCE)
  return single ? [{ lang: single[2], code: single[3] }] : undefined
}

/** Turns the inside of a `v-drag` block into an element, or undefined if the model cannot represent it. */
function parseElementBody(id: string, pos: Position, body: string): PositionedElement | undefined {
  const steps = body.startsWith('```') ? parseCode(body) : undefined
  if (steps)
    return { id, type: 'code', pos, steps }

  const element = body.startsWith('<') ? singleElement(body) : undefined
  if (element) {
    const attributes = readAttributes(element)
    if (!attributes)
      return undefined
    if (element.tag === 'img') {
      const { src, alt, class: _class, ...rest } = attributes
      const parsed = ElementSchema.safeParse({ id, type: 'image', pos, src, alt: alt ?? '' })
      return Object.keys(rest).length === 0 && parsed.success ? parsed.data as PositionedElement : undefined
    }
    if (element.tag in COMPONENTS) {
      const { type, schema } = COMPONENTS[element.tag as ComponentTag]
      const parsed = schema.safeParse({ id, type, pos, props: attributes })
      return parsed.success ? parsed.data : undefined
    }
  }

  return { id, type: 'text', pos, markdown: body }
}

/** An element read from Markdown, and whether its id was written there. */
interface ReadElement {
  element: DeckElement
  explicitId: boolean
}

/** The attributes the model reads from a `v-drag` opening tag. A tag with any other stays raw, so nothing is dropped. */
const V_DRAG_ATTRIBUTES = new Set(['pos', 'dataId', 'dataType'])

function parseVDrag(block: string, fallbackId: string): ReadElement | undefined {
  const openEnd = block.indexOf('>') + 1
  const open = singleElement(`${block.slice(0, openEnd)}</v-drag>`)
  const attributes = open && readAttributes(open)
  if (!attributes || typeof attributes.pos !== 'string')
    return undefined
  if (Object.keys(attributes).some(name => !V_DRAG_ATTRIBUTES.has(name)) || (attributes.dataType !== undefined && attributes.dataType !== 'text'))
    return undefined
  const pos = parsePos(attributes.pos)
  if (!pos)
    return undefined
  const explicitId = typeof attributes.dataId === 'string' && attributes.dataId !== ''
  const id = explicitId ? attributes.dataId as string : fallbackId
  const body = block.slice(openEnd, block.lastIndexOf('</v-drag>')).trim()
  const element: PositionedElement | undefined = attributes.dataType === 'text'
    ? { id, type: 'text', pos, markdown: body }
    : parseElementBody(id, pos, body)
  if (element?.type === 'text')
    element.markdown = unescapeTextBody(element.markdown)
  return element && { element, explicitId }
}

/**
 * The elements of one slide, with where each id came from, and whether a
 * `v-drag` block holds a code fence nothing closes or a `v-drag` opening
 * outside blocks is never closed.
 */
function readSlideContent(content: string, slideId: string): { elements: ReadElement[], openFence: boolean, openTag: boolean } {
  const elements: ReadElement[] = []
  let rawCount = 0
  let positionedCount = 0
  let openFence = false
  const pushRaw = (markdown: string) => {
    const trimmed = markdown.trim()
    if (trimmed)
      elements.push({ element: { id: `${slideId}:raw:${++rawCount}`, type: 'raw', markdown: trimmed }, explicitId: false })
  }

  const { blocks, unclosed } = vDragBlocks(content)
  let cursor = 0
  for (const block of blocks) {
    pushRaw(content.slice(cursor, block.from))
    const text = content.slice(block.from, block.to)
    const body = text.slice(text.indexOf('>') + 1, text.lastIndexOf('</v-drag>'))
    openFence ||= scanLines(body.split('\n')).openFence !== undefined
    const parsed = parseVDrag(text, `${slideId}:el:${positionedCount + 1}`)
    if (parsed) {
      positionedCount++
      elements.push(parsed)
    }
    else {
      pushRaw(text)
    }
    cursor = block.to
  }
  pushRaw(content.slice(cursor))
  return { elements, openFence, openTag: unclosed.length > 0 }
}

/**
 * Splits slide content into elements. Every `v-drag` block the model
 * understands becomes an element; everything else is kept verbatim as raw.
 */
export function parseSlideContent(content: string, slideId: string): DeckElement[] {
  return readSlideContent(content, slideId).elements.map(item => item.element)
}

type SlidevSlide = ReturnType<typeof parseSync>['slides'][number]

interface ReadSlide {
  source: SlidevSlide
  slide: Slide
  explicit: { slide: boolean, elements: boolean[] }
  /** A code fence inside a `v-drag` block that nothing closes. */
  openFence: boolean
  /** A `v-drag` opening that nothing closes. */
  openTag: boolean
}

function readSlides(markdown: string): ReadSlide[] {
  return parseSync(markdown, 'slides.md').slides.map((source, index) => {
    const { [SLIDE_ID_KEY]: storedId, ...frontmatter } = source.frontmatter ?? {}
    const explicitId = typeof storedId === 'string' && storedId !== ''
    const id = explicitId ? storedId as string : `slide-${index + 1}`
    const { elements, openFence, openTag } = readSlideContent(source.content, id)
    const slide: Slide = { id, frontmatter, elements: elements.map(item => item.element) }
    if (source.note?.trim())
      slide.notes = unescapeNotes(source.note.trim())
    return { source, slide, explicit: { slide: explicitId, elements: elements.map(item => item.explicitId) }, openFence, openTag }
  })
}

export function fromMarkdown(markdown: string): Deck {
  return DeckSchema.parse({ version: DECK_VERSION, slides: readSlides(markdown).map(item => item.slide) })
}

/** Markdown that `parseMarkdown` will not turn into a deck. */
export class DeckMarkdownError extends Error {
  /**
   * `invalid`: the Markdown is wrong (bad YAML, no slides, a deck the format
   * rejects). `typing`: it is probably half typed, like a comment or a code
   * block not closed yet, so views show it softly.
   */
  readonly kind: 'invalid' | 'typing'

  constructor(kind: 'invalid' | 'typing', message: string) {
    super(message)
    this.name = 'DeckMarkdownError'
    this.kind = kind
  }
}

/** A deck read from Markdown, with where each id came from. */
export interface ParsedDeck {
  deck: Deck
  /**
   * Per slide, in deck order: whether the slide id, and each element id,
   * was written in the Markdown (a frontmatter `id`, a `data-id`). Other ids
   * come from their place (`slide-N`, `:raw:N`, `:el:N`) and never match
   * slides or elements.
   */
  explicit: { slide: boolean, elements: boolean[] }[]
}

/** A half typed state: what Slidev would read is probably not what the person means yet. */
function typingProblem(lines: string[], item: ReadSlide): string | undefined {
  const { source } = item
  const number = source.index + 1
  const yaml = source.frontmatterDoc?.contents
  if (yaml && !isMap(yaml))
    return `The frontmatter of slide ${number} is not a list of keys and values.`
  const scan = scanLines(lines.slice(source.contentStart, source.end))
  // A comment opened above the notes swallows them, so the notes then hold an opening.
  if (scan.openComment || source.note?.includes('<!--'))
    return `Slide ${number} has an HTML comment that is not closed. Close it with -->.`
  if (scan.openFence !== undefined || item.openFence)
    return `Slide ${number} has a code block that is not closed.`
  if (item.openTag)
    return `Slide ${number} has a <v-drag> tag that is not closed. Close it with </v-drag>.`
  return undefined
}

/**
 * Reads Markdown with the same rules as `fromMarkdown`, and says where each
 * id came from. Throws a `DeckMarkdownError` instead of reading Markdown that
 * is broken or probably half typed.
 */
export function parseMarkdown(markdown: string): ParsedDeck {
  let slides: ReadSlide[]
  try {
    slides = readSlides(markdown)
  }
  catch (error) {
    // The YAML reader throws on some input, such as too many aliases.
    throw new DeckMarkdownError('invalid', `Deyslide cannot read this deck: ${error instanceof Error ? error.message : String(error)}`)
  }
  const yamlProblems = slides.flatMap(({ source }) =>
    (source.frontmatterDoc?.errors ?? []).map(error => `Slide ${source.index + 1}: ${error.message.split('\n')[0]}`))
  if (yamlProblems.length > 0)
    throw new DeckMarkdownError('invalid', `The frontmatter is not valid YAML. ${yamlProblems.join(' ')}`)
  const lines = markdown.split(/\r?\n/)
  for (const item of slides) {
    const problem = typingProblem(lines, item)
    if (problem)
      throw new DeckMarkdownError('typing', problem)
  }
  if (slides.length === 0)
    throw new DeckMarkdownError('invalid', 'The deck has no slides.')
  const result = DeckSchema.safeParse({ version: DECK_VERSION, slides: slides.map(item => item.slide) })
  if (!result.success)
    throw new DeckMarkdownError('invalid', `Deyslide cannot read this deck: ${zodMessage(result.error)}`)
  return { deck: result.data, explicit: slides.map(item => item.explicit) }
}

// Source slides -----------------------------------------------------------------

/** A slide as Slidev reads it from Markdown, with its place in the text. */
export interface SourceSlide {
  /** First line of the slide, 0 based, including its frontmatter. */
  start: number
  /** The line after the slide. */
  end: number
  frontmatter: Record<string, unknown>
  /** The slide's Markdown without frontmatter and speaker notes. */
  content: string
}

/** Splits Slidev Markdown into slides exactly as Slidev does, for editors and previews. */
export function splitSlides(markdown: string): SourceSlide[] {
  return parseSync(markdown, 'slides.md').slides.map(slide => ({
    start: slide.start,
    end: slide.end,
    frontmatter: slide.frontmatter ?? {},
    content: slide.content,
  }))
}

/** The index of the slide that holds a 0 based line. */
export function slideAtLine(slides: SourceSlide[], line: number): number {
  let index = 0
  for (const [position, slide] of slides.entries()) {
    if (slide.start <= line)
      index = position
  }
  return index
}

/**
 * The full text of each slide, with its frontmatter and speaker notes, as
 * Slidev reads it. The first slide's frontmatter is the deck's headmatter.
 */
export function slideTexts(markdown: string): string[] {
  return parseSync(markdown, 'slides.md').slides.map(slide => slide.raw)
}

/** Joins slide texts into one Markdown document, the reverse of `slideTexts`. */
export function joinSlides(texts: string[]): string {
  return stringify({ slides: texts.map(raw => ({ raw })) } as Parameters<typeof stringify>[0])
}

/**
 * YAML problems in each slide's frontmatter. Slidev skips frontmatter it
 * cannot read instead of failing, so code that writes slides checks here.
 */
export function frontmatterErrors(markdown: string): string[] {
  return parseSync(markdown, 'slides.md').slides.flatMap(slide =>
    (slide.frontmatterDoc?.errors ?? []).map(error => `Slide ${slide.index + 1}: ${error.message.split('\n')[0]}`))
}
