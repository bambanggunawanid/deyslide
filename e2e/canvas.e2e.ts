import type { CDPSession, Locator, Page } from '@playwright/test'
import { expect, test } from '@playwright/test'
import { addDeck, createProject, openMarkdownView, replaceMarkdown, signUp, uniqueEmail } from './helpers'

// The blank deck's title is a text element at 80, 200, 820 wide, with auto
// height: the slide lays it out 96 units tall, so its middle is 490, 248.
const TITLE = { x: 490, y: 248 }

/** Where a canvas point (980 by 551.25 units) is on the page, at the stage's zoom. */
async function onStage(page: Page, point: { x: number, y: number }) {
  const stage = page.getByTestId('slide-stage')
  await stage.scrollIntoViewIfNeeded()
  const box = (await stage.boundingBox())!
  const scale = box.width / 980
  return { x: box.x + point.x * scale, y: box.y + point.y * scale, scale }
}

async function middleOf(locator: Locator) {
  await locator.scrollIntoViewIfNeeded()
  const box = (await locator.boundingBox())!
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 }
}

/** Fingers on the screen, through Chromium's own touch input, so the page gets real touch pointer events. */
async function touch(client: CDPSession, type: 'touchStart' | 'touchMove' | 'touchEnd', points: { x: number, y: number }[]) {
  await client.send('Input.dispatchTouchEvent', { type, touchPoints: points.map((point, id) => ({ x: point.x, y: point.y, id })) })
}

/** One finger taps a point. */
async function tap(client: CDPSession, point: { x: number, y: number }) {
  await touch(client, 'touchStart', [point])
  await touch(client, 'touchEnd', [])
}

/** The positioned title's place in the preview, as the slide lays it out. */
function previewTitle(page: Page) {
  return page.frameLocator('[data-testid="preview-frame"]').locator('.v-drag[data-id="title"]')
}

test('elements move and resize with the mouse, and undo takes it back', async ({ page, isMobile }) => {
  test.skip(isMobile, 'Phones have their own touch test')
  await createProject(page, 'Talks')
  await addDeck(page, 'Graphs', 'blank')
  await expect(page.getByTestId('design-view')).toBeVisible()
  await expect(previewTitle(page)).toHaveCSS('left', '80px')

  // Drag the title 100 right and 100 down, clear of every snapping line.
  const start = await onStage(page, TITLE)
  await page.mouse.move(start.x, start.y)
  await page.mouse.down()
  await page.mouse.move(start.x + 50 * start.scale, start.y + 50 * start.scale, { steps: 5 })
  await page.mouse.move(start.x + 100 * start.scale, start.y + 100 * start.scale, { steps: 5 })
  await page.mouse.up()
  await expect(previewTitle(page)).toHaveCSS('left', '180px')
  await expect(previewTitle(page)).toHaveCSS('top', '300px')
  await expect(page.getByTestId('save-status')).toHaveText('Saved')

  // Its right handle widens it.
  const handle = await middleOf(page.locator('[data-element="title"] [data-handle="e"]'))
  await page.mouse.move(handle.x, handle.y)
  await page.mouse.down()
  await page.mouse.move(handle.x - 120 * start.scale, handle.y, { steps: 5 })
  await page.mouse.up()
  await expect(previewTitle(page)).toHaveCSS('width', '700px')

  // Undo takes back the resize, then the move.
  await page.keyboard.press('ControlOrMeta+z')
  await expect(previewTitle(page)).toHaveCSS('width', '820px')
  await page.keyboard.press('ControlOrMeta+z')
  await expect(previewTitle(page)).toHaveCSS('left', '80px')
  await page.keyboard.press('ControlOrMeta+Shift+z')
  await expect(previewTitle(page)).toHaveCSS('left', '180px')
  await expect(page.getByTestId('save-status')).toHaveText('Saved')

  await page.reload()
  await openMarkdownView(page)
  await expect(page.locator('.cm-content')).toContainText('<v-drag pos="180,300,820,NaN,0" data-id="title">')
})

test('the canvas, the inspector, the Markdown view and undo work on one deck', async ({ page, isMobile }) => {
  test.skip(isMobile, 'Phones have their own touch test')
  await createProject(page, 'Talks')
  await addDeck(page, 'Graphs', 'blank')
  await expect(previewTitle(page)).toHaveCSS('left', '80px')

  // Move the title 100 right and 100 down, then narrow it from its right handle.
  const start = await onStage(page, TITLE)
  await page.mouse.move(start.x, start.y)
  await page.mouse.down()
  await page.mouse.move(start.x + 100 * start.scale, start.y + 100 * start.scale, { steps: 8 })
  await page.mouse.up()
  const handle = await middleOf(page.locator('[data-element="title"] [data-handle="e"]'))
  await page.mouse.move(handle.x, handle.y)
  await page.mouse.down()
  await page.mouse.move(handle.x - 120 * start.scale, handle.y, { steps: 5 })
  await page.mouse.up()
  await expect(previewTitle(page)).toHaveCSS('width', '700px')
  // The inspector follows.
  await expect(page.getByTestId('inspector-title')).toHaveText('Text')
  await expect(page.getByTestId('field-x')).toHaveValue('180')
  await expect(page.getByTestId('field-w')).toHaveValue('700')

  // The Markdown view has the new place and size at once.
  await openMarkdownView(page)
  await expect(page.locator('.cm-content')).toContainText('<v-drag pos="180,300,700,NaN,0" data-id="title">')
  await page.getByTestId('view-design').click()

  // A double click edits the title in place.
  const title = await onStage(page, { x: 530, y: 348 })
  await page.mouse.dblclick(title.x, title.y)
  await expect(page.getByTestId('inline-editor')).toBeVisible()
  await page.keyboard.type(' rock')
  await expect(previewTitle(page).locator('h1')).toHaveText('Graphs rock')
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('inline-editor')).toHaveCount(0)

  // A rectangle, then its fill from the inspector; a fill it cannot use is refused.
  await page.getByTestId('add-rect').click()
  await expect(page.getByTestId('inspector-title')).toHaveText('Rectangle')
  const shape = page.frameLocator('[data-testid="preview-frame"]').locator('.deyslide-shape')
  await expect(shape).toHaveCSS('background-color', 'rgb(56, 189, 248)')
  await page.getByTestId('field-fill').fill('rgb(255, 0, 0')
  await page.getByTestId('field-fill').press('Enter')
  await expect(page.getByTestId('field-fill-problem')).toHaveText('Enter a color, such as #38bdf8 or red.')
  await page.getByTestId('field-fill').fill('#ff0000')
  await page.getByTestId('field-fill').press('Enter')
  await expect(shape).toHaveCSS('background-color', 'rgb(255, 0, 0)')
  await expect(page.getByTestId('field-fill-problem')).toHaveCount(0)

  // Undo on the slide takes back the fill, then the rectangle.
  await page.getByTestId('slide-stage').focus()
  await page.keyboard.press('ControlOrMeta+z')
  await expect(shape).toHaveCSS('background-color', 'rgb(56, 189, 248)')
  await page.keyboard.press('ControlOrMeta+z')
  await expect(shape).toHaveCount(0)
  await page.keyboard.press('ControlOrMeta+Shift+z')
  await expect(shape).toHaveCount(1)

  // The strip draws the slide as it is now.
  await expect(page.frameLocator('[data-testid="strip-preview"]').locator('h1')).toHaveText('Graphs rock')
  await expect(page.getByTestId('save-status')).toHaveText('Saved')
})

test('boxes are as tall as the slide lays out their text, and Enter presses toolbar buttons', async ({ page, isMobile }) => {
  test.skip(isMobile, 'Phones have their own touch test')
  await createProject(page, 'Talks')
  await addDeck(page, 'Graphs', 'blank')
  // The title becomes a heading over a paragraph that wraps in a narrow box:
  // only the slide's own layout knows how tall that is.
  await replaceMarkdown(page, '<v-drag pos="80,60,300,NaN,0" data-id="title">\n\n# Notes\n\nA paragraph long enough to wrap over several lines inside a narrow box on the slide.\n\n</v-drag>\n')
  await page.getByTestId('view-design').click()
  await expect(previewTitle(page)).toHaveCSS('width', '300px')
  const laidOut = await previewTitle(page).evaluate(element => (element as HTMLElement).offsetHeight)
  const drawn = async () => {
    const scale = (await page.getByTestId('stage-sheet').boundingBox())!.width / 980
    return Math.round((await page.locator('[data-element="title"]').boundingBox())!.height / scale)
  }
  await expect.poll(drawn).toBe(laidOut)

  // A click just above the bottom of its text selects it.
  const low = await onStage(page, { x: 230, y: 60 + laidOut - 6 })
  await page.mouse.click(low.x, low.y)
  await expect(page.locator('[data-element="title"]')).toHaveAttribute('data-selected', 'true')

  // With it selected, Enter on a focused toolbar button adds a rectangle each time.
  await page.getByTestId('add-rect').focus()
  await page.keyboard.press('Enter')
  await page.keyboard.press('Enter')
  await expect(page.locator('[data-testid="element-box"][data-type="shape"]')).toHaveCount(2)
  await expect(page.getByTestId('inline-editor')).toHaveCount(0)
})

test('fingers move elements, pinch to zoom and reorder slides with a long press', async ({ page, isMobile }) => {
  test.skip(!isMobile, 'Touch runs on the phone')
  await createProject(page, 'Talks')
  await addDeck(page, 'Graphs', 'blank')
  await expect(previewTitle(page)).toHaveCSS('left', '80px')
  const client = await page.context().newCDPSession(page)

  // A tap selects the title, and the inspector's sheet names it.
  const start = await onStage(page, TITLE)
  await tap(client, start)
  await expect(page.locator('[data-element="title"]')).toHaveAttribute('data-selected', 'true')
  await expect(page.getByTestId('inspector')).toHaveAttribute('data-sheet', 'closed')
  await expect(page.getByTestId('inspector-toggle')).toContainText('Text')
  // The strip has titles only on a phone.
  await expect(page.getByTestId('strip-thumbnail')).toHaveCount(0)
  await page.waitForTimeout(500)

  // One finger drags the title 100 right and 100 down.
  await touch(client, 'touchStart', [start])
  for (let step = 1; step <= 5; step++)
    await touch(client, 'touchMove', [{ x: start.x + 20 * step * start.scale, y: start.y + 20 * step * start.scale }])
  await touch(client, 'touchEnd', [])
  await expect(previewTitle(page)).toHaveCSS('left', '180px')
  await expect(previewTitle(page)).toHaveCSS('top', '300px')

  // Two fingers spread apart to twice the distance: twice the zoom.
  const fit = Number.parseInt(await page.getByTestId('zoom-level').textContent() ?? '', 10)
  const middle = await onStage(page, { x: 490, y: 275 })
  const apart = (distance: number) => [{ x: middle.x - distance / 2, y: middle.y }, { x: middle.x + distance / 2, y: middle.y }]
  await touch(client, 'touchStart', apart(60))
  for (const distance of [80, 100, 120])
    await touch(client, 'touchMove', apart(distance))
  await touch(client, 'touchEnd', [])
  await expect(page.getByTestId('zoom-level')).toHaveText(`${fit * 2}%`)
  await page.getByTestId('zoom').selectOption('fit')
  await expect(page.getByTestId('zoom-level')).toHaveText(`${fit}%`)

  // A double tap on the title edits it in place, and typing goes after its text.
  const title = await onStage(page, { x: 590, y: 348 })
  await tap(client, title)
  await page.waitForTimeout(100)
  await tap(client, title)
  await expect(page.getByTestId('inline-editor')).toBeVisible()
  await page.keyboard.type(' rock')
  await expect(previewTitle(page).locator('h1')).toHaveText('Graphs rock')
  // A tap elsewhere on the slide closes the editor.
  await tap(client, await onStage(page, { x: 100, y: 60 }))
  await expect(page.getByTestId('inline-editor')).toHaveCount(0)

  // A second slide, then a long press drags it before the first.
  await page.getByTestId('add-slide').click()
  await expect(page.getByTestId('slide-position')).toHaveText('Slide 2 of 2')
  const titles = page.getByTestId('strip-title')
  await expect(titles).toHaveText(['Graphs rock', 'Empty slide'])
  const second = await middleOf(page.getByTestId('strip-slide').nth(1))
  const first = await middleOf(page.getByTestId('strip-slide').nth(0))
  await touch(client, 'touchStart', [second])
  await page.waitForTimeout(600)
  for (const x of [second.x - 40, first.x, first.x - 50])
    await touch(client, 'touchMove', [{ x, y: second.y }])
  await touch(client, 'touchEnd', [])
  await expect(titles).toHaveText(['Empty slide', 'Graphs rock'])
  await expect(page.getByTestId('slide-position')).toHaveText('Slide 1 of 2')
})

test('a dialog opened on a phone shows above the inspector\'s sheet', async ({ page, isMobile }) => {
  test.skip(!isMobile, 'The inspector is a sheet on phones only')
  await signUp(page, 'Ana', uniqueEmail('ana'), 'correct horse')
  await createProject(page, 'Talks')
  await addDeck(page, 'Graphs', 'blank')
  await page.getByTestId('inspector-toggle').click()
  await expect(page.getByTestId('inspector')).toHaveAttribute('data-sheet', 'open')

  await page.getByTestId('share-deck').click()
  await expect(page.getByTestId('share-dialog')).toBeVisible()
  // What the screen shows on top at the dialog's middle, and at the sheet's bar.
  // The open dialog turns pointer events off outside it, which hit testing
  // would skip, so they are on everywhere while the page is asked.
  const onTop = await page.evaluate(() => {
    const style = document.createElement('style')
    style.textContent = '* { pointer-events: auto !important; }'
    document.head.append(style)
    const topmost = (box: DOMRect, x: number, y: number) => document.elementFromPoint(box.x + x, box.y + y)
    const dialog = document.querySelector('[data-testid="share-dialog"]')!.getBoundingClientRect()
    const bar = document.querySelector('[data-testid="inspector-toggle"]')!.getBoundingClientRect()
    const seen = {
      dialog: Boolean(topmost(dialog, dialog.width / 2, dialog.height / 2)?.closest('[data-testid="share-dialog"]')),
      sheet: Boolean(topmost(bar, 8, bar.height / 2)?.closest('[data-testid="inspector"]')),
      overlaps: dialog.bottom > document.querySelector('[data-testid="inspector"]')!.getBoundingClientRect().top,
    }
    style.remove()
    return seen
  })
  expect(onTop).toEqual({ dialog: true, sheet: false, overlaps: true })
})
