import type { AttributeNode, DirectiveNode, ElementNode } from '@vue/compiler-dom'
import type {
  AlgoPlayerElement,
  CodeStep,
  Deck,
  DeckElement,
  PositionedElement,
  Scene3DElement,
  ShapeElement,
  Slide,
} from './schema.ts'
import { parseSync, stringify } from '@slidev/parser/core'
import { NodeTypes, parse as parseTemplate } from '@vue/compiler-dom'
import { stringify as stringifyYaml } from 'yaml'
import { formatPos, parsePos } from './position.ts'
import {
  AlgoPlayerElementSchema,
  DECK_VERSION,
  DeckSchema,
  ElementSchema,
  SandboxElementSchema,
  Scene3DElementSchema,
  ShapeElementSchema,
} from './schema.ts'

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

function escapeStatic(value: string) {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')
}

function escapeBound(json: string) {
  return json.replace(/&/g, '&amp;').replace(/'/g, '&#39;')
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
      return element.markdown.trim()
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

export function elementToMarkdown(element: DeckElement): string {
  if (element.type === 'raw')
    return element.markdown
  const open = `<v-drag pos="${formatPos(element.pos)}" data-id="${escapeStatic(element.id)}">`
  return `${open}\n\n${formatElementBody(element)}\n\n</v-drag>`
}

export interface ToMarkdownOptions {
  /**
   * Writes each slide's id into its frontmatter, so ids survive a round trip.
   * Editors that show Markdown to people turn this off to keep it clean.
   * @default true
   */
  ids?: boolean
}

/** Builds the slide text the same way Slidev's own `prettifySlide` does. */
function slideRaw(slide: Slide, { ids = true }: ToMarkdownOptions) {
  const frontmatter = ids ? { ...slide.frontmatter, [SLIDE_ID_KEY]: slide.id } : { ...slide.frontmatter }
  const hasFrontmatter = Object.keys(frontmatter).length > 0
  const content = slide.elements.map(elementToMarkdown).join('\n\n').trim()
  let raw = hasFrontmatter ? `---\n${stringifyYaml(frontmatter).trim()}\n---\n` : ''
  if (content)
    raw += `\n${content}\n`
  if (slide.notes?.trim())
    raw += `\n<!--\n${slide.notes.trim()}\n-->\n`
  return raw
}

export function toMarkdown(deck: Deck, options: ToMarkdownOptions = {}): string {
  const valid = DeckSchema.parse(deck)
  const slides = valid.slides.map(slide => ({ raw: slideRaw(slide, options) }))
  return stringify({ slides } as Parameters<typeof stringify>[0])
}

// Parsing --------------------------------------------------------------------

const V_DRAG_BLOCK = /^<v-drag\b[^>]*>[\s\S]*?^<\/v-drag>[ \t]*$/gm
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
    // anything unusual (options, extra lines) stays raw instead of changing.
    return steps.length > 1 && formatCode(steps) === body ? steps : undefined
  }
  const single = body.match(SINGLE_FENCE)
  return single ? [{ lang: single[2], code: single[3] }] : undefined
}

/** Turns the inside of a `v-drag` block into an element, or undefined if the model cannot represent it. */
function parseElementBody(id: string, pos: PositionedElement['pos'], body: string): PositionedElement | undefined {
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

function parseVDrag(block: string, fallbackId: string): PositionedElement | undefined {
  const openEnd = block.indexOf('>') + 1
  const open = singleElement(`${block.slice(0, openEnd)}</v-drag>`)
  const attributes = open && readAttributes(open)
  if (!attributes || typeof attributes.pos !== 'string')
    return undefined
  const pos = parsePos(attributes.pos)
  if (!pos)
    return undefined
  const id = typeof attributes.dataId === 'string' && attributes.dataId ? attributes.dataId : fallbackId
  const body = block.slice(openEnd, block.lastIndexOf('</v-drag>')).trim()
  return parseElementBody(id, pos, body)
}

/**
 * Splits slide content into elements. Every `v-drag` block the model
 * understands becomes an element; everything else is kept verbatim as raw.
 */
export function parseSlideContent(content: string, slideId: string): DeckElement[] {
  const elements: DeckElement[] = []
  let rawCount = 0
  let positionedCount = 0
  const pushRaw = (markdown: string) => {
    const trimmed = markdown.trim()
    if (trimmed)
      elements.push({ id: `${slideId}:raw:${++rawCount}`, type: 'raw', markdown: trimmed })
  }

  let cursor = 0
  for (const match of content.matchAll(V_DRAG_BLOCK)) {
    pushRaw(content.slice(cursor, match.index))
    const element = parseVDrag(match[0], `${slideId}:el:${positionedCount + 1}`)
    if (element) {
      positionedCount++
      elements.push(element)
    }
    else {
      pushRaw(match[0])
    }
    cursor = match.index + match[0].length
  }
  pushRaw(content.slice(cursor))
  return elements
}

export function fromMarkdown(markdown: string): Deck {
  const parsed = parseSync(markdown, 'slides.md')
  const slides: Slide[] = parsed.slides.map((source, index) => {
    const { [SLIDE_ID_KEY]: storedId, ...frontmatter } = source.frontmatter ?? {}
    const id = typeof storedId === 'string' && storedId ? storedId : `slide-${index + 1}`
    const slide: Slide = { id, frontmatter, elements: parseSlideContent(source.content, id) }
    if (source.note?.trim())
      slide.notes = source.note.trim()
    return slide
  })
  return DeckSchema.parse({ version: DECK_VERSION, slides })
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
