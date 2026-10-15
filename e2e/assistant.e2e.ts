import { expect, test } from '@playwright/test'
import { addDeck, createProject, openMarkdownView, signUp, slide, uniqueEmail } from './helpers'

test('the assistant adds a slide that shows in the preview, and undo takes it back', async ({ page }) => {
  await signUp(page, 'Hana', uniqueEmail('hana'), 'correct horse')
  await createProject(page, 'Talks')
  await addDeck(page, 'Recursion', 'blank')

  await expect(page.getByTestId('assistant-allowance')).toHaveText('0% of this month\'s allowance used')
  await page.getByTestId('assistant-input').fill('Add a slide about recursion')
  await page.getByTestId('assistant-send').click()

  await expect(page.getByTestId('assistant-changes')).toHaveText('Added slide 2')
  await expect(page.getByTestId('assistant-assistant').last()).toContainText('Done. Have a look at the preview.')
  await expect(page.getByTestId('slide-position')).toHaveText('Slide 2 of 2')
  await expect(slide(page).locator('h1')).toHaveText('Recursion')
  await expect(page.getByTestId('save-status')).toHaveText('Saved')

  await page.getByTestId('assistant-undo').click()
  await expect(page.getByTestId('slide-position')).toHaveText('Slide 1 of 1')
  await expect(page.getByTestId('save-status')).toHaveText('Saved')
})

test('in the Markdown view the preview keeps the slide the assistant added until the cursor moves', async ({ page, isMobile }) => {
  await signUp(page, 'Hana', uniqueEmail('hana'), 'correct horse')
  await createProject(page, 'Talks')
  await addDeck(page, 'Graphs', 'blank')
  await openMarkdownView(page)

  // Hana was writing on the first slide. Phones show the assistant with the preview.
  await page.locator('.cm-line', { hasText: '# Graphs' }).click()
  if (isMobile)
    await page.getByTestId('tab-preview').click()
  await expect(page.getByTestId('slide-position')).toHaveText('Slide 1 of 1')

  await page.getByTestId('assistant-input').fill('Add a slide about recursion')
  await page.getByTestId('assistant-send').click()
  await expect(page.getByTestId('assistant-changes')).toHaveText('Added slide 2')
  await expect(page.getByTestId('assistant-send')).toHaveText('Send')
  await expect(page.getByTestId('save-status')).toHaveText('Saved')
  await expect(page.getByTestId('slide-position')).toHaveText('Slide 2 of 2')
  await expect(slide(page).locator('h1')).toHaveText('Recursion')
  // The editor has the new slide too, and the preview stays on it.
  await expect(page.locator('.cm-content')).toContainText('A few words about recursion.')
  await page.waitForTimeout(500)
  await expect(page.getByTestId('slide-position')).toHaveText('Slide 2 of 2')

  // Moving the cursor brings the preview back to the slide under it.
  if (isMobile)
    await page.getByTestId('tab-write').click()
  await page.locator('.cm-line', { hasText: '# Graphs' }).click()
  if (isMobile)
    await page.getByTestId('tab-preview').click()
  await expect(page.getByTestId('slide-position')).toHaveText('Slide 1 of 2')
  await expect(slide(page).locator('h1')).toHaveText('Graphs')
})

test('guests are asked to sign in before using the assistant', async ({ page }) => {
  await createProject(page, 'Talks')
  await addDeck(page, 'Notes', 'blank')
  await expect(page.getByTestId('assistant-sign-in')).toContainText('to use the assistant')
  await expect(page.getByTestId('assistant-input')).toHaveCount(0)
})
