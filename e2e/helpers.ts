import type { Page } from '@playwright/test'
import { expect } from '@playwright/test'

const API = 'http://127.0.0.1:3101'

/** An address no other test uses, since every test shares one server. */
export function uniqueEmail(name: string) {
  return `${name}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`
}

/** The first link in the newest email to `to`, waiting for it to arrive. */
export async function emailLink(to: string, subject: string) {
  let link = ''
  await expect.poll(async () => {
    const response = await fetch(`${API}/__e2e/emails/${encodeURIComponent(to)}`)
    if (!response.ok)
      return ''
    const email = await response.json() as { subject: string, text: string }
    link = email.subject === subject ? email.text.match(/https?:\/\/\S+/)?.[0] ?? '' : ''
    return link
  }, { message: `waiting for "${subject}" to ${to}` }).not.toBe('')
  return link
}

export async function createProject(page: Page, name: string) {
  await page.goto('/')
  await page.getByTestId('new-project').click()
  await page.getByTestId('name-input').fill(name)
  await page.getByTestId('name-submit').click()
  await expect(page.getByTestId('project-name')).toHaveText(name)
}

/** Adds a deck to the open project page and waits for the editor. */
export async function addDeck(page: Page, name: string, template: 'blank' | 'demo') {
  await page.getByTestId('new-deck').click()
  await page.locator(`[data-template="${template}"]`).click()
  await page.getByTestId('name-input').fill(name)
  await page.getByTestId('name-submit').click()
  await expect(page.getByTestId('slide-position')).toContainText('Slide 1 of')
}

/** The slide inside the sandboxed preview frame. */
export function slide(page: Page) {
  return page.frameLocator('[data-testid="preview-frame"]').getByTestId('slide')
}

/** Replaces everything in the Markdown editor. */
export async function replaceMarkdown(page: Page, markdown: string) {
  const editor = page.locator('.cm-content')
  await editor.click()
  await page.keyboard.press('ControlOrMeta+A')
  await page.keyboard.press('Delete')
  await editor.fill(markdown)
}

export async function signUp(page: Page, name: string, email: string, password: string) {
  await page.goto('/sign-up')
  await page.getByTestId('name').fill(name)
  await page.getByTestId('email').fill(email)
  await page.getByTestId('password').fill(password)
  await page.getByTestId('submit').click()
  await expect(page.getByTestId('confirm-sent')).toContainText(`Check ${email}`)
  await page.goto(await emailLink(email, 'Confirm your Deyslide email'))
  await expect(page.getByTestId('account-menu')).toBeVisible()
}

export async function signIn(page: Page, email: string, password: string) {
  await page.goto('/sign-in')
  await page.getByTestId('email').fill(email)
  await page.getByTestId('password').fill(password)
  await page.getByTestId('submit').click()
  await expect(page.getByTestId('account-menu')).toBeVisible()
}

export async function signOut(page: Page) {
  await page.getByTestId('account-menu').click()
  await page.getByTestId('sign-out').click()
  await expect(page.getByTestId('sign-in-link')).toBeVisible()
}
