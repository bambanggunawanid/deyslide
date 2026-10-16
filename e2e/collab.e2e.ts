import type { Page } from '@playwright/test'
import { expect, test } from '@playwright/test'
import { addDeck, createProject, openMarkdownView, signUp, uniqueEmail } from './helpers'

/** Types at the end of the editor line that holds `text`, key by key. */
async function typeAfter(page: Page, text: string, typed: string) {
  await page.locator('.cm-line', { hasText: text }).click()
  await page.keyboard.press('End')
  await page.keyboard.type(typed)
}

/** The avatar of `name` in the deck header. */
const avatar = (page: Page, name: string) => page.getByTestId('peers').locator(`[data-peer="${name}"]`)

/** The color the page gives a person whose presence names no color (`peersOf` in apps/web/src/deck/session.ts). */
const FALLBACK_COLOR = 'rgb(148, 163, 184)'

/** Checks that an avatar has a color of its own, which only the server gives, since the page publishes none. */
async function expectServerColor(page: Page, name: string) {
  await expect(avatar(page, name)).toHaveCSS('background-color', /^rgb\(\d+, \d+, \d+\)$/)
  await expect(avatar(page, name)).not.toHaveCSS('background-color', FALLBACK_COLOR)
}

test('two people edit one deck live and see each other', async ({ browser }) => {
  test.slow()
  const budiEmail = uniqueEmail('budi')

  const budi = await (await browser.newContext()).newPage()
  await signUp(budi, 'Budi', budiEmail, 'correct horse')

  const ana = await (await browser.newContext()).newPage()
  await signUp(ana, 'Ana', uniqueEmail('ana'), 'correct horse')
  await createProject(ana, 'Talks')
  await addDeck(ana, 'Graphs', 'blank')

  // Ana shares the deck with Budi as an editor.
  await ana.getByTestId('share-deck').click()
  await ana.getByTestId('share-email').fill(budiEmail)
  await ana.getByTestId('share-role').selectOption('editor')
  await ana.getByTestId('share-submit').click()
  await expect(ana.locator(`[data-member="${budiEmail}"] select`)).toHaveValue('editor')
  await ana.keyboard.press('Escape')

  // Both have the deck open in the Markdown view.
  await budi.goto(ana.url())
  await openMarkdownView(ana)
  await openMarkdownView(budi)
  await expect(ana.locator('.cm-content')).toContainText('# Graphs')
  await expect(budi.locator('.cm-content')).toContainText('# Graphs')

  // Each sees the other in the header: an initial in the color the server gave, the name on hover.
  await expect(avatar(ana, 'Budi')).toHaveText('B')
  await expect(avatar(ana, 'Budi')).toHaveAttribute('title', 'Budi')
  await expectServerColor(ana, 'Budi')
  await expect(avatar(budi, 'Ana')).toHaveText('A')
  await expect(avatar(budi, 'Ana')).toHaveAttribute('title', 'Ana')
  await expectServerColor(budi, 'Ana')

  // What one types shows up for the other within a second, both ways.
  await typeAfter(ana, '# Graphs', ' and trees')
  await expect(budi.locator('.cm-content')).toContainText('# Graphs and trees', { timeout: 1000 })
  await typeAfter(budi, '# Graphs and trees', ', by Budi')
  await expect(ana.locator('.cm-content')).toContainText('# Graphs and trees, by Budi', { timeout: 1000 })

  // Both pages say the deck is saved.
  await expect(ana.getByTestId('save-status')).toHaveText('Saved')
  await expect(budi.getByTestId('save-status')).toHaveText('Saved')

  // The change is in the account: it is there after a reload.
  await ana.reload()
  await openMarkdownView(ana)
  await expect(ana.locator('.cm-content')).toContainText('# Graphs and trees, by Budi')

  // When Budi leaves, Ana's header no longer shows them.
  await expect(avatar(ana, 'Budi')).toBeVisible()
  await budi.context().close()
  await expect(ana.getByTestId('peers')).toHaveCount(0)
})
