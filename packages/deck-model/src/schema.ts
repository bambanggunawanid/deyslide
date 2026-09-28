import { z } from 'zod'

/**
 * Slidev's default canvas. Element positions use these units, which is what
 * `<v-drag pos="x,y,w,h,rotate">` expects.
 */
export const CANVAS_WIDTH = 980
export const CANVAS_HEIGHT = CANVAS_WIDTH * 9 / 16

export const DECK_VERSION = 1

const Vec3Schema = z.tuple([z.number(), z.number(), z.number()])

export const PositionSchema = z.strictObject({
  x: z.number(),
  y: z.number(),
  w: z.number().nonnegative(),
  /** null lets the element grow with its content, like Slidev's auto height. */
  h: z.number().nonnegative().nullable(),
  rotate: z.number(),
})

const IdSchema = z.string().min(1)

export const TextElementSchema = z.strictObject({
  id: IdSchema,
  type: z.literal('text'),
  pos: PositionSchema,
  markdown: z.string(),
})

export const ImageElementSchema = z.strictObject({
  id: IdSchema,
  type: z.literal('image'),
  pos: PositionSchema,
  src: z.string().min(1),
  alt: z.string(),
})

export const ShapeElementSchema = z.strictObject({
  id: IdSchema,
  type: z.literal('shape'),
  pos: PositionSchema,
  props: z.strictObject({
    shape: z.enum(['rect', 'ellipse']),
    fill: z.string().optional(),
    stroke: z.string().optional(),
    strokeWidth: z.number().nonnegative().optional(),
  }),
})

export const CodeStepSchema = z.strictObject({
  lang: z.string().regex(/^[^\s`]*$/, 'A language name has no spaces or backticks'),
  code: z.string(),
})

const FENCE_LINE = /^```/m

export const CodeElementSchema = z.strictObject({
  id: IdSchema,
  type: z.literal('code'),
  pos: PositionSchema,
  /**
   * One step is a plain code block. Several steps become a Shiki Magic Move,
   * which Slidev only reads with a 4 backtick outer fence and 3 backtick steps,
   * so a step there cannot contain a line starting with three backticks.
   */
  steps: z.array(CodeStepSchema).min(1).refine(
    steps => steps.length === 1 || steps.every(step => !FENCE_LINE.test(step.code)),
    'Magic Move steps cannot contain a line starting with ```',
  ),
})

export const Scene3DElementSchema = z.strictObject({
  id: IdSchema,
  type: z.literal('scene3d'),
  pos: PositionSchema,
  props: z.strictObject({
    cameraPosition: Vec3Schema.optional(),
    target: Vec3Schema.optional(),
    focus: z.string().optional(),
    zoomLevel: z.number().optional(),
    orbitControls: z.boolean().optional(),
    model: z.string().optional(),
    sceneId: z.string().optional(),
    smoothing: z.number().optional(),
    spin: z.number().optional(),
    transparent: z.boolean().optional(),
  }),
})

export const AlgoPlayerElementSchema = z.strictObject({
  id: IdSchema,
  type: z.literal('algo-player'),
  pos: PositionSchema,
  props: z.strictObject({
    src: z.string().min(1),
    autoplay: z.boolean().optional(),
    loop: z.boolean().optional(),
    controls: z.boolean().optional(),
    quality: z.number().optional(),
  }),
})

export const SandboxValueSchema = z.union([z.boolean(), z.number(), z.string()])

export const SandboxElementSchema = z.strictObject({
  id: IdSchema,
  type: z.literal('sandbox'),
  pos: PositionSchema,
  props: z.strictObject({
    initial: z.record(z.string(), SandboxValueSchema),
    title: z.string().optional(),
    step: z.number().optional(),
    inspector: z.boolean().optional(),
  }),
})

/**
 * Markdown the model does not understand, kept byte for byte.
 * It has no position: it flows in the slide the way Slidev lays it out.
 */
export const RawElementSchema = z.strictObject({
  id: IdSchema,
  type: z.literal('raw'),
  markdown: z.string(),
})

export const ElementSchema = z.discriminatedUnion('type', [
  TextElementSchema,
  ImageElementSchema,
  ShapeElementSchema,
  CodeElementSchema,
  Scene3DElementSchema,
  AlgoPlayerElementSchema,
  SandboxElementSchema,
  RawElementSchema,
])

export const SlideSchema = z.strictObject({
  id: IdSchema,
  /** Slidev frontmatter. On the first slide it also holds the deck headmatter. */
  frontmatter: z.record(z.string(), z.unknown()),
  elements: z.array(ElementSchema),
  notes: z.string().optional(),
})

export const DeckSchema = z.strictObject({
  version: z.literal(DECK_VERSION),
  slides: z.array(SlideSchema).min(1),
})

export type Position = z.infer<typeof PositionSchema>
export type TextElement = z.infer<typeof TextElementSchema>
export type ImageElement = z.infer<typeof ImageElementSchema>
export type ShapeElement = z.infer<typeof ShapeElementSchema>
export type CodeStep = z.infer<typeof CodeStepSchema>
export type CodeElement = z.infer<typeof CodeElementSchema>
export type Scene3DElement = z.infer<typeof Scene3DElementSchema>
export type AlgoPlayerElement = z.infer<typeof AlgoPlayerElementSchema>
export type SandboxElement = z.infer<typeof SandboxElementSchema>
export type RawElement = z.infer<typeof RawElementSchema>
export type DeckElement = z.infer<typeof ElementSchema>
export type PositionedElement = Exclude<DeckElement, RawElement>
export type Slide = z.infer<typeof SlideSchema>
export type Deck = z.infer<typeof DeckSchema>

/** Validates unknown input, for example a deck loaded from storage. */
export function parseDeck(input: unknown): Deck {
  return DeckSchema.parse(input)
}

export function safeParseDeck(input: unknown) {
  return DeckSchema.safeParse(input)
}
