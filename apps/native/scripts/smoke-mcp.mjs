// Starts a built Deyslide executable as `deyslide mcp`, the way Claude Code
// does, and checks it answers over stdio: it lists the tools, creates a
// project and a deck in an empty library folder, and reads the deck back.
// The release workflow runs it on each computer it builds for.
//
//   node apps/native/scripts/smoke-mcp.mjs <path to the executable>

import { spawn } from 'node:child_process'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'

const TOOLS = ['get_guide', 'list_decks', 'create_project', 'create_deck', 'read_deck', 'write_deck', 'edit_slides', 'render_slides']
const TIMEOUT_MS = 60_000

const executable = process.argv[2]
if (!executable) {
  console.error('Give the path to the Deyslide executable.')
  process.exit(2)
}

const scratch = mkdtempSync(join(tmpdir(), 'deyslide-smoke-'))
const library = join(scratch, 'library')
const data = join(scratch, 'data')

const child = spawn(executable, ['mcp', '--library', library, '--data-dir', data], {
  stdio: ['pipe', 'pipe', 'inherit'],
})

const pending = new Map()
let nextId = 1
let buffer = ''

child.stdout.setEncoding('utf8')
child.stdout.on('data', (chunk) => {
  buffer += chunk
  let end = buffer.indexOf('\n')
  while (end >= 0) {
    const line = buffer.slice(0, end).trim()
    buffer = buffer.slice(end + 1)
    end = buffer.indexOf('\n')
    if (!line)
      continue
    const message = JSON.parse(line)
    const waiter = pending.get(message.id)
    if (waiter) {
      pending.delete(message.id)
      if (message.error)
        waiter.reject(new Error(`${message.error.code}: ${message.error.message}`))
      else
        waiter.resolve(message.result)
    }
  }
})

let finished = false
const exited = new Promise((resolve) => {
  child.on('exit', (code, signal) => {
    if (!finished)
      fail(`The server stopped before the check finished (${signal ?? `exit code ${code}`}).`)
    resolve({ code, signal })
  })
})
child.on('error', (error) => fail(`The executable did not start: ${error.message}`))

function send(message) {
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`)
}

function request(method, params) {
  const id = nextId++
  const answer = new Promise((resolve, reject) => pending.set(id, { resolve, reject }))
  send({ id, method, params })
  return answer
}

async function call(name, args) {
  const result = await request('tools/call', { name, arguments: args })
  const text = result.content?.filter(part => part.type === 'text').map(part => part.text).join('\n') ?? ''
  if (result.isError)
    throw new Error(`${name} failed: ${text}`)
  return text
}

function fail(message) {
  console.error(message)
  child.kill()
  rmSync(scratch, { recursive: true, force: true })
  process.exit(1)
}

const timer = setTimeout(() => fail(`No answer within ${TIMEOUT_MS / 1000} seconds.`), TIMEOUT_MS)

try {
  const init = await request('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'deyslide-smoke', version: '1.0.0' },
  })
  console.log(`Server: ${init.serverInfo?.name} ${init.serverInfo?.version}`)
  send({ method: 'notifications/initialized' })

  const { tools } = await request('tools/list', {})
  const names = tools.map(tool => tool.name).sort()
  const missing = TOOLS.filter(name => !names.includes(name))
  if (missing.length > 0)
    throw new Error(`Missing tools: ${missing.join(', ')}. Listed: ${names.join(', ')}`)
  console.log(`Tools: ${names.join(', ')}`)

  const project = await call('create_project', { name: 'Smoke test' })
  const projectId = project.match(/local-p-[\w-]+/)?.[0]
  if (!projectId)
    throw new Error(`create_project gave no project id: ${project}`)

  const deck = await call('create_deck', {
    projectId,
    name: 'Hello',
    markdown: '# Hello from the release check\n\n---\n\n## Second slide\n',
  })
  const deckId = deck.match(/local-d-[\w-]+/)?.[0]
  if (!deckId)
    throw new Error(`create_deck gave no deck id: ${deck}`)

  const read = await call('read_deck', { deckId })
  if (!read.includes('Second slide'))
    throw new Error(`read_deck did not return the deck: ${read}`)

  const files = readdirSync(library, { recursive: true }).map(String)
  if (!files.some(file => file.endsWith('.md')))
    throw new Error(`No Markdown file in the library folder: ${files.join(', ')}`)
  console.log(`Library: ${files.join(', ')}`)
}
catch (error) {
  clearTimeout(timer)
  fail(error instanceof Error ? error.message : String(error))
}

clearTimeout(timer)
finished = true
child.stdin.end()
const { code, signal } = await exited
rmSync(scratch, { recursive: true, force: true })
if (code !== 0 && signal == null) {
  console.error(`The server stopped with exit code ${code}.`)
  process.exit(1)
}
console.log('The MCP server works.')
