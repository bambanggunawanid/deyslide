// @vitest-environment node
import type { MarkdownDecks } from '../apps/server/src/mcp/decks'
import { readFileSync } from 'node:fs'
import { describeFeature, loadFeature } from '@amiceli/vitest-cucumber'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { expect } from 'vitest'
import { mcpUrl } from '../apps/server/src/auth'
import { readConfig } from '../apps/server/src/config'
import { createMcpServer } from '../apps/server/src/mcp/tools'

const feature = await loadFeature('./claude-plugin.feature')

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')
const json = <T>(path: string) => JSON.parse(read(path)) as T

describeFeature(feature, ({ Scenario }) => {
  Scenario('The repository is a plugin marketplace', ({ Given, Then, And }) => {
    let marketplace: { name: string, owner: { name: string }, plugins: { name: string, source: string }[] }
    Given('the marketplace file at ".claude-plugin/marketplace.json"', () => {
      marketplace = json('.claude-plugin/marketplace.json')
    })
    Then('it lists the plugin "deyslide" from "./plugins/deyslide"', () => {
      expect(marketplace.owner.name).toBeTruthy()
      expect(marketplace.plugins).toEqual([expect.objectContaining({ name: 'deyslide', source: './plugins/deyslide' })])
    })
    And('the plugin\'s manifest is named "deyslide"', () => {
      expect(json<{ name: string }>('plugins/deyslide/.claude-plugin/plugin.json').name).toBe('deyslide')
    })
  })

  Scenario('The plugin connects to Deyslide\'s MCP server', ({ Given, Then, And }) => {
    let servers: Record<string, { type: string, url: string }>
    Given('the plugin\'s MCP settings', () => {
      servers = json<{ mcpServers: typeof servers }>('plugins/deyslide/.mcp.json').mcpServers
    })
    Then('the server "deyslide" is an http server at "https://deyslide.bambanggunawan.id/mcp"', () => {
      expect(servers).toEqual({ deyslide: { type: 'http', url: 'https://deyslide.bambanggunawan.id/mcp' } })
    })
    And('that is the MCP address the API serves for that public address', () => {
      expect(mcpUrl(readConfig({ PUBLIC_URL: 'https://deyslide.bambanggunawan.id' }))).toBe(servers.deyslide.url)
    })
  })

  Scenario('The skill covers every MCP tool', ({ Given, Then, And }) => {
    let skill: string
    Given('the skill "deyslide"', () => {
      skill = read('plugins/deyslide/skills/deyslide/SKILL.md')
    })
    Then('its frontmatter has a name and a description', () => {
      const frontmatter = Object.fromEntries(skill.split('---')[1].trim().split('\n').map(line => [line.slice(0, line.indexOf(':')), line.slice(line.indexOf(':') + 1).trim()]))
      expect(frontmatter.name).toBe('deyslide')
      expect(frontmatter.description.length).toBeGreaterThan(50)
    })
    And('it names every tool the MCP server offers', async () => {
      const server = createMcpServer('nobody', { decks: {} as MarkdownDecks, version: 'test' })
      const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
      await server.connect(serverSide)
      const client = new Client({ name: 'test', version: '1' })
      await client.connect(clientSide)
      const { tools } = await client.listTools()
      for (const tool of tools)
        expect(skill).toContain(`\`${tool.name}\``)
      await client.close()
    })
    And('it follows the writing rules', () => {
      expect(skill).not.toContain('—')
    })
  })
})
