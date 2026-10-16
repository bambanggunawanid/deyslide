import type { TestProject } from 'vitest/node'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

declare module 'vitest' {
  export interface ProvidedContext {
    /** The `deyslide-mcp` binary built from crates/deyslide-core for this run. */
    deyslideMcp: string
  }
}

const ROOT = fileURLToPath(new URL('../..', import.meta.url))

interface CargoMessage {
  reason: string
  target?: { name: string }
  executable?: string | null
}

/**
 * Vitest global setup: builds `deyslide-mcp` once before any spec runs,
 * so specs in parallel workers never wait on cargo's lock, then hands
 * its path to them as `inject('deyslideMcp')`.
 */
export default function buildDeyslideMcp(project: TestProject) {
  const build = spawnSync('cargo', ['build', '-p', 'deyslide-core', '--bin', 'deyslide-mcp', '--message-format=json-render-diagnostics'], {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
    maxBuffer: 64 * 1024 * 1024,
  })
  if (build.error)
    throw new Error(`pnpm test needs Rust to build deyslide-mcp. Install it from https://rustup.rs. (${build.error.message})`)
  if (build.status !== 0)
    throw new Error('cargo could not build deyslide-mcp. Its errors are above.')
  const artifact = build.stdout.split('\n')
    .filter(line => line.startsWith('{'))
    .map(line => JSON.parse(line) as CargoMessage)
    .find(message => message.reason === 'compiler-artifact' && message.target?.name === 'deyslide-mcp' && message.executable)
  if (!artifact?.executable)
    throw new Error('cargo built deyslide-mcp but did not say where the binary is.')
  project.provide('deyslideMcp', artifact.executable)
}
