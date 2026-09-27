import { expect, test } from '@playwright/test'

test('opens note history in the canonical right pane and can hide and reopen it', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByRole('button', { name: 'Start Here', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Start Here', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Start Here', level: 1 }).first()).toBeVisible()

  await page.getByRole('button', { name: 'History' }).click()
  const rightPane = page.getByRole('complementary', { name: 'Note history' })
  const history = page.getByRole('region', { name: 'Note history' })
  await expect(rightPane).toBeVisible()
  await expect(history).toBeVisible()
  await expect(page.locator('.editor-workspace .note-history-panel')).toHaveCount(0)
  await expect(page.locator('.note-history-timeline')).toBeVisible()

  const firstVersion = page.locator('.note-history-timeline button:not(.note-history-more)').first()
  await expect(firstVersion).toBeVisible()
  await firstVersion.click()
  await expect(page.locator('.note-history-preview')).toBeVisible()
  await expect(page.locator('.note-history-diff')).toBeVisible()
  const timelineBox = await page.locator('.note-history-timeline').boundingBox()
  const previewBox = await page.locator('.note-history-preview').boundingBox()
  const diffBox = await page.locator('.note-history-diff').boundingBox()
  expect(timelineBox && previewBox && diffBox).toBeTruthy()
  expect(timelineBox!.y).toBeLessThan(previewBox!.y)
  expect(previewBox!.y).toBeLessThan(diffBox!.y)

  await rightPane.getByRole('button', { name: 'Hide right sidebar' }).click()
  await expect(rightPane).toHaveCount(0)
  await page.getByRole('button', { name: 'Show right sidebar' }).click()
  await expect(page.getByRole('complementary', { name: 'Note history' })).toBeVisible()
  await expect(page.getByRole('region', { name: 'Note history' })).toBeVisible()
});
