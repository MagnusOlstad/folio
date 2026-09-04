import { expect, test } from '@playwright/test'

// This suite needs a real local Ollama with the configured models installed
// (checked up front by global-setup.mjs) and talks to it for real, so results
// depend on actual model output and can be slower than the CI suite.

test.beforeEach(async ({ page }) => {
  await page.goto('/')
  await expect(page.getByText('Ollama online')).toBeVisible({ timeout: 15_000 })
})

test('capturing a real note classifies and files it (not Unsorted Note)', async ({ page }) => {
  await page.keyboard.press('Control+t')
  const editor = page.getByLabel('Write a new note')
  await editor.fill('Meeting notes: discussed the Q3 roadmap with the team and agreed on next steps.')
  await page.keyboard.press('Control+s')

  await expect(page.getByRole('status')).toContainText(/Filed/, { timeout: 60_000 })
  await expect(page.getByRole('status')).not.toContainText('Ollama was unavailable')
  await expect(page.getByRole('status')).not.toContainText('Unsorted Note')
})

test('semantic search finds a seeded note without matching its exact words', async ({ page }) => {
  await page.getByRole('navigation', { name: 'Sidebar tools' }).getByRole('button', { name: 'search', exact: true }).click()
  await page.getByLabel('Search your notes').fill('how does the app decide where a note ends up')
  await page.getByRole('button', { name: 'Go' }).click()

  await expect(page.locator('.sidebar-result').first()).toBeVisible({ timeout: 30_000 })
})

test('asking a question returns a grounded answer with a cited source', async ({ page }) => {
  await page.getByRole('navigation', { name: 'Sidebar tools' }).getByRole('button', { name: 'ask', exact: true }).click()
  await page.getByLabel('Question for your notes').fill('What should I do to get started with Folio?')
  await page.getByRole('button', { name: 'Ask notes' }).click()

  await expect(page.locator('.answer-copy')).toBeVisible({ timeout: 60_000 })
  await expect(page.locator('.answer-sources button').first()).toBeVisible()
})
