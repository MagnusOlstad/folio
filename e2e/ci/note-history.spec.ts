import { expect, test } from '@playwright/test'

test('opens an opt-in timeline and previews a snapshot without editing the live note', async ({ page }) => {
  const historyRequests: string[] = []
  await page.route('**/api/note/history**', async route => {
    const url = new URL(route.request().url())
    if (url.pathname.endsWith('/version')) {
      await route.fulfill({ json: {
        revision: 'selected-revision',
        note: { title: 'Earlier Start Here', description: '', tags: [], status: 'stable', staleAfter: null, content: '# An earlier moment\n\nThis text only exists in history.' },
        diff: '+do not render this diff',
      } })
      return
    }
    if (url.pathname === '/api/note/history' && route.request().method() === 'GET') {
      historyRequests.push(route.request().url())
      await route.fulfill({ json: { entries: [{ revision: 'selected-revision', authoredAt: '2026-09-27T10:00:00.000Z', title: 'Earlier version' }], nextCursor: null } })
      return
    }
    await route.continue()
  })

  await page.goto('/')
  await page.getByRole('button', { name: 'Start Here', exact: true }).click()
  const editor = page.getByRole('textbox', { name: 'Edit Start Here' })
  await expect(editor).toBeVisible()
  await expect(page.getByRole('button', { name: /Open history/ })).toBeVisible()
  expect(historyRequests).toHaveLength(0)

  await editor.fill('# Start Here\n\nLive note content')
  await expect(page.getByText('Saved', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: /Open history/ }).click()
  const history = page.getByRole('region', { name: 'Note history' })
  await expect(history).toBeVisible()
  await expect(page.getByRole('region', { name: 'History preview' })).toBeVisible()
  await expect(editor).toBeHidden()
  await expect.poll(() => historyRequests.length).toBe(1)
  await expect(page.getByRole('button', { name: 'Present' })).toHaveAttribute('aria-current', 'step')

  await history.getByRole('button', { name: /Earlier version/ }).click()
  await expect(page.getByRole('region', { name: 'History preview' }).getByText('This text only exists in history.')).toBeVisible()
  await expect(page.getByRole('region', { name: 'History preview' }).getByRole('heading', { name: 'Earlier Start Here' })).toBeVisible()
  await expect(page.getByText('do not render this diff')).toHaveCount(0)
  await expect(history.getByRole('button', { name: 'Restore this version' })).toBeEnabled()

  await history.getByRole('button', { name: 'Present' }).click()
  await expect(page.getByRole('region', { name: 'History preview' }).getByText('Live note content')).toBeVisible()
  await history.getByRole('button', { name: 'Done' }).click()
  await expect(page.getByRole('region', { name: 'History preview' })).toHaveCount(0)
  await expect(editor).toBeVisible()
  await expect(editor).toContainText('Live note content')
})

test('drafts keep history unavailable and a restore returns to the present', async ({ page }) => {
  await page.goto('/')
  await page.getByTitle('New note (Cmd+T)').click()
  await expect(page.getByText('History is available for filed notes.')).toBeVisible()
  await expect(page.getByRole('button', { name: /Open history/ })).toHaveCount(0)

  await page.getByRole('button', { name: 'Start Here', exact: true }).click()
  await page.getByRole('button', { name: /Open history/ }).click()
  const history = page.getByRole('region', { name: 'Note history' })
  const version = history.locator('.note-history-stop').filter({ hasNotText: 'Now' }).first()
  await expect(version).toBeVisible()
  await version.click()
  await expect(history.getByRole('button', { name: 'Restore this version' })).toBeEnabled()

  page.once('dialog', dialog => dialog.accept())
  await history.getByRole('button', { name: 'Restore this version' }).click()
  await expect(history.getByRole('button', { name: 'Present' })).toHaveAttribute('aria-current', 'step')
  await expect(history.getByRole('button', { name: 'Restore this version' })).toBeDisabled()
})

test('a failed moment shows a retry state in the main note window', async ({ page }) => {
  let attempts = 0
  await page.route('**/api/note/history**', async route => {
    const url = new URL(route.request().url())
    if (url.pathname.endsWith('/version')) {
      attempts += 1
      if (attempts === 1) {
        await route.fulfill({ status: 503, body: 'Temporarily unavailable' })
      } else {
        await route.fulfill({ json: {
          revision: 'retry-revision',
          note: { title: 'Recovered note', description: '', tags: [], status: 'stable', staleAfter: null, content: 'Recovered history content' },
          diff: '',
        } })
      }
      return
    }
    if (url.pathname === '/api/note/history') {
      await route.fulfill({ json: { entries: [{ revision: 'retry-revision', authoredAt: '2026-09-27T10:00:00.000Z', title: 'Retry moment' }], nextCursor: null } })
      return
    }
    await route.continue()
  })

  await page.goto('/')
  await page.getByRole('button', { name: 'Start Here', exact: true }).click()
  await page.getByRole('button', { name: /Open history/ }).click()
  const tick = page.getByRole('navigation', { name: 'Note timeline' }).getByRole('button', { name: /Retry moment/ })
  await tick.click()
  const preview = page.getByRole('region', { name: 'History preview' })
  await expect(preview.getByRole('alert')).toContainText('Select its tick to try again')
  await tick.click()
  await expect(preview.getByText('Recovered history content')).toBeVisible()
  expect(attempts).toBe(2)
})

test('wheel and drag scrubbing select only the settled stop without moving the workspace', async ({ page }) => {
  const revisions = Array.from({ length: 12 }, (_, index) => ({
    revision: `scrub-${index}`,
    authoredAt: new Date(Date.UTC(2026, 8, 27, 11 - index, 0)).toISOString(),
    title: `Scrub moment ${index}`,
  }))
  const requests: string[] = []
  const finishVersionRequests: Array<() => void> = []
  await page.route('**/api/note/history**', async route => {
    const url = new URL(route.request().url())
    if (url.pathname.endsWith('/version')) {
      const revision = url.searchParams.get('revision') || ''
      requests.push(revision)
      await new Promise<void>(resolve => finishVersionRequests.push(resolve))
      await route.fulfill({ json: {
        revision,
        note: { title: `Preview ${revision}`, description: '', tags: [], status: 'stable', staleAfter: null, content: `Content ${revision}` },
        diff: '',
      } })
      return
    }
    if (url.pathname === '/api/note/history') {
      await route.fulfill({ json: { entries: revisions, nextCursor: null } })
      return
    }
    await route.continue()
  })

  await page.goto('/')
  await page.getByRole('button', { name: 'Start Here', exact: true }).click()
  await page.getByRole('button', { name: /Open history/ }).click()
  const timeline = page.getByRole('navigation', { name: 'Note timeline' })
  await expect(timeline.getByRole('button', { name: /Scrub moment 0/ })).toBeVisible()
  const workspace = page.locator('#workspace')
  const initialScroll = await workspace.evaluate(element => element.scrollTop)
  const box = await timeline.boundingBox()
  if (!box) throw new Error('Timeline did not have a visible box')
  await page.mouse.move(box.x + box.width - 12, box.y + box.height * 0.72)
  await page.mouse.wheel(0, 180)
  await expect.poll(() => timeline.locator('[aria-current="step"]').getAttribute('data-history-stop')).not.toBe('')
  await expect.poll(() => requests.length).toBeGreaterThan(0)
  await expect(page.getByRole('button', { name: 'Restore this version' })).toBeDisabled()
  finishVersionRequests.shift()?.()
  await expect(page.getByRole('button', { name: 'Restore this version' })).toBeEnabled()
  const afterWheel = await timeline.locator('[aria-current="step"]').getAttribute('data-history-stop')
  expect(afterWheel).toBeTruthy()

  const beforeDragCount = requests.length
  await page.mouse.move(box.x + box.width / 2, box.y + box.height * 0.68)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width / 2, box.y + box.height * 0.4, { steps: 5 })
  await page.mouse.up()
  await expect.poll(() => requests.length).toBeGreaterThan(beforeDragCount)
  await expect.poll(() => timeline.locator('[aria-current="step"]').getAttribute('data-history-stop')).not.toBe(afterWheel)
  expect(await workspace.evaluate(element => element.scrollTop)).toBe(initialScroll)
  finishVersionRequests.forEach(finish => finish())
  const preview = page.getByRole('region', { name: 'History preview' })
  await expect(preview).toBeVisible()
  await expect(preview.getByText(/^Content scrub-/)).toBeInViewport()
  await expect.poll(async () => {
    const timelineBox = await timeline.boundingBox()
    const activeBox = await timeline.locator('[aria-current="step"]').boundingBox()
    if (!timelineBox || !activeBox) return Number.POSITIVE_INFINITY
    return Math.abs(activeBox.y + activeBox.height / 2 - (timelineBox.y + timelineBox.height / 2))
  }).toBeLessThan(2)
  if (process.env.FOLIO_HISTORY_SCREENSHOT) await page.screenshot({ path: process.env.FOLIO_HISTORY_SCREENSHOT, fullPage: false })
})

test('the sticky timeline date follows the day at the top while scrolling', async ({ page }) => {
  const revisions = Array.from({ length: 24 }, (_, index) => ({
    revision: `sticky-${index}`,
    authoredAt: new Date(Date.UTC(2026, 8, 27 - Math.floor(index / 2), 11, 0)).toISOString(),
    title: `Sticky moment ${index}`,
  }))
  await page.route('**/api/note/history**', async route => {
    const url = new URL(route.request().url())
    if (url.pathname === '/api/note/history') {
      await route.fulfill({ json: { entries: revisions, nextCursor: null } })
      return
    }
    await route.continue()
  })

  await page.goto('/')
  await page.getByRole('button', { name: 'Start Here', exact: true }).click()
  await page.getByRole('button', { name: /Open history/ }).click()
  const timeline = page.getByRole('navigation', { name: 'Note timeline' })
  const stickyDay = page.locator('.note-history-sticky-day')
  await expect(stickyDay).toBeHidden()

  const visibleTopDay = () => timeline.evaluate(node => {
    const top = node.getBoundingClientRect().top
    return [...node.querySelectorAll('[data-history-stop].is-day-boundary')]
      .filter(stop => stop.getBoundingClientRect().top <= top)
      .at(-1)?.getAttribute('data-history-day') || ''
  })
  await timeline.evaluate(node => { node.scrollTop = 700 })
  await expect(stickyDay).toBeVisible()
  await expect.poll(async () => await stickyDay.textContent() === await visibleTopDay()).toBe(true)
  const firstDay = await stickyDay.textContent()
  await timeline.evaluate(node => { node.scrollTop += 208 })
  await expect.poll(() => stickyDay.textContent()).not.toBe(firstDay)
  await expect.poll(async () => await stickyDay.textContent() === await visibleTopDay()).toBe(true)
  if (process.env.FOLIO_HISTORY_SCREENSHOT) await page.screenshot({ path: process.env.FOLIO_HISTORY_SCREENSHOT, fullPage: false })
})
