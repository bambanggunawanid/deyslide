import type { Page } from '@playwright/test'
import { expect, test } from '@playwright/test'
import { addDeck, createProject, openMarkdownView, signIn, signOut, signUp, uniqueEmail } from './helpers'

const OFFLINE = 'Offline. Changes sync when you are back online.'

/** The IndexedDB databases that hold account deck copies on this device. */
async function accountCopies(page: Page) {
  return page.evaluate(async () => (await indexedDB.databases()).map(database => database.name ?? '').filter(name => name.startsWith('deyslide-account-')))
}

test('an account deck opened once opens and changes offline, then syncs', async ({ browser }) => {
  test.slow()
  const email = uniqueEmail('ana')
  const context = await browser.newContext()
  const ana = await context.newPage()
  await signUp(ana, 'Ana', email, 'correct horse')
  await createProject(ana, 'Talks')
  await addDeck(ana, 'Graphs', 'blank')
  await expect(ana.getByTestId('save-status')).toHaveText('Saved')
  // The deck now has a copy on this device.
  await expect.poll(() => accountCopies(ana)).toHaveLength(1)
  const deckUrl = ana.url()

  // Back on the project page, the connection drops. The page stays loaded:
  // the website itself needs a connection to load.
  await ana.getByRole('link', { name: 'Talks' }).click()
  await context.setOffline(true)
  await expect(ana.getByTestId('project-offline')).toContainText('Offline')
  await expect(ana.locator('[data-deck-offline="Graphs"]')).toHaveText('On this device')

  // The deck opens from its copy and takes changes.
  await ana.locator('[data-deck="Graphs"]').click()
  await expect(ana.getByTestId('save-status')).toHaveText(OFFLINE)
  await openMarkdownView(ana)
  await ana.locator('.cm-line', { hasText: '# Graphs' }).click()
  await ana.keyboard.press('End')
  await ana.keyboard.type(' on the train')
  await expect(ana.locator('.cm-content')).toContainText('# Graphs on the train')
  await expect(ana.getByTestId('save-status')).toHaveText(OFFLINE)

  // Home lists the account's projects, marked offline.
  await ana.getByRole('link', { name: 'Projects' }).click()
  await expect(ana.locator('[data-project="Talks"]')).toBeVisible()
  await expect(ana.getByTestId('projects-offline')).toContainText('Offline')

  // Back online, the change reaches the account and the mark goes.
  await context.setOffline(false)
  await expect(ana.getByTestId('projects-offline')).toHaveCount(0)
  const other = await (await browser.newContext()).newPage()
  await signIn(other, email, 'correct horse')
  await other.goto(deckUrl)
  await openMarkdownView(other)
  await expect(other.locator('.cm-content')).toContainText('# Graphs on the train')
  await other.context().close()

  // Signing out deletes every copy on this device.
  await signOut(ana)
  await expect.poll(() => accountCopies(ana)).toEqual([])
  await context.close()
})
