import { expect, test } from '@playwright/test'
import { emailLink, signIn, signOut, signUp, uniqueEmail } from './helpers'

test('sign up, confirm the email, sign out and sign in again', async ({ page }) => {
  const email = uniqueEmail('ana')
  await signUp(page, 'Ana', email, 'correct horse')
  await expect(page.getByTestId('account-menu')).toHaveText('Ana')
  await expect(page.getByTestId('guest-banner')).toHaveCount(0)
  await signOut(page)
  await signIn(page, email, 'correct horse')
})

test('a wrong password shows a message', async ({ page }) => {
  const email = uniqueEmail('budi')
  await signUp(page, 'Budi', email, 'correct horse')
  await signOut(page)
  await page.goto('/sign-in')
  await page.getByTestId('email').fill(email)
  await page.getByTestId('password').fill('wrong horse')
  await page.getByTestId('submit').click()
  await expect(page.getByRole('alert')).toHaveText('The email or password is wrong.')
})

test('sign in with a magic link', async ({ page }) => {
  const email = uniqueEmail('citra')
  await page.goto('/sign-in')
  await page.getByTestId('use-magic-link').click()
  await page.getByTestId('email').fill(email)
  await page.getByTestId('submit').click()
  await expect(page.getByTestId('link-sent')).toContainText(`Check ${email}`)
  await page.goto(await emailLink(email, 'Your Deyslide sign in link'))
  await expect(page.getByTestId('account-menu')).toHaveText(email)
})

test('reset a forgotten password', async ({ page }) => {
  const email = uniqueEmail('dewi')
  await signUp(page, 'Dewi', email, 'correct horse')
  await signOut(page)
  await page.goto('/forgot-password')
  await page.getByTestId('email').fill(email)
  await page.getByTestId('submit').click()
  await expect(page.getByTestId('reset-sent')).toBeVisible()
  await page.goto(await emailLink(email, 'Reset your Deyslide password'))
  await page.getByTestId('password').fill('battery staple')
  await page.getByTestId('submit').click()
  await expect(page.getByTestId('reset-done')).toBeVisible()
  await signIn(page, email, 'battery staple')
})
