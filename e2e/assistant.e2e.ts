import { expect, test } from '@playwright/test'
import { addDeck, createProject, signUp, slide, uniqueEmail } from './helpers'

test('the assistant adds a slide that shows in the preview, and undo takes it back', async ({ page, isMobile }) => {
  await signUp(page, 'Hana', uniqueEmail('hana'), 'correct horse')
  await createProject(page, 'Talks')
  await addDeck(page, 'Recursion', 'blank')
  if (isMobile)
    await page.getByTestId('tab-preview').click()

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

test('guests are asked to sign in before using the assistant', async ({ page, isMobile }) => {
  await createProject(page, 'Talks')
  await addDeck(page, 'Notes', 'blank')
  if (isMobile)
    await page.getByTestId('tab-preview').click()
  await expect(page.getByTestId('assistant-sign-in')).toContainText('to use the assistant')
  await expect(page.getByTestId('assistant-input')).toHaveCount(0)
})
