import type { LocalDeckInfo, LocalProjectInfo, McpSetup, WriteDeckResult } from '../../apps/web/src/platform/native'
import { createHash } from 'node:crypto'
import { splitSlides } from '../../packages/deck-model/src'

// A stand in for the Deyslide app's library folder: the library commands
// the pages call, the files on disk that other programs (Claude Code, a
// file manager) change, and the watcher that tells the pages about changes.

const hex16 = (text: string) => createHash('sha256').update(text).digest('hex').slice(0, 16)

/** Ids as the app makes them, from the folder and file names. */
export const projectIdOf = (folder: string) => `local-p-${hex16(folder)}`
export const deckIdOf = (folder: string, deck: string) => `local-d-${hex16(`${folder}/${deck}.md`)}`

interface FileOnDisk {
  content: string
  createdAt: number
  updatedAt: number
}

interface FolderOnDisk {
  createdAt: number
  updatedAt: number
  /** By file name without `.md`. */
  decks: Map<string, FileOnDisk>
}

/** A write the pages asked for, and whether the file took it. */
export interface DeckWrite {
  id: string
  content: string
  expected: string | null
  written: boolean
}

export type EmitEvent = (event: string, payload: unknown) => void

const NO_PROJECT = 'There is no project with that id in this library.'
const NO_DECK = 'There is no deck with that id in this library.'

export class FakeDeviceLibrary {
  root = '/home/ana/Documents/Deyslide'
  readonly folders = new Map<string, FolderOnDisk>()
  /** Every deck write the pages asked for, in order. */
  readonly writes: DeckWrite[] = []
  /** Paths moved to the trash. */
  readonly trash: string[] = []
  /** Library commands the pages called, in order. */
  readonly commands: string[] = []
  /** What `mcp_setup` answers. */
  setup: McpSetup = { command: 'claude mcp add --scope user deyslide-local -- "/opt/Deyslide/deyslide" mcp' }
  /** While true, changes on disk wait for `report()` before the pages hear of them. */
  holdReports = false
  /** Other libraries the folder dialog can switch to, by root. */
  readonly elsewhere = new Map<string, Map<string, FolderOnDisk>>()
  /** Runs just before each deck write, as another program changing the file at that moment would. */
  beforeWrite?: () => void
  private failures = { count: 0, message: '' }
  private pending = { library: false, decks: new Set<string>() }
  private timer: ReturnType<typeof setTimeout> | undefined
  private clock = Date.UTC(2026, 9, 1, 9)

  constructor(private readonly emit: EmitEvent) {}

  // What other programs do on disk ------------------------------------------

  /** Writes a deck file, making its folder when needed. */
  put(project: string, deck: string, content: string) {
    const folder = this.folder(project) ?? this.addFolder(project)
    const existing = folder.decks.get(deck)
    const time = this.tick()
    folder.decks.set(deck, { content, createdAt: existing?.createdAt ?? time, updatedAt: time })
    if (!existing)
      folder.updatedAt = time
    this.changed(project, deck)
  }

  /** The text of a deck file, or undefined when there is none. */
  read(project: string, deck: string) {
    return this.folder(project)?.decks.get(deck)?.content
  }

  /** Renames a deck file outside the app, as a file manager would. */
  renameOnDisk(project: string, from: string, to: string) {
    const folder = this.folder(project)!
    const file = folder.decks.get(from)!
    folder.decks.delete(from)
    folder.decks.set(to, file)
    folder.updatedAt = this.tick()
    this.changed(project, from)
    this.changed(project, to)
  }

  /** Puts an empty project folder in another library folder, for switching to it. */
  holdsElsewhere(root: string, project: string) {
    const folders = this.elsewhere.get(root) ?? new Map<string, FolderOnDisk>()
    const time = this.tick()
    folders.set(project, { createdAt: time, updatedAt: time, decks: new Map() })
    this.elsewhere.set(root, folders)
  }

  /** Makes the next `count` deck writes fail with `message`, as a full disk would. */
  failNextWrites(count: number, message: string) {
    this.failures = { count, message }
  }

  /** Tells the pages about every change so far, as the watcher does after a quiet moment. */
  report() {
    clearTimeout(this.timer)
    this.timer = undefined
    const { library, decks } = this.pending
    this.pending = { library: false, decks: new Set() }
    if (library)
      this.emit('library-changed', null)
    for (const deckId of decks)
      this.emit('deck-changed', { deckId })
  }

  // The library commands ------------------------------------------------------

  /** Whether `invoke` answers this command. */
  handles(command: string) {
    return command.startsWith('library_') || command === 'mcp_setup'
  }

  /** Answers a library command the way the app does. Failures are strings, as the app's are. */
  async invoke(command: string, args: Record<string, unknown> = {}): Promise<unknown> {
    this.commands.push(command)
    switch (command) {
      case 'library_info':
        return { root: this.root, exists: true }
      case 'library_set_root':
        return this.setRoot(String(args.path))
      case 'library_list':
        return [...this.folders.keys()].sort().map(name => this.projectInfo(name))
      case 'library_create_project': {
        const name = this.checkName(String(args.name))
        if (this.folders.has(name))
          throw `There is already a project named "${name}"`
        this.addFolder(name)
        this.changed(name)
        return this.projectInfo(name)
      }
      case 'library_rename_project': {
        const from = this.projectName(String(args.id))
        const to = this.checkName(String(args.name))
        if (from !== to && this.folders.has(to))
          throw `There is already a project named "${to}"`
        const folder = this.folders.get(from)!
        this.folders.delete(from)
        this.folders.set(to, folder)
        this.changed(from)
        this.changed(to)
        return this.projectInfo(to)
      }
      case 'library_delete_project': {
        const name = this.projectName(String(args.id))
        this.folders.delete(name)
        this.trash.push(`${this.root}/${name}`)
        this.changed(name)
        return null
      }
      case 'library_create_deck': {
        const project = this.projectName(String(args.projectId))
        const name = this.checkName(String(args.name))
        if (this.folders.get(project)!.decks.has(name))
          throw `There is already a deck named "${name}"`
        this.put(project, name, String(args.markdown))
        return this.deckInfo(project, name)
      }
      case 'library_rename_deck': {
        const [project, from] = this.deckPlace(String(args.id))
        const to = this.checkName(String(args.name))
        const folder = this.folders.get(project)!
        if (from !== to && folder.decks.has(to))
          throw `There is already a deck named "${to}"`
        this.renameOnDisk(project, from, to)
        return this.deckInfo(project, to)
      }
      case 'library_delete_deck': {
        const [project, name] = this.deckPlace(String(args.id))
        this.folders.get(project)!.decks.delete(name)
        this.trash.push(`${this.root}/${project}/${name}.md`)
        this.changed(project, name)
        return null
      }
      case 'library_read_deck': {
        const [project, name] = this.deckPlace(String(args.id))
        return this.read(project, name)
      }
      case 'library_write_deck':
        return this.write(String(args.id), String(args.content), (args.expected ?? null) as string | null)
      case 'mcp_setup':
        return this.setup
    }
    throw new Error(`The fake library has no command ${command}`)
  }

  private write(id: string, content: string, expected: string | null): WriteDeckResult {
    if (this.failures.count > 0) {
      this.failures.count--
      throw this.failures.message
    }
    this.beforeWrite?.()
    const [project, name] = this.deckPlace(id)
    const current = this.read(project, name)!
    const written = expected === null || expected === current
    this.writes.push({ id, content, expected, written })
    if (!written)
      return { conflict: true, current }
    this.put(project, name, content)
    return { ok: true }
  }

  private setRoot(path: string) {
    if (!path.startsWith('/'))
      throw 'Pick a whole folder path for the library.'
    this.elsewhere.set(this.root, new Map(this.folders))
    this.root = path
    const next = this.elsewhere.get(path) ?? new Map()
    this.folders.clear()
    for (const [name, folder] of next)
      this.folders.set(name, folder)
    this.pending.library = true
    this.schedule()
    return { root: path, exists: true }
  }

  private checkName(name: string) {
    const trimmed = name.trim()
    if (!trimmed)
      throw 'A name is required'
    if (/[/\\:*?"<>|]/.test(trimmed))
      throw 'A name cannot contain / \\ : * ? " < > or |'
    return trimmed
  }

  private folder(name: string) {
    return this.folders.get(name)
  }

  private addFolder(name: string) {
    const time = this.tick()
    const folder: FolderOnDisk = { createdAt: time, updatedAt: time, decks: new Map() }
    this.folders.set(name, folder)
    return folder
  }

  private projectName(id: string) {
    const name = [...this.folders.keys()].find(folder => projectIdOf(folder) === id)
    if (name === undefined)
      throw NO_PROJECT
    return name
  }

  private deckPlace(id: string): [string, string] {
    for (const [project, folder] of this.folders) {
      for (const deck of folder.decks.keys()) {
        if (deckIdOf(project, deck) === id)
          return [project, deck]
      }
    }
    throw NO_DECK
  }

  private deckInfo(project: string, name: string): LocalDeckInfo {
    const file = this.folders.get(project)!.decks.get(name)!
    return {
      id: deckIdOf(project, name),
      projectId: projectIdOf(project),
      projectName: project,
      name,
      path: `${this.root}/${project}/${name}.md`,
      slideCount: splitSlides(file.content).length,
      createdAt: file.createdAt,
      updatedAt: file.updatedAt,
    }
  }

  private projectInfo(name: string): LocalProjectInfo {
    const folder = this.folders.get(name)!
    return {
      id: projectIdOf(name),
      name,
      path: `${this.root}/${name}`,
      createdAt: folder.createdAt,
      updatedAt: folder.updatedAt,
      decks: [...folder.decks.keys()].sort().map(deck => this.deckInfo(name, deck)),
    }
  }

  private tick() {
    this.clock += 1000
    return this.clock
  }

  /** The watcher saw a change: the library changed, and a deck file when there is one. */
  private changed(project: string, deck?: string) {
    this.pending.library = true
    if (deck !== undefined)
      this.pending.decks.add(deckIdOf(project, deck))
    this.schedule()
  }

  private schedule() {
    if (this.holdReports || this.timer !== undefined)
      return
    this.timer = setTimeout(() => this.report(), 5)
  }
}
