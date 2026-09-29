import type { Page } from '@playwright/test'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js'
import { expect, test } from '@playwright/test'
import { FakeClaudeCodeAuth } from '../features/support/claude-code-auth.ts'
import { signUp, slide, uniqueEmail } from './helpers'

const WEB_URL = 'http://127.0.0.1:4180'
const CALLBACK = 'http://127.0.0.1:33418/callback'

/**
 * Claude Code's side of connecting, with the MCP SDK doing discovery,
 * registration, PKCE and the token exchange. The person's side happens in
 * `page`: it opens the authorization URL there and waits for the redirect
 * back to the loopback callback, which the page never really reaches.
 */
async function connectClaudeCode(page: Page, answer: (page: Page) => Promise<void>) {
  await page.route(`${CALLBACK}**`, route => route.fulfill({ body: 'Back in Claude Code' }))
  const auth = new FakeClaudeCodeAuth(async (url) => {
    await page.goto(url.href)
    await answer(page)
    await page.waitForURL(`${CALLBACK}**`)
    return new URL(page.url())
  })
  const mcpUrl = new URL('/mcp', WEB_URL)
  const client = new Client({ name: 'claude-code-e2e', version: '1.0.0' })
  try {
    await client.connect(new StreamableHTTPClientTransport(mcpUrl, { authProvider: auth }))
    return client
  }
  catch (error) {
    if (!(error instanceof UnauthorizedError) || !auth.code)
      throw error
  }
  const transport = new StreamableHTTPClientTransport(mcpUrl, { authProvider: auth })
  await transport.finishAuth(auth.code)
  const connected = new Client({ name: 'claude-code-e2e', version: '1.0.0' })
  await connected.connect(transport)
  return connected
}

const allow = async (page: Page) => {
  await expect(page.getByTestId('consent-app')).toContainText('Claude Code (test) wants to use your Deyslide account')
  await page.getByTestId('consent-allow').click()
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  const result = await client.callTool({ name, arguments: args }) as CallToolResult
  expect(result.isError, JSON.stringify(result.content)).toBeFalsy()
  return result
}

const text = (result: CallToolResult) => result.content.flatMap(item => item.type === 'text' ? [item.text] : []).join('\n')

const DECK = `---
title: Recursion
layout: cover
---

# Recursion

A function that calls itself

---

# Too much for one slide

${Array.from({ length: 24 }, (_, index) => `- Point ${index + 1}`).join('\n')}
`

test('Claude Code signs in, builds a deck and sees it rendered', async ({ page, isMobile }) => {
  test.skip(isMobile, 'Claude Code runs on a computer; one run is enough')
  test.slow()
  await signUp(page, 'Ina', uniqueEmail('ina'), 'correct horse')
  const claude = await connectClaudeCode(page, allow)

  const project = await call(claude, 'create_project', { name: 'Lectures' })
  const projectId = (project.structuredContent as { project: { id: string } }).project.id
  const created = await call(claude, 'create_deck', { projectId, name: 'Recursion', markdown: DECK })
  const { id: deckId, editorUrl } = (created.structuredContent as { deck: { id: string, editorUrl: string } }).deck

  // Real images from the renderer, with the overflow it measured.
  const rendered = await call(claude, 'render_slides', { deckId })
  const images = rendered.content.filter(item => item.type === 'image')
  expect(images).toHaveLength(2)
  for (const image of images)
    expect(image.type === 'image' && Buffer.from(image.data, 'base64').subarray(1, 4).toString()).toBe('PNG')
  expect(text(rendered)).toContain('Slide 1: 0 clicks, fits the slide.')
  expect(text(rendered)).toContain('Slide 2: 0 clicks, content overflows the slide')

  // The person opens the deck Claude Code made.
  await page.goto(editorUrl)
  await expect(page.getByTestId('slide-position')).toHaveText('Slide 1 of 2')
  await expect(slide(page).locator('h1')).toHaveText('Recursion')

  // Claude Code fixes the crowded slide while the deck is open. Coming back to the tab shows it.
  await call(claude, 'edit_slides', { deckId, edits: [{ action: 'replace', slide: 2, text: '# Base case\n\nStop when the input is small' }] })
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await expect(page.locator('.cm-content')).toContainText('# Base case')
  const fixed = await call(claude, 'render_slides', { deckId, slides: [2] })
  expect(text(fixed)).toContain('Slide 2: 0 clicks, fits the slide.')
})

test('someone signed out signs in first, then approves Claude Code', async ({ page, browser, isMobile }) => {
  test.skip(isMobile, 'Claude Code runs on a computer; one run is enough')
  const email = uniqueEmail('joko')
  await signUp(page, 'Joko', email, 'correct horse')

  const fresh = await browser.newPage()
  const claude = await connectClaudeCode(fresh, async (signedOut) => {
    await expect(signedOut.getByTestId('oauth-sign-in')).toBeVisible()
    await signedOut.getByTestId('email').fill(email)
    await signedOut.getByTestId('password').fill('correct horse')
    await signedOut.getByTestId('submit').click()
    await allow(signedOut)
  })
  const decks = await call(claude, 'list_decks')
  expect(text(decks)).toBe('This account has no projects yet. Create one with create_project.')
  await fresh.close()
})

test('denying leaves Claude Code without access', async ({ page, isMobile }) => {
  test.skip(isMobile, 'Claude Code runs on a computer; one run is enough')
  await signUp(page, 'Rani', uniqueEmail('rani'), 'correct horse')
  await expect(connectClaudeCode(page, async (consent) => {
    await consent.getByTestId('consent-deny').click()
  })).rejects.toThrow()
  expect(new URL(page.url()).searchParams.get('error')).toBe('access_denied')
})
