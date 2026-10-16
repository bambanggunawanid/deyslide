import type { MarkdownDecks } from '../mcp/decks.ts'
import type { SlideRenderer } from '../mcp/renderer.ts'
import type { MediaStore } from '../media/store.ts'
import type { ProjectStore } from '../projects.ts'
import type { ExportSlide } from './media.ts'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { splitSlides } from '@deyslide/deck-model'
import { checkMarkdown } from '../mcp/decks.ts'
import { RenderError, RendererBusyError, RendererRefusedError, RendererUnavailableError } from '../mcp/renderer.ts'
import { ExportError, inlineMedia } from './media.ts'
import { drawPdf, MAX_PDF_BYTES, whenNotBusy } from './pdf.ts'
import { DEFAULT_DWELL_MS, MAX_VIDEO_MS, VIDEO_TOO_LONG, videoDwellMs, videoLength } from './video.ts'

export type ExportFormat = 'pdf' | 'webm'
export type ExportStatus = 'queued' | 'running' | 'done' | 'failed'

export interface ExportInput {
  /** A deck the person may open, with any role. */
  deckId?: string
  /** Or the deck's Markdown itself. */
  markdown?: string
  format: ExportFormat
  options?: {
    /** `last` (the default for PDF) shows each slide once with all of its steps, `each` every click step (the default for video). */
    clicks?: 'last' | 'each'
    /** Video only: how long each step stays on screen, unless a slide sets `videoDwell` in seconds. */
    dwellMs?: number
  }
}

export interface ExportState {
  status: ExportStatus
  /** From 0 to 1. */
  progress: number
  error?: string
}

/** A finished export, ready to download. */
export interface ExportFile {
  path: string
  name: string
  type: string
  size: number
}

/** Slides in one export. */
export const MAX_EXPORT_SLIDES = 100
/** Exports that run at once on the server. More wait their turn. */
export const MAX_RUNNING = 2
/** Exports one account may have queued or running. */
export const MAX_PER_ACCOUNT = 3
/** Finished exports one account keeps. A newer one replaces the oldest. */
export const MAX_KEPT_PER_ACCOUNT = 3
/** Disk space for finished exports on the server. Past it, new exports wait until older files go. */
export const MAX_STORED_BYTES = 2 * 1024 * 1024 * 1024
/** How long a finished export stays, unless it is downloaded. */
export const KEEP_MS = 60 * 60_000
/** How long a downloaded export stays. */
export const KEEP_AFTER_DOWNLOAD_MS = 10 * 60_000

/** The request asks for more than an export allows. The message says what. */
export class ExportLimitError extends Error {}
/** The account has too many exports under way. */
export class ExportBusyError extends Error {}
/** This server cannot make that kind of export, or not right now. */
export class ExportUnavailableError extends Error {}
/** The export was stopped: the server is shutting down, or the person can no longer see it. */
class ExportStopped extends Error {}

const TYPES: Record<ExportFormat, string> = { pdf: 'application/pdf', webm: 'video/webm' }

/** The name's characters, counted whole, without halves of a broken surrogate pair. */
function characters(text: string) {
  return Array.from(text).filter(char => !/^[\uD800-\uDFFF]$/.test(char))
}

/** A file name for the export: the deck's name without characters file systems refuse. */
export function downloadName(name: string, format: ExportFormat) {
  const cleaned = name.replace(/[\\/:*?"<>|\u0000-\u001F\u007F]+/g, '-').replace(/\s+/g, ' ').trim()
  const base = characters(cleaned).slice(0, 100).join('').trim()
  return `${base || 'Slides'}.${format}`
}

/** Folders of exports start with this, then the process that made them. */
const FOLDER_PREFIX = 'deyslide-exports-'
/** When this process started, the same in each of its threads. */
const PROCESS_START = Math.round(Date.now() - process.uptime() * 1000)

function isRunning(pid: number) {
  try {
    process.kill(pid, 0)
    return true
  }
  catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/**
 * Removes export folders that a process which has ended left behind, for
 * example after a crash. A restarted container often gives the API the
 * same process id again, so a folder with this id from an earlier start
 * goes too.
 */
async function removeLeftovers() {
  const folders = await readdir(tmpdir()).catch(() => [])
  for (const folder of folders) {
    const match = new RegExp(`^${FOLDER_PREFIX}(\\d+)-(\\d+)-`).exec(folder)
    if (!match)
      continue
    const pid = Number(match[1])
    const earlierStart = pid === process.pid && Math.abs(Number(match[2]) - PROCESS_START) > 1000
    if (earlierStart || !isRunning(pid))
      await rm(join(tmpdir(), folder), { recursive: true, force: true })
  }
}

interface Job {
  id: string
  userId: string
  /** The deck exported, when it came from the account: access to it is checked again later. */
  deckId?: string
  format: ExportFormat
  clicks: 'last' | 'each'
  dwellMs: number
  /** The download's file name. */
  name: string
  slides: ExportSlide[]
  status: ExportStatus
  progress: number
  error?: string
  file?: string
  size?: number
  /** Stops the job while it runs. */
  stop?: AbortController
  /** Settles when a running job has finished. */
  running?: Promise<void>
  /** The job was removed while it ran, so its file goes as soon as it ends. */
  forgotten?: boolean
  /** When the job and its file go away, and the timer that does it. */
  removeAt?: number
  timer?: ReturnType<typeof setTimeout>
}

export interface ExportJobsOptions {
  renderer: SlideRenderer
  decks: MarkdownDecks
  /** Checks that a person can still open a deck they export. */
  projects: Pick<ProjectStore, 'deckAccess'>
  /** The media library, when it is on, so slides keep their project images. */
  media?: MediaStore
  /** Smaller limits than MAX_STORED_BYTES and MAX_PDF_BYTES, for tests. */
  limits?: { storedBytes?: number, pdfBytes?: number }
}

/**
 * PDF and video exports, made in the background. Jobs live in memory and
 * their files in a temporary folder: a finished export stays for an hour,
 * or 10 minutes after it is downloaded, and an account keeps its newest
 * three. Each account runs one export at a time, the server two, and the
 * rest wait in order. The renderer records one video at a time, so videos
 * also wait for each other.
 */
export class ExportJobs {
  private readonly renderer: SlideRenderer
  private readonly decks: MarkdownDecks
  private readonly projects: Pick<ProjectStore, 'deckAccess'>
  private readonly media?: MediaStore
  private readonly storedBytesLimit: number
  private readonly pdfBytesLimit: number
  /** In the order they were asked for. */
  private readonly jobs = new Map<string, Job>()
  private folder?: Promise<string>
  private closed = false

  constructor({ renderer, decks, projects, media, limits = {} }: ExportJobsOptions) {
    this.renderer = renderer
    this.decks = decks
    this.projects = projects
    this.media = media
    this.storedBytesLimit = limits.storedBytes ?? MAX_STORED_BYTES
    this.pdfBytesLimit = limits.pdfBytes ?? MAX_PDF_BYTES
  }

  /**
   * Queues an export and returns its id, or undefined when the deck is not
   * the person's to open. Throws `DeckInputError` for Markdown that is not
   * a deck, and the export errors above for requests it cannot take.
   */
  async start(userId: string, input: ExportInput): Promise<string | undefined> {
    if (this.closed)
      throw new ExportUnavailableError('Export is not available on this server.')
    if (input.format === 'webm' && !this.renderer.video)
      throw new ExportUnavailableError('Video export is not available on this server.')
    let markdown: string
    let name: string
    if (input.deckId !== undefined) {
      const found = await this.decks.find(userId, input.deckId)
      const read = found && await this.decks.read({ userId }, input.deckId)
      if (!found || read === undefined)
        return undefined
      markdown = read
      name = found.deck.name
    }
    else {
      markdown = input.markdown ?? ''
      checkMarkdown(markdown)
      name = ''
    }

    const slides = splitSlides(markdown).map(({ content, frontmatter }) => ({ content, frontmatter }))
    if (slides.length === 0)
      throw new ExportLimitError('The deck has no slides.')
    if (slides.length > MAX_EXPORT_SLIDES)
      throw new ExportLimitError(`The deck has ${slides.length} slides. An export can have at most ${MAX_EXPORT_SLIDES}.`)
    if (!name) {
      const title = slides[0].frontmatter.title
      name = typeof title === 'string' ? title : ''
    }

    const clicks = input.options?.clicks ?? (input.format === 'webm' ? 'each' : 'last')
    const dwellMs = input.options?.dwellMs ?? DEFAULT_DWELL_MS
    // Click steps are only known once the renderer draws the slides, so this counts one step a slide. The renderer checks again with every step.
    if (input.format === 'webm' && videoLength(slides.map(slide => ({ dwellMs: videoDwellMs(slide.frontmatter, dwellMs), steps: 1 }))) > MAX_VIDEO_MS)
      throw new ExportLimitError(VIDEO_TOO_LONG)

    // Checked right before the job is added, with no wait in between, so requests sent together cannot pass them.
    const underWay = [...this.jobs.values()].filter(job => job.userId === userId && (job.status === 'queued' || job.status === 'running'))
    if (underWay.length >= MAX_PER_ACCOUNT)
      throw new ExportBusyError(`You have ${MAX_PER_ACCOUNT} exports under way. Wait for one to finish, then try again.`)
    if (this.storedBytes() >= this.storedBytesLimit)
      throw new ExportUnavailableError('The server has no room for more exports right now. Try again in a few minutes.')
    const job: Job = {
      id: randomUUID(),
      userId,
      ...(input.deckId !== undefined ? { deckId: input.deckId } : {}),
      format: input.format,
      clicks,
      dwellMs,
      name: downloadName(name, input.format),
      slides,
      status: 'queued',
      progress: 0,
    }
    this.jobs.set(job.id, job)
    this.pump()
    return job.id
  }

  /** The export's state, for the person who asked for it while they can still open its deck. */
  async status(userId: string, id: string): Promise<ExportState | undefined> {
    const job = await this.visible(userId, id)
    if (!job)
      return undefined
    return { status: job.status, progress: Math.round(job.progress * 1000) / 1000, ...(job.error ? { error: job.error } : {}) }
  }

  /**
   * The finished file, `unfinished` while the export is under way, or
   * `failed` with the reason when there is no file. A download shortens how
   * long the file stays.
   */
  async download(userId: string, id: string): Promise<ExportFile | 'unfinished' | { failed: string } | undefined> {
    const job = await this.visible(userId, id)
    if (!job)
      return undefined
    if (job.status === 'failed')
      return { failed: job.error ?? 'The export failed.' }
    if (job.status !== 'done' || !job.file)
      return 'unfinished'
    const { size } = await stat(job.file)
    if ((job.removeAt ?? 0) - Date.now() > KEEP_AFTER_DOWNLOAD_MS)
      this.expire(job, KEEP_AFTER_DOWNLOAD_MS)
    return { path: job.file, name: job.name, type: TYPES[job.format], size }
  }

  /** Stops every export, waits for those running to end, and removes their files. */
  async close() {
    this.closed = true
    const running = [...this.jobs.values()].filter(job => job.status === 'running')
    for (const job of running)
      job.stop?.abort(new ExportStopped('The server is shutting down.'))
    await Promise.all(running.map(job => job.running))
    for (const job of this.jobs.values())
      clearTimeout(job.timer)
    this.jobs.clear()
    const folder = await this.folder?.catch(() => undefined)
    if (folder)
      await rm(folder, { recursive: true, force: true })
  }

  /** The job when it is the person's and they can still open its deck. An export of a deck they lost access to goes. */
  private async visible(userId: string, id: string) {
    const job = this.jobs.get(id)
    if (!job || job.userId !== userId)
      return undefined
    if (job.deckId === undefined || await this.projects.deckAccess(userId, job.deckId))
      return job
    this.forget(job)
    return undefined
  }

  /** Space taken by finished files. */
  private storedBytes() {
    return [...this.jobs.values()].reduce((sum, job) => sum + (job.file ? job.size ?? 0 : 0), 0)
  }

  /** Starts the oldest waiting exports that may run now. */
  private pump() {
    if (this.closed)
      return
    for (const job of this.jobs.values()) {
      const running = [...this.jobs.values()].filter(item => item.status === 'running')
      if (running.length >= MAX_RUNNING)
        return
      if (job.status !== 'queued' || running.some(item => item.userId === job.userId || (job.format === 'webm' && item.format === 'webm')))
        continue
      job.status = 'running'
      job.stop = new AbortController()
      job.running = this.run(job, job.stop.signal)
    }
  }

  private async run(job: Job, signal: AbortSignal) {
    // Nearly done stays below 1 until the file is written.
    const onProgress = (progress: number) => {
      job.progress = Math.max(job.progress, Math.min(progress, 0.99))
    }
    let file: string | undefined
    try {
      if (job.deckId !== undefined && !await this.projects.deckAccess(job.userId, job.deckId))
        throw new ExportError('You can no longer open this deck.')
      const media = await inlineMedia(this.media, job.userId, job.slides)
      file = join(await this.temporaryFolder(), `${job.id}.${job.format}`)
      signal.throwIfAborted()
      if (job.format === 'pdf') {
        await drawPdf({ renderer: this.renderer, slides: job.slides, clicks: job.clicks, media, title: job.name.replace(/\.pdf$/, ''), file, maxBytes: this.pdfBytesLimit, onProgress, signal })
      }
      else {
        const request = {
          slides: job.slides.map((slide, index) => ({ ...slide, first: index === 0, dwellMs: videoDwellMs(slide.frontmatter, job.dwellMs) })),
          headmatter: job.slides[0].frontmatter,
          clicks: job.clicks,
          ...(Object.keys(media).length ? { media } : {}),
        }
        await whenNotBusy(() => this.renderer.video!(request, { file: file!, onProgress, signal }), signal)
      }
      job.size = (await stat(file)).size
      job.file = file
      job.status = 'done'
      job.progress = 1
    }
    catch (error) {
      // The unfinished file goes before the export reads as failed.
      if (file)
        await rm(file, { force: true })
      job.error = reason(error)
      job.status = 'failed'
    }
    finally {
      // Only the file is needed from here on.
      job.slides = []
      job.stop = undefined
      if (job.forgotten) {
        if (job.file)
          await rm(job.file, { force: true })
      }
      else if (!this.closed) {
        this.expire(job, KEEP_MS)
        this.keepNewest(job.userId)
      }
      this.pump()
    }
  }

  /** An account keeps its newest finished exports; older ones go. */
  private keepNewest(userId: string) {
    const finished = [...this.jobs.values()].filter(job => job.userId === userId && (job.status === 'done' || job.status === 'failed'))
    for (const job of finished.slice(0, Math.max(0, finished.length - MAX_KEPT_PER_ACCOUNT)))
      this.forget(job)
  }

  /** Removes the job now, with its file. A running job is stopped first. */
  private forget(job: Job) {
    clearTimeout(job.timer)
    this.jobs.delete(job.id)
    if (job.status === 'running') {
      job.forgotten = true
      job.stop?.abort(new ExportStopped('The export was removed.'))
    }
    else if (job.file) {
      void rm(job.file, { force: true })
    }
  }

  /** Forgets the job, and removes its file, after `ms`. */
  private expire(job: Job, ms: number) {
    clearTimeout(job.timer)
    job.removeAt = Date.now() + ms
    job.timer = setTimeout(() => this.forget(job), ms)
    job.timer.unref?.()
  }

  private temporaryFolder() {
    this.folder ??= removeLeftovers().then(() => mkdtemp(join(tmpdir(), `${FOLDER_PREFIX}${process.pid}-${PROCESS_START}-`)))
    return this.folder
  }
}

/** What went wrong, in words for the person who asked for the export. */
function reason(error: unknown) {
  if (error instanceof ExportError || error instanceof RenderError || error instanceof ExportStopped)
    return error.message
  if (error instanceof RendererBusyError) {
    console.warn('An export found the renderer busy:', error.message)
    return 'The slide renderer is busy with other work. Try again in a few minutes.'
  }
  if (error instanceof RendererRefusedError) {
    console.warn('The renderer refused an export:', error.message)
    return `The slide renderer refused this export: ${error.detail.replace(/\.$/, '')}.`
  }
  if (error instanceof RendererUnavailableError) {
    console.warn('An export could not reach the renderer:', error.message)
    return 'The slide renderer is not answering right now. Try again in a few minutes.'
  }
  console.error('An export failed', error)
  return 'The export failed. Try again in a few minutes.'
}
