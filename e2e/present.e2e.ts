import type { Locator, Page } from '@playwright/test'
import { expect, test } from '@playwright/test'
import { addDeck, createProject, replaceMarkdown } from './helpers'

/**
 * The slide the audience view shows, inside its sandboxed preview frame:
 * the newest one, since the slide being left stays during its transition.
 */
function shown(page: Page) {
  return page.frameLocator('[data-testid="present-page"] [data-testid="preview-frame"]').getByTestId('slide').locator('.preview-slide').last()
}

/** Shows the controls, which hide while the pointer rests. */
async function wake(page: Page) {
  await page.mouse.move(10, 10)
  await page.mouse.move(20, 20)
  await expect(page.getByTestId('present-controls')).toBeVisible()
}

/** Swipes across the slide with a finger, through the browser's touch input. */
async function swipe(page: Page, from: number, to: number) {
  const touch = await page.context().newCDPSession(page)
  const y = (page.viewportSize()?.height ?? 600) / 2
  const at = (x: number) => [{ x, y, id: 1 }]
  await touch.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: at(from) })
  for (let step = 1; step <= 8; step++)
    await touch.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: at(from + (to - from) * step / 8) })
  await touch.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
  await touch.detach()
}

/** Taps the middle of an element with a finger. */
async function tap(page: Page, locator: Locator) {
  await locator.scrollIntoViewIfNeeded()
  const box = (await locator.boundingBox())!
  await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2)
}

/** On a phone, the controls come back from their button, without moving the talk. */
async function showControls(page: Page) {
  await tap(page, page.getByTestId('present-menu'))
  await expect(page.getByTestId('present-controls')).toBeVisible()
}

test('present a deck: keys and taps step through clicks, the overview and go to', async ({ page, isMobile }) => {
  test.setTimeout(60_000)
  await createProject(page, 'Talks')
  await addDeck(page, 'Sorting', 'demo')
  await page.getByTestId('present-deck').click()

  await expect(page).toHaveURL(/\/present/)
  await expect(page.getByTestId('present-position')).toHaveText('1 / 5')
  await expect(shown(page).locator('.slidev-layout.cover h1')).toHaveText('Deyslide')
  // The page is the slide alone: no site header.
  await expect(page.locator('header')).toHaveCount(0)

  const width = page.viewportSize()!.width
  if (isMobile) {
    // A tap on the right two thirds goes on, a swipe to the left too, and a tap on the left third goes back.
    // The slide fills the phone's width, so these land on the slide itself, which passes them on.
    await page.touchscreen.tap(width - 40, 300)
    await expect(page.getByTestId('present-position')).toHaveText('2 / 5')
    await swipe(page, width - 60, 60)
    await expect(shown(page).locator('.slidev-code-magic-move')).toContainText('prices.reduce')
    await page.touchscreen.tap(20, 300)
    await expect(shown(page).locator('.slidev-code-magic-move')).toContainText('let total = 0')
    await swipe(page, 60, width - 60)
    await expect(page.getByTestId('present-position')).toHaveText('1 / 5')
    await page.touchscreen.tap(width - 40, 300)
    await expect(page.getByTestId('present-position')).toHaveText('2 / 5')
  }
  else {
    await page.keyboard.press('ArrowRight')
    await expect(page.getByTestId('present-position')).toHaveText('2 / 5')
    await expect(shown(page).locator('.slidev-code-magic-move')).toContainText('let total = 0')
    // Clicks first, then the next slide.
    await page.keyboard.press('Space')
    await expect(shown(page).locator('.slidev-code-magic-move')).toContainText('prices.reduce')
    await expect(page.getByTestId('present-clicks')).toHaveText('Click 1 of 2')
    await page.mouse.click(width - 100, 300)
    await page.keyboard.press('n')
    await expect(page.getByTestId('present-position')).toHaveText('3 / 5')
    await expect(shown(page).locator('.col-left h1')).toHaveText('Spatial zoom')
    // Back into slide 2 opens it at its last click.
    await page.keyboard.press('ArrowLeft')
    await expect(page.getByTestId('present-position')).toHaveText('2 / 5')
    await expect(page.getByTestId('present-clicks')).toHaveText('Click 2 of 2')
    await page.mouse.click(40, 300)
    await expect(page.getByTestId('present-clicks')).toHaveText('Click 1 of 2')
  }

  // The overview: every slide, and a click goes there.
  if (isMobile) {
    // Taps moved the talk without showing the controls; their button brings them back, and moves nothing.
    await expect(page.getByTestId('present-controls')).toBeHidden()
    await showControls(page)
    await expect(page.getByTestId('present-position')).toHaveText('2 / 5')
    await tap(page, page.getByTestId('present-overview'))
  }
  else {
    await page.keyboard.press('o')
  }
  const tiles = page.locator('[data-overview-slide]')
  await expect(tiles).toHaveCount(5)
  await expect(tiles.nth(2)).toContainText('Spatial zoom')
  await expect(page.locator('[data-overview-slide="2"]')).toHaveAttribute('aria-current', 'true')
  // Pictures of the slides arrive one by one, after the titles.
  // The slide on screen is drawn first.
  await expect(page.locator('[data-overview-slide="2"] img')).toBeVisible({ timeout: 15_000 })
  if (isMobile)
    await tap(page, page.locator('[data-overview-slide="4"]'))
  else
    await page.locator('[data-overview-slide="4"]').click()
  await expect(page.getByTestId('present-overview-grid')).toHaveCount(0)
  await expect(page.getByTestId('present-position')).toHaveText('4 / 5')
  await expect(shown(page).locator('motion-canvas-player')).toHaveCount(1)

  // Go to a slide by its number.
  if (isMobile) {
    await showControls(page)
    await tap(page, page.getByTestId('present-goto'))
  }
  else {
    await page.keyboard.press('g')
  }
  await page.getByTestId('goto-input').fill('3')
  await page.getByTestId('goto-input').press('Enter')
  await expect(page.getByTestId('present-position')).toHaveText('3 / 5')
  await expect(shown(page).locator('.col-left h1')).toHaveText('Spatial zoom')

  // Escape goes back to the editor.
  if (isMobile) {
    await showControls(page)
    await tap(page, page.getByTestId('present-exit'))
  }
  else {
    await page.keyboard.press('Escape')
  }
  await expect(page.getByTestId('deck-name')).toHaveText('Sorting')
})

test('the project page presents a deck, and the controls hide while the pointer rests', async ({ page, isMobile }) => {
  test.skip(isMobile, 'The pointer resting is a mouse matter')
  await createProject(page, 'Talks')
  await addDeck(page, 'Sorting', 'demo')
  await page.getByRole('link', { name: 'Talks' }).click()
  await page.locator('[data-present="Sorting"]').click()
  await expect(page.getByTestId('present-position')).toHaveText('1 / 5')
  await wake(page)
  await expect(page.getByTestId('present-page')).toHaveAttribute('data-idle', 'true', { timeout: 5000 })
  await expect(page.getByTestId('present-controls')).toBeHidden()
  await wake(page)
})

test('the presenter view and the audience window stay in step', async ({ page, isMobile }) => {
  test.skip(isMobile, 'Phones present in one window')
  await createProject(page, 'Talks')
  await addDeck(page, 'Sorting', 'demo')

  // The presenter view opens the audience window by itself.
  const opening = page.waitForEvent('popup')
  await page.getByTestId('presenter-deck').click()
  const audience = await opening
  await expect(page.getByTestId('presenter-slide')).toHaveText('Slide 1 of 5')
  await expect(page.getByTestId('presenter-notes')).toContainText('Welcome everyone.')
  await expect(page.getByTestId('presenter-next')).toContainText('Next: Slide 2')
  await expect(audience.getByTestId('present-position')).toHaveText('1 / 5')
  await expect(shown(audience).locator('.slidev-layout.cover h1')).toHaveText('Deyslide')

  // The presenter moves the talk.
  await page.getByTestId('presenter-next-step').click()
  await expect(page.getByTestId('presenter-slide')).toHaveText('Slide 2 of 5')
  await expect(audience.getByTestId('present-position')).toHaveText('2 / 5')
  await expect(shown(audience).locator('.slidev-code-magic-move')).toContainText('let total = 0')

  // The audience window moves it too.
  await audience.bringToFront()
  await audience.keyboard.press('ArrowRight')
  await expect(shown(audience).locator('.slidev-code-magic-move')).toContainText('prices.reduce')
  await expect(page.getByTestId('presenter-click')).toHaveText('Click 1 of 2')
  await expect(page.getByTestId('presenter-notes')).toContainText('Step 1: ask the room')
  await expect(page.frameLocator('[data-testid="presenter-current"] [data-testid="preview-frame"]').locator('.slidev-code-magic-move')).toContainText('prices.reduce')

  // Keys in the presenter view drive both.
  await page.bringToFront()
  await page.keyboard.press('ArrowRight')
  await page.keyboard.press('ArrowRight')
  await expect(page.getByTestId('presenter-slide')).toHaveText('Slide 3 of 5')
  await expect(audience.getByTestId('present-position')).toHaveText('3 / 5')

  // A click on Previous or Reset leaves Space and Enter to the talk, rather than press the button again.
  await page.getByTestId('presenter-previous').click()
  await expect(page.getByTestId('presenter-click')).toHaveText('Click 2 of 2')
  await page.keyboard.press('Space')
  await expect(page.getByTestId('presenter-slide')).toHaveText('Slide 3 of 5')
  await page.getByTestId('presenter-reset').click()
  await page.keyboard.press('Enter')
  await expect(page.getByTestId('presenter-click')).toHaveText('Click 1 of 3')
  await expect(audience.getByTestId('present-clicks')).toHaveText('Click 1 of 3')
})

test('presenting starts on the slide open in the editor, and the editor comes back on the slide the talk ended on', async ({ page, isMobile }) => {
  test.skip(isMobile, 'The keys are a computer matter')
  await createProject(page, 'Talks')
  await addDeck(page, 'Sorting', 'demo')
  await page.getByTestId('next-slide').click()
  await page.getByTestId('next-slide').click()
  await expect(page.getByTestId('slide-position')).toHaveText('Slide 3 of 5')
  await page.getByTestId('present-deck').click()
  await expect(page.getByTestId('present-position')).toHaveText('3 / 5')
  await expect(shown(page).locator('.col-left h1')).toHaveText('Spatial zoom')
  await page.keyboard.press('End')
  await expect(page.getByTestId('present-position')).toHaveText('5 / 5')
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('slide-position')).toHaveText('Slide 5 of 5')
})

test('on a phone, the presenter view shows the notes right after the slide', async ({ page, isMobile }) => {
  test.skip(!isMobile, 'A phone layout')
  await createProject(page, 'Talks')
  await addDeck(page, 'Sorting', 'demo')
  await page.getByTestId('presenter-deck').click()
  await expect(page.getByTestId('presenter-slide')).toHaveText('Slide 1 of 5')
  const notes = page.getByTestId('presenter-notes')
  await expect(notes).toContainText('Welcome everyone.')
  const notesBox = (await notes.boundingBox())!
  const nextBox = (await page.getByTestId('presenter-next').boundingBox())!
  const height = page.viewportSize()!.height
  // The notes start in the top part of the screen, before the next step.
  expect(notesBox.y).toBeLessThan(nextBox.y)
  expect(notesBox.y).toBeLessThan(height * 0.6)
})

test('the slide\'s own controls work while presenting, and the keys keep moving the talk', async ({ page, isMobile }) => {
  test.skip(isMobile, 'The pointer and the keys are a computer matter')
  await createProject(page, 'Talks')
  await addDeck(page, 'Workshop', 'blank')
  await replaceMarkdown(page, `# Sandbox

<DeyslideLiveSandbox title="Controls" :initial="{ zoom: 1 }">
  <template #default="{ state }">
    <p class="zoom">Zoom {{ state.zoom }}</p>
  </template>
</DeyslideLiveSandbox>

---

# After
`)
  await expect(page.getByTestId('slide-position')).toContainText('of 2')
  // The talk starts on the slide open in the editor, so open the first.
  if (await page.getByTestId('slide-position').textContent() !== 'Slide 1 of 2')
    await page.getByTestId('previous-slide').click()
  await expect(page.getByTestId('slide-position')).toHaveText('Slide 1 of 2')
  await page.getByTestId('present-deck').click()
  await expect(page.getByTestId('present-position')).toHaveText('1 / 2')

  // A click on the sandbox's button changes the sandbox, and the talk stays.
  const plus = shown(page).getByTestId('inc-zoom')
  const box = (await plus.boundingBox())!
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
  await expect(shown(page).locator('.zoom')).toHaveText('Zoom 2')
  await expect(page.getByTestId('present-position')).toHaveText('1 / 2')
  // Once the pointer rests, it hides over the slide too, and the button still works.
  await expect(page.getByTestId('present-page')).toHaveAttribute('data-idle', 'true', { timeout: 5000 })
  const slideFrame = page.frameLocator('[data-testid="present-page"] [data-testid="preview-frame"]')
  await expect.poll(() => slideFrame.locator('.slidev-page').evaluate(element => getComputedStyle(element).cursor)).toBe('none')
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
  await expect(shown(page).locator('.zoom')).toHaveText('Zoom 3')
  await expect(page.getByTestId('present-position')).toHaveText('1 / 2')
  // A mouse drag across the slide, to select its text, moves nothing either way.
  for (const [from, to] of [[900, 650], [300, 600]]) {
    await page.mouse.move(from, 330)
    await page.mouse.down()
    await page.mouse.move(to, 334, { steps: 6 })
    await page.mouse.up()
    await expect(page.getByTestId('present-position')).toHaveText('1 / 2')
  }
  // The slide has the focus now, and still lets the arrows move the talk.
  await page.keyboard.press('ArrowRight')
  await expect(page.getByTestId('present-position')).toHaveText('2 / 2')
  await page.keyboard.press('ArrowLeft')
  await expect(page.getByTestId('present-position')).toHaveText('1 / 2')

  // Ticking Loop, or pressing a control, leaves the keys to the talk.
  await wake(page)
  await page.getByTestId('present-loop').click()
  await expect(page.getByTestId('present-loop')).toBeChecked()
  await page.keyboard.press('ArrowRight')
  await expect(page.getByTestId('present-position')).toHaveText('2 / 2')
  await wake(page)
  await page.getByTestId('present-previous').click()
  await expect(page.getByTestId('present-position')).toHaveText('1 / 2')
  await page.keyboard.press('Space')
  await expect(page.getByTestId('present-position')).toHaveText('2 / 2')
})

test('the presenter view keeps the keys after a click on its slides, and finds its audience window again', async ({ page, isMobile }) => {
  test.skip(isMobile, 'Phones present in one window')
  await createProject(page, 'Talks')
  await addDeck(page, 'Sorting', 'demo')
  const opening = page.waitForEvent('popup')
  await page.getByTestId('presenter-deck').click()
  let audience = await opening
  await expect(audience.getByTestId('present-position')).toHaveText('1 / 5')
  await expect(page.getByTestId('presenter-slide')).toHaveText('Slide 1 of 5')

  // A click on the slide the presenter sees does not take the keys away.
  const current = (await page.locator('[data-testid="presenter-current"] [data-testid="preview-frame"]').boundingBox())!
  await page.mouse.click(current.x + current.width / 2, current.y + current.height / 2)
  await page.keyboard.press('ArrowRight')
  await expect(page.getByTestId('presenter-slide')).toHaveText('Slide 2 of 5')
  await expect(audience.getByTestId('present-position')).toHaveText('2 / 5')

  // Reloading the presenter view finds the audience window as it is, rather than load it again.
  await audience.evaluate(() => {
    (window as unknown as { stayed: boolean }).stayed = true
  })
  await page.reload()
  await expect(page.getByTestId('presenter-slide')).toHaveText('Slide 2 of 5')
  expect(await audience.evaluate(() => (window as unknown as { stayed?: boolean }).stayed)).toBe(true)
  await expect(audience.getByTestId('present-position')).toHaveText('2 / 5')

  // Escape in the audience window closes it, and the presenter view opens it again on the talk.
  const closed = audience.waitForEvent('close')
  await audience.bringToFront()
  await audience.keyboard.press('Escape').catch(() => {})
  await closed
  await page.bringToFront()
  const reopening = page.waitForEvent('popup')
  await page.getByTestId('open-audience').click()
  audience = await reopening
  await expect(audience.getByTestId('present-position')).toHaveText('2 / 5')
})

