import type { IncomingMessage, Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { inject } from 'vitest'
import { splitSlides } from '../../packages/deck-model/src'

/** The `deyslide-mcp` binary that the global setup built for this run. */
export function deyslideMcp() {
  return inject('deyslideMcp')
}

function run(args: string[], input: string) {
  const result = spawnSync(deyslideMcp(), args, { input, encoding: 'utf8' })
  if (result.status !== 0)
    throw new Error(`deyslide-mcp ${args.join(' ')} failed: ${result.stderr}`)
  return result.stdout
}

/** One slide as `deyslide-mcp split` prints it. */
export interface RustSlide {
  index: number
  start: number
  contentStart: number
  end: number
  raw: string
  content: string
  note: string | null
  frontmatter: unknown
  frontmatterStyle: 'frontmatter' | 'yaml' | null
  frontmatterRaw: string | null
  frontmatterError: string | null
}

export interface RustSplit {
  slides: RustSlide[]
  /** The slide texts joined back into one deck. */
  joined: string
  frontmatterErrors: string[]
}

/** Splits a deck with the Rust port of Slidev's parser. */
export function splitWithRust(markdown: string): RustSplit {
  return JSON.parse(run(['split'], markdown)) as RustSplit
}

/** Joins slide texts with the Rust port of Slidev's `stringify`. */
export function joinWithRust(texts: string[]): string {
  return run(['join'], JSON.stringify(texts))
}

/** A library folder and a data folder in a fresh temp folder. */
export class TempFolders {
  readonly root = realpathSync(mkdtempSync(join(tmpdir(), 'deyslide-local-')))
  readonly library = join(this.root, 'library')
  readonly data = join(this.root, 'data')

  constructor() {
    mkdirSync(this.library)
    mkdirSync(this.data)
  }

  /** A path inside the library. */
  path(relative: string) {
    return join(this.library, relative)
  }

  read(relative: string) {
    return readFileSync(this.path(relative), 'utf8')
  }

  write(relative: string, content: string) {
    mkdirSync(dirname(this.path(relative)), { recursive: true })
    writeFileSync(this.path(relative), content)
  }

  remove() {
    rmSync(this.root, { recursive: true, force: true })
  }
}

/** Claude Code starting `deyslide-mcp` with these arguments and connecting over stdio. */
export async function connectLocalMcp(args: string[]) {
  const transport = new StdioClientTransport({ command: deyslideMcp(), args })
  const client = new Client({ name: 'claude-code', version: 'test' })
  await client.connect(transport)
  return client
}

/** A 1 by 1 PNG, standing in for a slide image. */
export const PIXEL = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII='

export interface BridgeCall {
  authorization?: string
  body: { markdown: string, slides: { number: number, clicks: number | 'last' }[] }
}

/**
 * The Deyslide app's render bridge, faked: it serves `POST /render` on
 * 127.0.0.1, records each request and answers with a fixed image. Slides
 * whose content holds a text in `overflowing` are reported as overflowing.
 */
export class FakeRenderBridge {
  readonly calls: BridgeCall[] = []
  readonly overflowing = new Set<string>()
  readonly token = 'bridge-token-for-tests'
  private server?: Server

  /**
   * Starts listening and writes `render-bridge.json` into the data folder,
   * as the app does. `pid` is the app's process, this one unless given.
   */
  async open(dataFolder: string, pid = process.pid) {
    this.server = createServer(async (request, response) => {
      const body = JSON.parse(await readBody(request)) as BridgeCall['body']
      this.calls.push({ authorization: request.headers.authorization, body })
      if (request.headers.authorization !== `Bearer ${this.token}`) {
        response.writeHead(401).end()
        return
      }
      const slides = splitSlides(body.markdown)
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({
        slides: body.slides.map(slide => ({
          png: PIXEL,
          clicks: 2,
          overflow: [...this.overflowing].some(text => slides[slide.number - 1]?.content.includes(text)),
        })),
      }))
    })
    await new Promise<void>(resolve => this.server!.listen(0, '127.0.0.1', resolve))
    const { port } = this.server.address() as AddressInfo
    writeFileSync(join(dataFolder, 'render-bridge.json'), JSON.stringify({ port, token: this.token, pid }))
  }

  async close() {
    await new Promise<void>(resolve => this.server ? this.server.close(() => resolve()) : resolve())
  }
}

/** The id of a process that has ended, like that of an app that quit. */
export function endedProcessId() {
  const ended = spawnSync(process.execPath, ['-e', ''])
  if (ended.pid === undefined)
    throw new Error('Could not start a short process.')
  return ended.pid
}

/** Writes a bridge file whose port no longer answers, like an app that quit without cleaning up. */
export async function leaveStaleBridge(dataFolder: string) {
  const server = createServer()
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  await new Promise<void>(resolve => server.close(() => resolve()))
  writeFileSync(join(dataFolder, 'render-bridge.json'), JSON.stringify({ port, token: 'gone', pid: endedProcessId() }))
}

function readBody(request: IncomingMessage) {
  return new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = []
    request.on('data', chunk => chunks.push(chunk))
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    request.on('error', reject)
  })
}
