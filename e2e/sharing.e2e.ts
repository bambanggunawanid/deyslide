import { expect, test } from '@playwright/test'
import { addDeck, createProject, emailLink, replaceMarkdown, signUp, uniqueEmail } from './helpers'

test('Ana shares a project; Budi edits it, then only views it; an invited address joins', async ({ browser, isMobile }) => {
  test.skip(isMobile, 'Sharing works the same on phones; one run is enough')
  test.slow()
  const anaEmail = uniqueEmail('ana')
  const budiEmail = uniqueEmail('budi')
  const citraEmail = uniqueEmail('citra')

  const budi = await (await browser.newContext()).newPage()
  await signUp(budi, 'Budi', budiEmail, 'correct horse')

  const ana = await (await browser.newContext()).newPage()
  await signUp(ana, 'Ana', anaEmail, 'correct horse')
  await createProject(ana, 'Talks')
  await addDeck(ana, 'Graphs', 'blank')
  await ana.getByRole('link', { name: 'Talks' }).click()

  // Ana shares with an account and with an address that has none yet.
  await ana.getByTestId('share-project').click()
  await ana.getByTestId('share-email').fill(budiEmail)
  await ana.getByTestId('share-role').selectOption('editor')
  await ana.getByTestId('share-submit').click()
  await expect(ana.locator(`[data-member="${budiEmail}"] select`)).toHaveValue('editor')
  await ana.getByTestId('share-email').fill(citraEmail)
  await ana.getByTestId('share-role').selectOption('viewer')
  await ana.getByTestId('share-submit').click()
  await expect(ana.locator(`[data-invite="${citraEmail}"]`)).toContainText('invited')
  await ana.keyboard.press('Escape')

  // Budi follows the email and edits the deck.
  await budi.goto(await emailLink(budiEmail, 'Ana shared Talks with you'))
  await expect(budi.getByTestId('shared-by')).toContainText('Shared by Ana. You are an editor.')
  await budi.locator('[data-deck="Graphs"]').click()
  await replaceMarkdown(budi, '# Edited by Budi')
  await expect(budi.getByTestId('save-status')).toHaveText('Saved')
  await ana.goto(budi.url())
  await expect(ana.locator('.cm-content')).toContainText('# Edited by Budi')

  // Ana makes Budi a viewer; Budi's deck turns read only.
  await ana.getByRole('link', { name: 'Talks' }).click()
  await ana.getByTestId('share-project').click()
  await ana.locator(`[data-member="${budiEmail}"] select`).selectOption('viewer')
  await expect(ana.locator(`[data-member="${budiEmail}"] select`)).toHaveValue('viewer')
  await budi.reload()
  await expect(budi.getByTestId('view-only')).toHaveText('View only')
  await expect(budi.getByTestId('assistant')).toHaveCount(0)

  // Citra signs up with the invited address and finds the project.
  const citra = await (await browser.newContext()).newPage()
  await citra.goto(await emailLink(citraEmail, 'Ana invited you to Talks on Deyslide'))
  await expect(citra).toHaveURL(/\/sign-up$/)
  await signUp(citra, 'Citra', citraEmail, 'correct horse')
  await citra.goto('/')
  await expect(citra.locator('[data-shared-project="Talks"]')).toContainText('Ana · view only')
})
