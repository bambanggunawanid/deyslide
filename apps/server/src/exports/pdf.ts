import type { FileHandle } from 'node:fs/promises'
import type { PDFObject, PDFRef } from 'pdf-lib'
import type { RenderedSlide, SlideRenderer } from '../mcp/renderer.ts'
import type { ExportSlide } from './media.ts'
import { open } from 'node:fs/promises'
import { concatTransformationMatrix, drawObject, PDFCrossRefSection, PDFDocument, PDFHeader, PDFTrailer, PDFTrailerDict, popGraphicsState, pushGraphicsState } from 'pdf-lib'
import { RendererBusyError } from '../mcp/renderer.ts'
import { ExportError, mediaFor } from './media.ts'

/** The size exports draw slides at. */
export const EXPORT_WIDTH = 1920
export const EXPORT_HEIGHT = 1080
/** Slides per call to the renderer: the most it takes, and short enough for Claude Code's renders to fit in between. */
export const BATCH_SLIDES = 6
/** Pages in one PDF, click steps included. */
export const MAX_PDF_PAGES = 300
/** The largest PDF. A deck of photos fits; one that would fill the disk does not. */
export const MAX_PDF_BYTES = 500 * 1024 * 1024
/** How long, in all, an export waits for a busy renderer to take its requests. */
export const BUSY_WAIT_MS = 2 * 60_000
/** The first wait after a busy answer. Each next one is twice as long, up to 8 seconds. */
const FIRST_BUSY_PAUSE_MS = 500
const LONGEST_BUSY_PAUSE_MS = 8000
/** A 16:9 page in points: 13.33 by 7.5 inches, a widescreen slide. */
const PAGE_WIDTH = 960
const PAGE_HEIGHT = 540
/** A click number past any slide's last step: the renderer shows the last one. */
const LAST_CLICK = 1000

export interface PdfRequest {
  renderer: SlideRenderer
  slides: ExportSlide[]
  /** `last` gives each slide one page with all of its steps, `each` a page per click step. */
  clicks: 'last' | 'each'
  /** Media links mapped to `data:` URLs, from `inlineMedia`. */
  media: Record<string, string>
  title: string
  /** Where the PDF goes. */
  file: string
  /** The largest file allowed, MAX_PDF_BYTES unless a test sets less. */
  maxBytes?: number
  /** The share drawn so far, from 0 to 1. */
  onProgress: (progress: number) => void
  /** Stops drawing. The error is the signal's reason. */
  signal?: AbortSignal
}

/** A slide at one click step. */
interface Step {
  slide: number
  clicks: number
}

/** The pixel data of a PNG that a PDF can hold as it is: 8 bit RGB or gray, not interlaced. */
export function plainPng(png: Uint8Array): { width: number, height: number, colors: 1 | 3, data: Buffer } | undefined {
  const bytes = Buffer.from(png.buffer, png.byteOffset, png.byteLength)
  if (bytes.length < 8 || bytes.readUInt32BE(0) !== 0x89504E47 || bytes.readUInt32BE(4) !== 0x0D0A1A0A)
    return undefined
  let header: Buffer | undefined
  const data: Buffer[] = []
  for (let offset = 8; offset + 8 <= bytes.length;) {
    const length = bytes.readUInt32BE(offset)
    const type = bytes.toString('latin1', offset + 4, offset + 8)
    const body = bytes.subarray(offset + 8, offset + 8 + length)
    if (type === 'IHDR')
      header = body
    else if (type === 'IDAT')
      data.push(body)
    else if (type === 'IEND')
      break
    offset += length + 12
  }
  // Bit depth 8, color type 2 (RGB) or 0 (gray), no interlacing.
  if (!header || header.length < 13 || header[8] !== 8 || (header[9] !== 2 && header[9] !== 0) || header[12] !== 0 || data.length === 0)
    return undefined
  return { width: header.readUInt32BE(0), height: header.readUInt32BE(4), colors: header[9] === 2 ? 3 : 1, data: Buffer.concat(data) }
}

/** Waits `ms`, or less when the signal stops it. */
function pause(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve) => {
    const done = () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', done)
      resolve()
    }
    const timer = setTimeout(done, ms)
    signal?.addEventListener('abort', done, { once: true })
  })
}

/**
 * Calls the renderer, and calls it again while it answers that it is busy
 * (Claude Code's slide images share its line), waiting longer each time,
 * for up to BUSY_WAIT_MS in all.
 */
export async function whenNotBusy<T>(call: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  const deadline = Date.now() + BUSY_WAIT_MS
  for (let wait = FIRST_BUSY_PAUSE_MS; ; wait = Math.min(wait * 2, LONGEST_BUSY_PAUSE_MS)) {
    signal?.throwIfAborted()
    try {
      return await call()
    }
    catch (error) {
      signal?.throwIfAborted()
      if (!(error instanceof RendererBusyError) || Date.now() + wait > deadline)
        throw error
    }
    await pause(wait, signal)
  }
}

/**
 * A PDF written to disk while it is drawn. Each slide image goes to the
 * file as soon as it arrives, so memory holds one batch of images, never
 * the whole PDF. The pages, their contents and the catalog follow at the
 * end, then the cross reference table.
 */
class PdfFile {
  readonly pdf: PDFDocument
  private readonly handle: FileHandle
  private readonly maxBytes: number
  private size = 0
  /** Where each object written so far starts. */
  private readonly offsets: { ref: PDFRef, offset: number }[] = []
  private readonly written = new Set<number>()

  private constructor(pdf: PDFDocument, handle: FileHandle, maxBytes: number) {
    this.pdf = pdf
    this.handle = handle
    this.maxBytes = maxBytes
  }

  static async create(path: string, title: string, maxBytes: number) {
    const pdf = await PDFDocument.create()
    pdf.setTitle(title)
    pdf.setCreator('Deyslide')
    const file = new PdfFile(pdf, await open(path, 'w'), maxBytes)
    const header = PDFHeader.forVersion(1, 7)
    const bytes = new Uint8Array(header.sizeInBytes() + 2)
    header.copyBytesInto(bytes, 0)
    bytes.set([10, 10], bytes.length - 2)
    await file.append([bytes])
    return file
  }

  /**
   * Puts a slide image in the file and returns its reference. The
   * renderer's PNGs are 8 bit RGB, whose compressed pixel data a PDF reads
   * as it is with the PNG predictor, so nothing is decoded or compressed
   * again: that would hold up the server for a few hundred milliseconds a
   * page. Other PNGs go through pdf-lib.
   */
  async addImage(png: Uint8Array): Promise<PDFRef> {
    const { context } = this.pdf
    const plain = plainPng(png)
    if (plain) {
      const { width, height, colors, data } = plain
      const ref = context.nextRef()
      await this.write(ref, context.stream(data, {
        Type: 'XObject',
        Subtype: 'Image',
        Width: width,
        Height: height,
        ColorSpace: colors === 3 ? 'DeviceRGB' : 'DeviceGray',
        BitsPerComponent: 8,
        Filter: 'FlateDecode',
        DecodeParms: { Predictor: 15, Colors: colors, BitsPerComponent: 8, Columns: width },
      }))
      return ref
    }
    // The objects pdf-lib makes for the image (and its transparency) go to the file now, and leave the document.
    const before = context.largestObjectNumber
    const image = await this.pdf.embedPng(png)
    await image.embed()
    for (const [ref, object] of context.enumerateIndirectObjects()) {
      if (ref.objectNumber > before) {
        await this.write(ref, object)
        context.delete(ref)
      }
    }
    return image.ref
  }

  /** Adds a 16:9 page that the image covers. */
  addPage(image: PDFRef) {
    const page = this.pdf.addPage([PAGE_WIDTH, PAGE_HEIGHT])
    const name = page.node.newXObject('Slide', image)
    page.pushOperators(pushGraphicsState(), concatTransformationMatrix(PAGE_WIDTH, 0, 0, PAGE_HEIGHT, 0, 0), drawObject(name), popGraphicsState())
  }

  /** Writes the rest of the document, the cross reference table and the trailer, then closes the file. */
  async finish() {
    const { context } = this.pdf
    await this.pdf.flush()
    for (const [ref, object] of context.enumerateIndirectObjects()) {
      if (!this.written.has(ref.objectNumber))
        await this.write(ref, object)
    }
    const xref = PDFCrossRefSection.create()
    for (const { ref, offset } of this.offsets.sort((a, b) => a.ref.objectNumber - b.ref.objectNumber))
      xref.addEntry(ref, offset)
    const trailerDict = PDFTrailerDict.of(context.obj({ Size: context.largestObjectNumber + 1, Root: context.trailerInfo.Root, Info: context.trailerInfo.Info }))
    const trailer = PDFTrailer.forLastCrossRefSectionOffset(this.size)
    const bytes = new Uint8Array(xref.sizeInBytes() + 1 + trailerDict.sizeInBytes() + 2 + trailer.sizeInBytes())
    let offset = xref.copyBytesInto(bytes, 0)
    bytes[offset++] = 10
    offset += trailerDict.copyBytesInto(bytes, offset)
    bytes.set([10, 10], offset)
    trailer.copyBytesInto(bytes, offset + 2)
    await this.append([bytes])
    await this.handle.close()
  }

  /** Closes the file, unfinished. */
  async abandon() {
    await this.handle.close().catch(() => {})
  }

  /** Writes an object, as `N 0 obj ... endobj`, the way pdf-lib's own writer does. */
  private async write(ref: PDFRef, object: PDFObject) {
    const body = new Uint8Array(object.sizeInBytes())
    object.copyBytesInto(body, 0)
    this.offsets.push({ ref, offset: this.size })
    this.written.add(ref.objectNumber)
    await this.append([Buffer.from(`${ref.objectNumber} ${ref.generationNumber} obj\n`, 'latin1'), body, Buffer.from('\nendobj\n\n', 'latin1')])
  }

  private async append(parts: Uint8Array[]) {
    this.size += parts.reduce((sum, part) => sum + part.length, 0)
    if (this.size > this.maxBytes)
      throw new ExportError(`The PDF would be larger than ${megabytes(this.maxBytes)} MB. Use smaller images, or export fewer slides.`)
    await this.handle.writev(parts)
  }
}

/** A size in megabytes, with one decimal when it is below 10. */
function megabytes(bytes: number) {
  const value = bytes / 1024 / 1024
  return value < 10 ? Number(value.toFixed(1)) : Math.round(value)
}

/** Splits steps into the renderer's batches. */
function batches(steps: Step[]) {
  return Array.from({ length: Math.ceil(steps.length / BATCH_SLIDES) }, (_, index) => steps.slice(index * BATCH_SLIDES, (index + 1) * BATCH_SLIDES))
}

/**
 * Draws every slide through the renderer, a few at a time, and writes a
 * PDF with one 16:9 page per image. With `each`, every slide is drawn once
 * first: its first image says how many click steps it has, so a PDF with
 * too many pages is refused before the steps are drawn.
 */
export async function drawPdf({ renderer, slides, clicks, media, title, file, maxBytes = MAX_PDF_BYTES, onProgress, signal }: PdfRequest): Promise<void> {
  const output = await PdfFile.create(file, title, maxBytes)
  try {
    /** Each slide's images, by click step. */
    const images: PDFRef[][] = slides.map(() => [])
    /** How many images each slide gets, once its first one says. */
    const steps: (number | undefined)[] = slides.map(() => clicks === 'last' ? 1 : undefined)
    const pages = () => steps.reduce<number>((sum, count) => sum + (count ?? 1), 0)

    const draw = async (batch: Step[]): Promise<RenderedSlide[]> => {
      const used = mediaFor(batch.map(step => slides[step.slide]), media)
      return whenNotBusy(() => renderer.render(batch.map(step => ({
        content: slides[step.slide].content,
        frontmatter: slides[step.slide].frontmatter,
        headmatter: slides[0].frontmatter,
        first: step.slide === 0,
        clicks: step.clicks,
      })), { width: EXPORT_WIDTH, height: EXPORT_HEIGHT, ...(Object.keys(used).length ? { media: used } : {}), ...(signal ? { signal } : {}) }), signal)
    }

    const drawAll = async (all: Step[], onImage: (step: Step, result: RenderedSlide) => void) => {
      for (const batch of batches(all)) {
        const results = await draw(batch)
        signal?.throwIfAborted()
        for (const [index, result] of results.entries()) {
          const step = batch[index]
          if (!result.png || result.error)
            throw new ExportError(`Slide ${step.slide + 1} could not be drawn: ${(result.error ?? 'the renderer sent no image').replace(/\.$/, '')}. Fix it, then export again.`)
          images[step.slide][step.clicks === LAST_CLICK ? 0 : step.clicks] = await output.addImage(Buffer.from(result.png, 'base64'))
          onImage(step, result)
        }
        onProgress(images.reduce((sum, drawn) => sum + drawn.filter(Boolean).length, 0) / pages())
      }
    }

    // Every slide once: its last step, or with every click step its first.
    await drawAll(slides.map((_, slide) => ({ slide, clicks: clicks === 'last' ? LAST_CLICK : 0 })), ({ slide }, result) => {
      if (clicks === 'last')
        return
      steps[slide] = result.clicks + 1
      if (pages() > MAX_PDF_PAGES)
        throw new ExportError(`The PDF would have more than ${MAX_PDF_PAGES} pages. Export the last click step of each slide instead.`)
    })
    // Then the other click steps, slide by slide.
    await drawAll(slides.flatMap((_, slide) => Array.from({ length: (steps[slide] ?? 1) - 1 }, (_, step) => ({ slide, clicks: step + 1 }))), () => {})

    for (const slideImages of images) {
      for (const image of slideImages)
        output.addPage(image)
    }
    await output.finish()
  }
  catch (error) {
    await output.abandon()
    throw error
  }
}
