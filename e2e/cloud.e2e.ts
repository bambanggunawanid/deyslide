import { expect, test } from '@playwright/test'
import { addDeck, createProject, signIn, signUp, uniqueEmail } from './helpers'

test('browser projects move into the account and open on another device', async ({ page, browser }) => {
  const email = uniqueEmail('eka')
  await createProject(page, 'Algorithms 101')
  await addDeck(page, 'Sorting', 'demo')
  const deckPath = new URL(page.url()).pathname

  await signUp(page, 'Eka', email, 'correct horse')
  await expect(page.getByTestId('workspace-notice')).toContainText('Moved 1 project from this browser to your account.')
  await expect(page.locator('[data-project="Algorithms 101"]')).toContainText('1 deck')

  // The link from before signing up still opens the deck, now from the account.
  await page.goto(deckPath)
  await expect(page.getByTestId('slide-title')).toHaveCount(5)

  const laptop = await browser.newContext()
  const other = await laptop.newPage()
  await signIn(other, email, 'correct horse')
  await other.locator('[data-project="Algorithms 101"]').click()
  await other.locator('[data-deck="Sorting"]').click()
  await expect(other.getByTestId('slide-title').first()).toHaveText('Deyslide')
  await laptop.close()
})

test('signing out shows the browser again', async ({ page }) => {
  const email = uniqueEmail('fitri')
  await signUp(page, 'Fitri', email, 'correct horse')
  await createProject(page, 'Cloud only')
  await page.getByTestId('account-menu').click()
  await page.getByTestId('sign-out').click()
  await expect(page.getByTestId('empty-projects')).toBeVisible()
  await expect(page.getByTestId('guest-banner')).toBeVisible()
})
