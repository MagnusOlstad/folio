import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createApp, createRuntime } from '../server/app.js'

test('content autosaves update the note without history checkpoints until an explicit checkpoint', async (context) => {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'folio-note-autosave-history-'))
  const bundleRoot = path.join(dataRoot, 'external-vault')
  await fs.mkdir(bundleRoot, { recursive: true })
  const runtime = createRuntime({
    ...process.env,
    FOLIO_DATA_ROOT: dataRoot,
    FOLIO_BUNDLE_ROOT: path.join(dataRoot, 'unused-default-bundle'),
  })
  const app = await createApp(runtime)
  const bundle = await app.bundleManager.registry.setup({ name: 'External', markdownPath: bundleRoot, source: 'existing' })
  const server = app.listen(0, '127.0.0.1')
  await new Promise((resolve, reject) => {
    server.once('listening', resolve)
    server.once('error', reject)
  })
  const bundleRuntime = app.bundleManager.runtimeFor(bundle)
  context.after(async () => {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
    await app.bundleManager.close()
    await bundleRuntime.embeddingRefresh
    await fs.rm(dataRoot, { recursive: true, force: true })
  })

  const baseUrl = `http://127.0.0.1:${server.address().port}`
  const headers = { 'content-type': 'application/json', 'x-folio-bundle': bundle.id }
  const createResponse = await fetch(`${baseUrl}/api/file/create`, {
    method: 'POST', headers, body: JSON.stringify({ directory: '/', name: 'Autosave history' }),
  })
  const created = await createResponse.json()
  assert.equal(createResponse.status, 201, JSON.stringify(created))
  assert.equal(Boolean(created.tags?.includes('reviewed')), false)

  const historyUrl = `${baseUrl}/api/note/history?id=${encodeURIComponent(created.id)}`
  const versionUrl = (revision) => `${baseUrl}/api/note/history/version?id=${encodeURIComponent(created.id)}&revision=${encodeURIComponent(revision)}`
  const history = async () => fetch(historyUrl, { headers }).then((response) => response.json())
  const initialHistory = await history()
  assert.equal(initialHistory.entries.length, 1)
  const baselineRevision = initialHistory.entries[0].revision
  const baseline = await fetch(versionUrl(baselineRevision), { headers }).then((response) => response.json())
  assert.match(baseline.note.content, /# Autosave history/)

  for (const content of ['# Autosave history\n\nFirst autosave.', '# Autosave history\n\nLatest autosave.']) {
    const saveResponse = await fetch(`${baseUrl}/api/note?id=${encodeURIComponent(created.id)}`, {
      method: 'PATCH', headers,
      body: JSON.stringify({ content, baseContent: null, refreshEmbeddings: false }),
    })
    const saved = await saveResponse.json()
    assert.equal(saveResponse.status, 200, JSON.stringify(saved))
    assert.equal(saved.content, content)
    assert.equal(saved.warning, null)
  }

  const afterAutosaves = await history()
  assert.equal(afterAutosaves.entries.length, 1)
  assert.equal(afterAutosaves.entries[0].revision, baselineRevision)
  const savedNote = await fetch(`${baseUrl}/api/file?path=${encodeURIComponent(created.id)}`, { headers }).then((response) => response.json())
  assert.match(savedNote.content, /Latest autosave\./)
  const unchangedBaseline = await fetch(versionUrl(baselineRevision), { headers }).then((response) => response.json())
  assert.equal(unchangedBaseline.note.content, baseline.note.content)

  const checkpointResponse = await fetch(`${baseUrl}/api/note/history/checkpoint?id=${encodeURIComponent(created.id)}`, { method: 'POST', headers })
  assert.deepEqual(await checkpointResponse.json(), { checkpointed: true })
  const checkpointedHistory = await history()
  assert.equal(checkpointedHistory.entries.length, 2)
  const latestRevision = checkpointedHistory.entries[0].revision
  const latestSnapshot = await fetch(versionUrl(latestRevision), { headers }).then((response) => response.json())
  assert.match(latestSnapshot.note.content, /Latest autosave\./)

  const repeatedCheckpointResponse = await fetch(`${baseUrl}/api/note/history/checkpoint?id=${encodeURIComponent(created.id)}`, { method: 'POST', headers })
  assert.deepEqual(await repeatedCheckpointResponse.json(), { checkpointed: true })
  assert.equal((await history()).entries.length, 2)

  const tagsResponse = await fetch(`${baseUrl}/api/note?id=${encodeURIComponent(created.id)}`, {
    method: 'PATCH', headers,
    body: JSON.stringify({
      content: '# Autosave history\n\nLatest autosave.',
      baseContent: null,
      tags: ['reviewed'],
      refreshEmbeddings: false,
    }),
  })
  const tagged = await tagsResponse.json()
  assert.equal(tagsResponse.status, 200, JSON.stringify(tagged))
  assert.deepEqual(tagged.tags, ['reviewed'])
  const currentMarkdown = await fetch(`${baseUrl}/api/concepts?path=${encodeURIComponent(created.id)}`, { headers }).then((response) => response.text())
  assert.match(currentMarkdown, /tags:\s*\n\s*- reviewed/)
  const afterTagsHistory = await history()
  assert.equal(afterTagsHistory.entries.length, 3, JSON.stringify(afterTagsHistory.entries))
  const tagsSnapshot = await fetch(versionUrl(afterTagsHistory.entries[0].revision), { headers }).then((response) => response.json())
  assert.deepEqual(tagsSnapshot.note.tags, ['reviewed'])
  assert.equal((await runtime.history.entries(created.id)).entries.length, 0)
})
