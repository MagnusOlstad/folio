import { expect, test } from '@playwright/test'

test('keeps the timeline visible and returns to the live editor at Now', async ({ page }) => {
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
  const history = page.getByRole('region', { name: 'Note history' })
  await expect(history).toBeVisible()
  await expect.poll(() => historyRequests.length).toBe(1)

  await editor.fill('# Start Here\n\nLive note content')
  await expect(page.getByText('Saved', { exact: true })).toBeVisible()
  await expect(editor).toBeVisible()
  await expect(page.getByRole('button', { name: 'Present' })).toHaveAttribute('aria-current', 'step')

  await history.getByRole('button', { name: /Earlier version/ }).click()
  await expect(page.getByRole('region', { name: 'History preview' }).getByText('This text only exists in history.')).toBeVisible()
  const preview = page.getByRole('region', { name: 'History preview' })
  await expect(preview.getByRole('heading', { name: 'Earlier Start Here' })).toBeVisible()
  await expect(preview.getByText('Add description')).toHaveCount(0)
  await expect(editor).toBeHidden()
  await expect(preview.locator('.history-preview-banner')).toHaveCount(0)
  await expect(page.getByText('do not render this diff')).toHaveCount(0)
  await expect(history.getByRole('button', { name: 'Restore this version' })).toBeEnabled()

  await history.getByRole('button', { name: 'Present' }).click()
  await expect(editor).toBeVisible()
  await expect(page.getByRole('region', { name: 'History preview' })).toHaveCount(0)
  await expect(editor).toContainText('Live note content')
})

test('untitled drafts stay editable without history controls', async ({ page }) => {
  await page.goto('/')
  await page.getByTitle('New note (Cmd+T)').click()
  await expect(page.getByText('Drafts do not have history.')).toBeVisible()
  await expect(page.getByRole('region', { name: 'Note history' })).toHaveCount(0)
  await expect(page.locator('.cm-content')).toBeEditable()
})

test('a matching history snapshot keeps the live document header and body start aligned', async ({ page }) => {
  await page.route('**/api/note/history**', async route => {
    const url = new URL(route.request().url())
    if (url.pathname.endsWith('/version')) {
      await route.fulfill({ json: {
        revision: 'matching-revision',
        note: { title: 'Start Here', description: '', tags: [], status: 'stable', staleAfter: null, content: '# Start Here\n\nLive note content' },
        diff: '',
      } })
      return
    }
    if (url.pathname === '/api/note/history') {
      await route.fulfill({ json: { entries: [{ revision: 'matching-revision', authoredAt: '2026-09-27T10:00:00.000Z', title: 'Matching moment' }], nextCursor: null } })
      return
    }
    await route.continue()
  })
  await page.goto('/')
  await page.getByRole('button', { name: 'Start Here', exact: true }).click()
  const editor = page.getByRole('textbox', { name: 'Edit Start Here' })
  await editor.fill('# Start Here\n\nLive note content')
  await expect(page.getByText('Saved', { exact: true })).toBeVisible()
  const liveHeader = page.locator('.document-heading')
  const liveBody = page.locator('.live-markdown-editor .cm-content')
  const before = await Promise.all([liveHeader.boundingBox(), liveBody.boundingBox()])
  if (!before[0] || !before[1]) throw new Error('Live note layout was not visible')
  await page.getByRole('navigation', { name: 'Note timeline' }).getByRole('button', { name: /Matching moment/ }).click()
  const history = page.getByRole('region', { name: 'History preview' })
  const historicalHeader = history.locator('.document-heading')
  const historicalBody = history.locator('.history-document-content')
  await expect(history.getByText('Live note content')).toBeVisible()
  await expect(history.getByText('Add description')).toHaveCount(0)
  const after = await Promise.all([historicalHeader.boundingBox(), historicalBody.boundingBox()])
  if (!after[0] || !after[1]) throw new Error('Historical note layout was not visible')
  expect(Math.abs(after[0].y - before[0].y)).toBeLessThan(2)
  expect(Math.abs(after[0].height - before[0].height)).toBeLessThan(2)
  expect(Math.abs(after[1].y - before[1].y)).toBeLessThan(2)
})

test('hides the generated capture heading in history while preserving user headings', async ({ page }) => {
  await page.route('**/api/note/history**', async route => {
    const url = new URL(route.request().url())
    if (url.pathname.endsWith('/version')) {
      const userHeading = url.searchParams.get('revision') === 'user-heading-revision'
      await route.fulfill({ json: {
        revision: userHeading ? 'user-heading-revision' : 'captured-revision',
        note: userHeading
          ? { title: 'Meeting notes', description: '', tags: [], status: 'stable', staleAfter: null, content: '# Captured note\n\nThis heading was written by the user.' }
          : { title: 'Captured meeting', description: '', tags: [], status: 'stable', staleAfter: null, content: '# Captured note\n\n<!-- folio:capture:abcd1234:start -->\nMeeting notes from the capture.\n<!-- folio:capture:abcd1234:end -->' },
        diff: '',
      } })
      return
    }
    if (url.pathname === '/api/note/history') {
      await route.fulfill({ json: { entries: [
        { revision: 'captured-revision', authoredAt: '2026-09-27T10:00:00.000Z', title: 'Captured meeting' },
        { revision: 'user-heading-revision', authoredAt: '2026-09-27T09:00:00.000Z', title: 'User heading' },
      ], nextCursor: null } })
      return
    }
    await route.continue()
  })

  await page.goto('/')
  await page.getByRole('button', { name: 'Start Here', exact: true }).click()
  const preview = page.getByRole('region', { name: 'History preview' })
  await page.getByRole('navigation', { name: 'Note timeline' }).getByRole('button', { name: /Captured meeting/ }).click()
  await expect(preview.getByRole('heading', { name: 'Captured meeting' })).toBeVisible()
  await expect(preview.getByRole('heading', { name: 'Captured note' })).toHaveCount(0)
  await expect(preview.getByText('Meeting notes from the capture.')).toBeVisible()
  await page.getByRole('navigation', { name: 'Note timeline' }).getByRole('button', { name: /User heading/ }).click()
  await expect(preview.getByRole('heading', { name: 'Captured note' })).toBeVisible()
  await expect(preview.getByText('This heading was written by the user.')).toBeVisible()
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
  const tick = page.getByRole('navigation', { name: 'Note timeline' }).getByRole('button', { name: /Retry moment/ })
  await tick.click()
  const preview = page.getByRole('region', { name: 'History preview' })
  await expect(preview.getByRole('alert')).toContainText('Select its tick to try again')
  await tick.click()
  await expect(preview.getByText('Recovered history content')).toBeVisible()
  expect(attempts).toBe(2)
})

test('wheel and drag scrubbing preview while moving without shifting the workspace', async ({ page }) => {
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
  const afterWheel = await timeline.locator('[aria-current="step"]').getAttribute('data-history-stop')
  expect(afterWheel).toBeTruthy()

  await page.mouse.move(box.x + box.width / 2, box.y + box.height * 0.68)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width / 2, box.y + box.height * 0.4, { steps: 5 })
  await page.mouse.up()
  await expect.poll(() => timeline.locator('[aria-current="step"]').getAttribute('data-history-stop')).not.toBe(afterWheel)
  finishVersionRequests.shift()?.()
  const preview = page.getByRole('region', { name: 'History preview' })
  await expect(preview.getByText(/^Content scrub-/)).toBeVisible()
  await expect(page.getByRole('button', { name: 'Restore this version' })).toBeDisabled()
  await expect.poll(() => requests.length).toBeGreaterThan(1)
  const restore = page.getByRole('button', { name: 'Restore this version' })
  for (let attempt = 0; attempt < 12; attempt += 1) {
    if (await restore.isEnabled()) break
    await expect.poll(() => finishVersionRequests.length > 0 || restore.isEnabled()).toBe(true)
    if (await restore.isEnabled()) break
    finishVersionRequests.shift()?.()
  }
  await expect(restore).toBeEnabled()
  await expect.poll(() => timeline.locator('[aria-current="step"]').getAttribute('data-history-stop')).not.toBe(afterWheel)
  expect(await workspace.evaluate(element => element.scrollTop)).toBe(initialScroll)
  finishVersionRequests.forEach(finish => finish())
  await expect(preview).toBeVisible()
  await expect(preview.getByText(/^Content scrub-/)).toBeInViewport()
  if (process.env.FOLIO_HISTORY_SCREENSHOT) await page.screenshot({ path: process.env.FOLIO_HISTORY_SCREENSHOT, fullPage: false })
})

test('Older from Now refreshes snapshots created while the note stayed open', async ({ page }) => {
  const oldEntry = { revision: 'old-moment', authoredAt: '2026-09-27T10:00:00.000Z', title: 'Old moment' }
  const newEntry = { revision: 'new-moment', authoredAt: '2026-09-27T11:00:00.000Z', title: 'New moment' }
  let historyReads = 0
  await page.route('**/api/note/history**', async route => {
    const url = new URL(route.request().url())
    if (url.pathname === '/api/note/history') {
      historyReads += 1
      await route.fulfill({ json: { entries: historyReads === 1 ? [oldEntry] : [newEntry, oldEntry], nextCursor: null } })
      return
    }
    await route.continue()
  })

  await page.goto('/')
  await page.getByRole('button', { name: 'Start Here', exact: true }).click()
  const timeline = page.getByRole('navigation', { name: 'Note timeline' })
  await expect(timeline.getByRole('button', { name: /Old moment/ })).toBeVisible()
  await page.getByRole('button', { name: 'Older moment' }).click()
  await expect(timeline.getByRole('button', { name: /New moment/ })).toBeVisible()
  expect(historyReads).toBe(2)
})

test('a successful live checkpoint appears without moving the timeline away from Now', async ({ page }) => {
  await page.clock.install()
  const oldEntries = Array.from({ length: 8 }, (_, index) => ({
    revision: `live-old-${index}`,
    authoredAt: new Date(Date.UTC(2026, 8, 27, 10, 0 - index)).toISOString(),
    title: `Existing moment ${index}`,
  }))
  const newEntry = { revision: 'live-new', authoredAt: '2026-09-27T11:00:00.000Z', title: 'New checkpoint' }
  let checkpointed = false
  let checkpointRequests = 0
  await page.route('**/api/note/history**', async route => {
    const url = new URL(route.request().url())
    if (url.pathname.endsWith('/checkpoint') && route.request().method() === 'POST') {
      checkpointed = true
      checkpointRequests += 1
      await route.fulfill({ json: {} })
      return
    }
    if (url.pathname === '/api/note/history' && route.request().method() === 'GET') {
      await route.fulfill({ json: { entries: checkpointed ? [newEntry, ...oldEntries] : oldEntries, nextCursor: null } })
      return
    }
    await route.continue()
  })

  await page.goto('/')
  await page.getByRole('button', { name: 'Start Here', exact: true }).click()
  const editor = page.getByRole('textbox', { name: 'Edit Start Here' })
  await expect(editor).toBeVisible()
  const timeline = page.getByRole('navigation', { name: 'Note timeline' })
  await expect(timeline.getByRole('button', { name: /Existing moment 0/ })).toBeVisible()
  await editor.fill('# Start Here\n\nA live checkpoint update')
  await expect(page.getByText('Saved', { exact: true })).toBeVisible()
  await timeline.evaluate(node => { node.scrollTop = 24 })
  await page.clock.fastForward(10_000)
  await expect.poll(() => checkpointRequests).toBe(1)
  await expect(timeline.getByRole('button', { name: /New checkpoint/ })).toBeVisible()
  await expect(timeline.getByRole('button', { name: 'Present' })).toHaveAttribute('aria-current', 'step')
  await expect(editor).toBeVisible()
  await expect.poll(() => timeline.evaluate(node => node.scrollTop)).toBe(24)
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
