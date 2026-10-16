import type { ExportApi, ExportClicks, ExportFile, ExportFormat, ExportSource, ExportStatus } from '../../apps/web/src/present/exports'
import { ExportError } from '../../apps/web/src/present/exports'

/** One export the fake server was asked for. */
export interface FakeExport {
  id: string
  source: ExportSource
  format: ExportFormat
  clicks: ExportClicks
  /** Status answers still to give, in order. The last one repeats. */
  answers: ExportStatus[]
  /** How many times the page asked about it. */
  asked: number
}

/**
 * The export API for page scenarios. Each export answers with the statuses
 * a scenario lines up, then hands over a small file. The real routes have
 * their own scenarios in export.feature.
 */
export class FakeExportApi implements ExportApi {
  /** Scenarios wait for no one. */
  pollMs = 1
  on: boolean
  readonly exports: FakeExport[] = []
  /** Statuses every new export gives, until it is done. */
  progress: ExportStatus[] = [{ status: 'queued', progress: 0 }, { status: 'running', progress: 0.5 }, { status: 'done', progress: 1 }]
  /** When set, starting an export fails with this message. */
  refuseWith = ''
  /** When set, downloading fails with this message. */
  downloadFailsWith = ''
  /** The file every download hands over. */
  file: ExportFile = { bytes: new TextEncoder().encode('%PDF-1.7 fake'), name: 'Graphs.pdf', type: 'application/pdf' }

  constructor({ on = true }: { on?: boolean } = {}) {
    this.on = on
  }

  async enabled() {
    return this.on
  }

  async start(source: ExportSource, format: ExportFormat, clicks: ExportClicks) {
    if (this.refuseWith)
      throw new ExportError(this.refuseWith)
    const id = `export-${this.exports.length + 1}`
    this.exports.push({ id, source: structuredClone(source), format, clicks, answers: [...this.progress], asked: 0 })
    return id
  }

  async status(id: string): Promise<ExportStatus> {
    const job = this.find(id)
    job.asked++
    return job.answers.length > 1 ? job.answers.shift()! : job.answers[0]
  }

  async download(id: string): Promise<ExportFile> {
    this.find(id)
    if (this.downloadFailsWith)
      throw new ExportError(this.downloadFailsWith)
    return { ...this.file, bytes: this.file.bytes.slice() }
  }

  private find(id: string) {
    const job = this.exports.find(item => item.id === id)
    if (!job)
      throw new ExportError('Not found')
    return job
  }
}
