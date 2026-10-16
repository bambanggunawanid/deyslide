import type { CapturedSlide, PreviewSlide, RenderRequest } from '../preview/protocol'
import type { ExportClicks } from './exports'
import { ExportError } from './exports'
import { LAST_CLICKS } from './navigation'

/** A 16:9 page in points (13.33 by 7.5 inches), as the server's PDFs have. */
export const PAGE_WIDTH = 960
export const PAGE_HEIGHT = 540
/** Captures are 1280 by 720 times this: full HD, as the server draws exports. */
export const PDF_PIXEL_RATIO = 1.5

/** Draws one slide at a click step and captures it, as a frame renderer does. */
export interface StepDrawer {
  render: (request: Omit<RenderRequest, 'type' | 'id'>) => Promise<number>
  capture: (pixelRatio?: number) => Promise<CapturedSlide>
}

export interface DevicePdfRequest {
  slides: Pick<PreviewSlide, 'content' | 'frontmatter'>[]
  clicks: ExportClicks
  title: string
  drawer: StepDrawer
  /** Called before each step is drawn: the slide counted from 1, and the share of slides done, from 0 to 1. */
  onProgress?: (slide: number, done: number) => void
}

/**
 * Makes a PDF on this device: every slide (or every click step) drawn in
 * print mode by a preview frame, captured, and put on its own page.
 */
export async function makeDevicePdf({ slides, clicks, title, drawer, onProgress }: DevicePdfRequest): Promise<Uint8Array> {
  const { PDFDocument } = await import('pdf-lib')
  const pdf = await PDFDocument.create()
  pdf.setTitle(title)
  pdf.setCreator('Deyslide')
  const headmatter = slides[0]?.frontmatter ?? {}

  async function page(index: number, at: number) {
    const slide = slides[index]
    let steps: number
    try {
      steps = await drawer.render({
        slide: { content: slide.content, frontmatter: slide.frontmatter, first: index === 0 },
        headmatter,
        clicks: at,
        mode: 'print',
      })
    }
    catch (error) {
      throw new ExportError(`Slide ${index + 1} could not be drawn: ${(error as Error).message}`)
    }
    const captured = await drawer.capture(PDF_PIXEL_RATIO)
    if (!captured.png || captured.error)
      throw new ExportError(`Slide ${index + 1} could not be drawn: ${captured.error ?? 'the picture is empty.'}`)
    const image = await pdf.embedPng(new Uint8Array(captured.png))
    pdf.addPage([PAGE_WIDTH, PAGE_HEIGHT]).drawImage(image, { x: 0, y: 0, width: PAGE_WIDTH, height: PAGE_HEIGHT })
    return steps
  }

  for (const index of slides.keys()) {
    onProgress?.(index + 1, index / slides.length)
    const steps = await page(index, clicks === 'each' ? 0 : LAST_CLICKS)
    if (clicks === 'each') {
      for (let at = 1; at <= steps; at++)
        await page(index, at)
    }
  }
  onProgress?.(slides.length, 1)
  return pdf.save()
}
