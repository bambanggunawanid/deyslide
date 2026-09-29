import { expect, test } from '@playwright/test'
import { addDeck, createProject, replaceMarkdown, signUp, slide, uniqueEmail } from './helpers'

test('the preview shows the slide being written', async ({ page, isMobile }) => {
  await createProject(page, 'Talks')
  await addDeck(page, 'Graphs', 'blank')
  if (isMobile)
    await page.getByTestId('tab-write').click()
  await replaceMarkdown(page, '# Hello\n\nA **bold** idea')
  if (isMobile)
    await page.getByTestId('tab-preview').click()
  await expect(slide(page).locator('h1')).toHaveText('Hello')
  await expect(slide(page).locator('strong')).toHaveText('bold')
})

test('the demo deck renders the way Slidev does', async ({ page, isMobile }) => {
  test.skip(isMobile, 'The slide buttons are the same on phones; one run is enough')
  await createProject(page, 'Algorithms 101')
  await addDeck(page, 'Sorting', 'demo')

  // Slide 1: the cover, with the 3D scene behind the title.
  await expect(slide(page).locator('.slidev-layout.cover h1')).toHaveText('Deyslide')
  await expect(slide(page).locator('canvas')).toHaveCount(1)

  // Slide 2: a Magic Move that morphs on each click.
  await page.getByTestId('next-slide').click()
  await expect(slide(page).locator('.slidev-code-magic-move')).toContainText('let total = 0')
  await expect(page.getByTestId('click-position')).toHaveText('Click 0 of 2')
  await page.getByTestId('next-click').click()
  await expect(slide(page).locator('.slidev-code-magic-move')).toContainText('prices.reduce')

  // Slide 3: two columns, with list items revealed one click at a time.
  await page.getByTestId('next-slide').click()
  await expect(slide(page).locator('.col-left h1')).toHaveText('Spatial zoom')
  const items = slide(page).locator('.col-left li')
  await expect(items).toHaveCount(3)
  await expect(items.nth(0)).toHaveClass(/slidev-vclick-hidden/)
  await page.getByTestId('next-click').click()
  await page.getByTestId('next-click').click()
  await expect(items.nth(1)).not.toHaveClass(/slidev-vclick-hidden/)
  await expect(items.nth(2)).toHaveClass(/slidev-vclick-hidden/)

  // Slide 4: the Motion Canvas player.
  await page.getByTestId('next-slide').click()
  await expect(slide(page).locator('motion-canvas-player')).toHaveCount(1)

  // Slide 5: the live sandbox with its controls.
  await page.getByTestId('next-slide').click()
  await expect(slide(page)).toContainText('How does the cache stay fresh?')
})

test('changes are saved and survive a reload', async ({ page, isMobile }) => {
  await createProject(page, 'Talks')
  await addDeck(page, 'Notes', 'blank')
  if (isMobile)
    await page.getByTestId('tab-write').click()
  await replaceMarkdown(page, '# Saved heading')
  await expect(page.getByTestId('save-status')).toHaveText('Saved')
  await page.reload()
  await expect(page.locator('.cm-content')).toContainText('# Saved heading')
})

test('a deck cannot reach the app or the API from the preview', async ({ page, isMobile }) => {
  test.skip(isMobile, 'The sandbox does not depend on the screen size')
  await signUp(page, 'Gita', uniqueEmail('gita'), 'correct horse')
  await createProject(page, 'Secret')
  await addDeck(page, 'Deck', 'blank')
  const frame = page.frames().find(item => item.url().endsWith('/preview.html'))!
  const outcome = await frame.evaluate(async () => {
    const reachesParent = (() => {
      try {
        return Boolean(window.parent.document)
      }
      catch {
        return false
      }
    })()
    let api: string
    try {
      const response = await fetch('/api/projects', { credentials: 'include' })
      api = `status ${response.status}`
    }
    catch {
      api = 'blocked'
    }
    return { reachesParent, api }
  })
  expect(outcome).toEqual({ reachesParent: false, api: 'blocked' })
})
