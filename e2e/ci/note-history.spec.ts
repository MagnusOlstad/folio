import { expect, test } from '@playwright/test'

test('automatically tracks the active filed note in the canonical right pane', async ({ page }) => {
  const historyRequests: string[] = []
  await page.route('**/api/note/history**', async route => {
    const url = new URL(route.request().url())
    if (url.pathname.endsWith('/version')) {
      await route.fulfill({ json: {
        revision: 'selected-revision',
        note: { title: 'Start Here', description: '', tags: [], status: 'stable', staleAfter: null, content: 'restored line' },
        diff: '@@ -1 +1 @@\n-old line\n+restored line',
      } })
      return
    }
    if (url.pathname === '/api/note/history' && route.request().method() === 'GET') {
      await route.fulfill({ json: { entries: [{ revision: 'selected-revision', authoredAt: '2026-09-27T10:00:00.000Z', title: 'Earlier version' }], nextCursor: null } })
      return
    }
    await route.continue()
  })
  page.on('request', request => {
    if (request.method() === 'GET' && new URL(request.url()).pathname === '/api/note/history') historyRequests.push(request.url())
  })

  await page.goto('/')
  await expect(page.getByRole('button', { name: 'Start Here', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Start Here', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Start Here', level: 1 }).first()).toBeVisible()

  const rightPane = page.getByRole('complementary', { name: 'Workspace tools' })
  const history = page.getByRole('region', { name: 'Note history' })
  await expect(rightPane).toBeVisible()
  await expect(history).toBeVisible()
  await expect(page.getByRole('button', { name: 'History' })).toHaveCount(0)
  await expect(page.locator('.editor-workspace .note-history-panel')).toHaveCount(0)
  await expect(page.locator('.note-history-timeline')).toBeVisible()
  await expect.poll(() => historyRequests.length).toBe(1)

  const editor = page.getByRole('textbox', { name: 'Edit Start Here' })
  await editor.fill('# Start Here\n\nHistory diff marker')
  await expect(page.getByText('Saved', { exact: true })).toBeVisible()
  expect(historyRequests).toHaveLength(1)

  const beforeTyping = historyRequests.length
  await page.getByRole('button', { name: 'Hide right sidebar' }).click()
  await expect(rightPane).toHaveCount(0)
  await expect.poll(() => historyRequests.length).toBe(beforeTyping)

  await page.getByRole('button', { name: 'Show right sidebar' }).click()
  await expect(page.getByRole('complementary', { name: 'Workspace tools' })).toBeVisible()
  await expect(history).toBeVisible()
  await expect.poll(() => historyRequests.length).toBe(beforeTyping + 1)

  const firstVersion = page.locator('.note-history-timeline button:not(.note-history-more)').first()
  await expect(firstVersion).toBeVisible()
  await firstVersion.click()
  await expect(page.locator('.note-history-diff-line.is-added').first()).toBeVisible()
  await expect(page.locator('.note-history-diff-line.is-removed').first()).toBeVisible()
  await expect(page.getByText('Current → selected')).toBeVisible()
})

test('draft tabs show a neutral state and can restore a selected version', async ({ page }) => {
  await page.goto('/')
  await page.getByTitle('New note (Cmd+T)').click()
  await expect(page.getByText('History is available for filed notes.')).toBeVisible()
  await expect(page.getByRole('region', { name: 'Note history' })).toHaveCount(0)

  await page.getByRole('button', { name: 'Start Here', exact: true }).click()
  const history = page.getByRole('region', { name: 'Note history' })
  await expect(history).toBeVisible()
  const firstVersion = page.locator('.note-history-timeline button:not(.note-history-more)').first()
  await expect(firstVersion).toBeVisible()
  await firstVersion.click()
  await expect(page.locator('.note-history-diff')).toBeVisible()

  page.once('dialog', dialog => dialog.accept())
  await page.getByRole('button', { name: 'Restore' }).click()
  await expect(history.getByText('Select a version to see its changes.')).toBeVisible()
})
