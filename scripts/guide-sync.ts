/**
 * `pnpm guide:sync` copies what the hosted MCP server offers (its tools,
 * guide and instructions) into crates/deyslide-core/src, so `deyslide mcp`
 * on a computer offers the same. Run it after changing apps/server/src/mcp.
 * The device appendix in that folder is written by hand and added to the
 * guide and the instructions.
 */
import type { Tool } from '@modelcontextprotocol/sdk/types.js'
import type { MarkdownDecks } from '../apps/server/src/mcp/decks.ts'
import { readFileSync, writeFileSync } from 'node:fs'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { createMcpServer } from '../apps/server/src/mcp/tools.ts'

/** The Rust crate's source folder, where the copies live. */
export const CORE_SOURCE = new URL('../crates/deyslide-core/src/', import.meta.url)

/** What tools.json keeps of each tool. */
export type ToolEntry = Pick<Tool, 'name' | 'title' | 'description' | 'inputSchema' | 'annotations'>

export interface CloudSurface {
  tools: ToolEntry[]
  instructions: string
  guide: string
}

/** Connects to the hosted server's tools in memory and reads what they offer. */
export async function cloudSurface(): Promise<CloudSurface> {
  const server = createMcpServer('guide-sync', { decks: {} as MarkdownDecks, version: 'guide-sync' })
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
  await server.connect(serverSide)
  const client = new Client({ name: 'guide-sync', version: '1' })
  await client.connect(clientSide)
  try {
    const { tools } = await client.listTools()
    const guide = await client.callTool({ name: 'get_guide' })
    const [content] = guide.content as { type: string, text?: string }[]
    return {
      tools: tools.map(({ name, title, description, inputSchema, annotations }) => ({ name, title, description, inputSchema, annotations })),
      instructions: client.getInstructions() ?? '',
      guide: content?.text ?? '',
    }
  }
  finally {
    await client.close()
  }
}

/** The part of the guide and the instructions that only applies on a computer. */
export function deviceAppendix() {
  return readFileSync(new URL('device-appendix.md', CORE_SOURCE), 'utf8')
}

/** The files `deyslide mcp` builds in, by file name. */
export function deviceFiles(surface: CloudSurface, appendix = deviceAppendix()): Record<string, string> {
  return {
    'tools.json': `${JSON.stringify(surface.tools, null, 2)}\n`,
    'guide.md': `${surface.guide}\n\n${appendix}`,
    'instructions.md': `${surface.instructions}\n\n${appendix}`,
  }
}

if (import.meta.main) {
  const files = deviceFiles(await cloudSurface())
  for (const [name, content] of Object.entries(files))
    writeFileSync(new URL(name, CORE_SOURCE), content)
  console.log(`Wrote ${Object.keys(files).join(', ')} in crates/deyslide-core/src.`)
}
