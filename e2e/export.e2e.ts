import type { Page } from '@playwright/test'
import { readFile } from 'node:fs/promises'
import { expect, test } from '@playwright/test'
import { PDFDocument } from 'pdf-lib'
import { addDeck, createProject, signUp, uniqueEmail } from './helpers'

/** Chooses an export from the deck page's Export menu and returns the saved file's name and pages. */
async function exportPdf(page: Page, option: string) {
  await page.getByTestId('export-menu').click()
  const downloading = page.waitForEvent('download', { timeout: 60_000 })
  await page.getByTestId(option).click()
  const download = await downloading
  const pdf = await PDFDocument.load(await readFile((await download.path())!))
  return { name: download.suggestedFilename(), pages: pdf.getPages().map(item => [Math.round(item.getWidth()), Math.round(item.getHeight())]) }
}

test('a guest saves a PDF made on the device', async ({ page, isMobile }) => {
  test.skip(isMobile, 'The same page on phones; one run is enough')
  test.setTimeout(90_000)
  await createProject(page, 'Talks')
  await addDeck(page, 'Graphs', 'blank')
  await page.getByTestId('export-menu').click()
  await expect(page.getByTestId('export-options').getByRole('menuitem')).toHaveText(['PDF (this device)', 'PDF with every click step (this device)'])
  await page.keyboard.press('Escape')

  const file = await exportPdf(page, 'export-device-pdf')
  expect(file).toEqual({ name: 'Graphs.pdf', pages: [[960, 540]] })
  await expect(page.getByTestId('export-status')).toHaveText('Saved Graphs.pdf.')
})

test('a signed in person saves a PDF the server made', async ({ page, isMobile }) => {
  test.skip(isMobile, 'The same page on phones; one run is enough')
  test.setTimeout(120_000)
  await signUp(page, 'Gita', uniqueEmail('gita'), 'correct horse')
  await createProject(page, 'Talks')
  await addDeck(page, 'Graphs', 'blank')
  await page.getByTestId('export-menu').click()
  await expect(page.getByTestId('export-options').getByRole('menuitem')).toHaveText(['PDF', 'PDF with every click step', 'Video (WebM)'])
  await page.keyboard.press('Escape')

  const file = await exportPdf(page, 'export-pdf')
  expect(file).toEqual({ name: 'Graphs.pdf', pages: [[960, 540]] })
  await expect(page.getByTestId('export-status')).toHaveText('Saved Graphs.pdf.')
})
