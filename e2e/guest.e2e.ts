import { expect, test } from '@playwright/test'
import { addDeck, createProject, slide } from './helpers'

test('a guest creates a project and a demo deck that survive a reload', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByTestId('empty-projects')).toContainText('No projects yet')
  await expect(page.getByTestId('guest-banner')).toContainText('saved in this browser only')

  await createProject(page, 'Algorithms 101')
  await expect(page.getByTestId('empty-decks')).toBeVisible()
  await addDeck(page, 'Sorting', 'demo')
  await expect(page.getByTestId('slide-position')).toHaveText('Slide 1 of 5')
  await expect(slide(page).locator('h1')).toHaveText('Deyslide')

  await page.reload()
  await expect(page.getByTestId('slide-position')).toHaveText('Slide 1 of 5')
  await page.goto('/')
  await expect(page.locator('[data-project="Algorithms 101"]')).toContainText('1 deck')
})

test('a guest downloads a deck as Slidev Markdown', async ({ page }) => {
  await createProject(page, 'Talks')
  await addDeck(page, 'Graphs', 'blank')
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByTestId('download-markdown').click()])
  expect(download.suggestedFilename()).toBe('Graphs.md')
  const markdown = await (await download.createReadStream()).toArray()
  expect(Buffer.concat(markdown).toString()).toContain('# Graphs')
})

test('a guest renames and deletes a project', async ({ page }) => {
  await createProject(page, 'Draft')
  await page.getByRole('button', { name: 'Rename' }).click()
  await page.getByTestId('name-input').fill('Final')
  await page.getByTestId('name-submit').click()
  await expect(page.getByTestId('project-name')).toHaveText('Final')
  await page.getByTestId('delete-project').click()
  await page.getByTestId('confirm-action').click()
  await expect(page.getByTestId('empty-projects')).toBeVisible()
})
