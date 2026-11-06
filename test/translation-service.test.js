import assert from 'node:assert/strict'
import express from 'express'
import fs from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { createRuntime } from '../server/app.js'
import { registerRoutes } from '../server/routes/translation.js'
import { createTranslationService } from '../server/translation/service.js'

function fakeMlx({ installed = true } = {}) {
  const calls = []
  const behavior = { malformed: 0, drop: false, untranslated: false, directSame: false }
  const service = {
    calls,
    behavior,
    status: async () => ({ available: true, models: [{ id: 'gemma4', purpose: 'generation', selected: true, installed }] }),
    generate: async (messages) => {
      const text = messages.at(-1).content.match(/<text>\n([\s\S]*)\n<\/text>/)[1]
      calls.push(text)
      ;(behavior.prompts ||= []).push(messages.at(-1).content)
      behavior.onCall?.()
      if (messages[0].content.includes('Reply with only the translation')) {
        behavior.directCalls = (behavior.directCalls || 0) + 1
        return { text: behavior.directSame ? text : `DIRECT: ${text}` }
      }
      if (behavior.malformed > 0) { behavior.malformed -= 1; return { text: 'sorry, here you go' } }
      if (/æ|ø|å|\b(og|er|jeg)\b/i.test(text)) {
        const translated = behavior.drop ? 'EN dropped' : `EN: ${text}`
        return { text: JSON.stringify({ source: 'no', translation: translated }), modelId: 'gemma4' }
      }
      if (/\b(the|and|is)\b/i.test(text)) return { text: JSON.stringify({ source: 'en', translation: behavior.untranslated ? text : `NO: ${text}` }), modelId: 'gemma4' }
      return { text: JSON.stringify({ source: 'other', translation: null }), modelId: 'gemma4' }
    },
  }
  return service
}

async function setup(context, { mlx = fakeMlx(), notes = {}, auto = true } = {}) {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'folio-translation-'))
  context.after(() => fs.rm(dataRoot, { recursive: true, force: true }))
  await fs.mkdir(path.join(dataRoot, 'bundle'), { recursive: true })
  const runtime = createRuntime({ FOLIO_DATA_ROOT: dataRoot, FOLIO_MODEL_ROOT: path.join(dataRoot, 'models') }, mlx)
  runtime.translation = createTranslationService(runtime, { debounceMs: 0, backfillDelayMs: 0, statusTtlMs: 0, busyPollMs: 5 })
  context.after(() => runtime.translation.close())
  if (auto) {
    const ids = auto === true ? Object.keys(notes) : auto
    await fs.mkdir(path.join(runtime.bundleRoot, '.folio'), { recursive: true })
    await fs.writeFile(path.join(runtime.bundleRoot, '.folio', 'translation-notes.json'), JSON.stringify({
      version: 1, notes: Object.fromEntries(ids.map((id) => [id, { autoTranslate: true, since: '2026-01-01T00:00:00.000Z' }])),
    }))
  }
  for (const [id, content] of Object.entries(notes)) await writeNote(runtime, id, content)
  return { runtime, mlx, dataRoot }
}

async function writeNote(runtime, id, content) {
  const filePath = path.join(runtime.bundleRoot, id)
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  await fs.writeFile(filePath, content)
}

const NOTE = '---\ntitle: Møtenotat\ndescription: Jeg er her\n---\n\n# Møtenotat\n\nJeg snakket med [[Ola]] og `kode`.\n\nThe weather is nice.\n\n```\njeg er kode\n```\n\n- [ ] Skriv og send\n'

test('translates blocks once, shows target language and leaves same-language blocks unchanged', async (context) => {
  const { runtime, mlx } = await setup(context, { notes: { '/a.md': NOTE } })
  const pending = await runtime.translation.view('/a.md', 'en')
  assert.equal(pending.status, 'pending')
  await runtime.translation.idle()
  const en = await runtime.translation.view('/a.md', 'en')
  assert.equal(en.status, 'ready')
  assert.equal(en.translatedBlocks, en.totalBlocks)
  assert.match(en.content, /^# EN: Møtenotat$/m)
  assert.match(en.content, /EN: Jeg snakket med \[\[Ola\]\] og `kode`\./)
  assert.match(en.content, /^The weather is nice\.$/m)
  assert.match(en.content, /^```\njeg er kode\n```$/m)
  assert.match(en.content, /^- \[ \] EN: Skriv og send$/m)
  assert.equal(en.title, 'EN: Møtenotat')
  const no = await runtime.translation.view('/a.md', 'no')
  assert.match(no.content, /Jeg snakket med \[\[Ola\]\]/)
  assert.doesNotMatch(no.content, /EN:/)
  assert.match(no.content, /^NO: The weather is nice\.$/m)
  const saved = JSON.parse(await fs.readFile(path.join(runtime.bundleRoot, '.folio', 'translations.json'), 'utf8'))
  assert.equal(saved.version, 1)
  assert.ok(Object.values(saved.entries).every((entry) => ['no', 'en', 'other'].includes(entry.source)))
  const callsBefore = mlx.calls.length
  runtime.translation.enqueue('/a.md')
  await runtime.translation.idle()
  assert.equal(mlx.calls.length, callsBefore)
})

test('only changed blocks are translated after an edit and the cache survives a move', async (context) => {
  const { runtime, mlx } = await setup(context, { notes: { '/a.md': NOTE } })
  runtime.translation.enqueue('/a.md')
  await runtime.translation.idle()
  const initial = mlx.calls.length
  await writeNote(runtime, '/a.md', NOTE.replace('The weather is nice.', 'The weather is bad.'))
  runtime.translation.enqueue('/a.md')
  await runtime.translation.idle()
  assert.equal(mlx.calls.length, initial + 1)
  await fs.mkdir(path.join(runtime.bundleRoot, 'moved'))
  await fs.rename(path.join(runtime.bundleRoot, 'a.md'), path.join(runtime.bundleRoot, 'moved', 'a.md'))
  const moved = await runtime.translation.view('/moved/a.md', 'en')
  assert.equal(moved.status, 'ready')
  runtime.translation.enqueue('/moved/a.md')
  await runtime.translation.idle()
  assert.equal(mlx.calls.length, initial + 1)
})

test('malformed JSON is retried once and then falls back to the original', async (context) => {
  const { runtime, mlx } = await setup(context, { notes: { '/b.md': '# Hei\n\nJeg er her.\n' } })
  mlx.behavior.malformed = 1
  runtime.translation.enqueue('/b.md')
  await runtime.translation.idle()
  const retried = await runtime.translation.view('/b.md', 'en')
  assert.equal(retried.status, 'ready')
  assert.match(retried.content, /EN: Jeg er her\./)
  assert.equal(mlx.calls.length, 3) // title and heading share a block (2 attempts), plus the paragraph
})

test('persistent failures and dropped placeholders fall back to original text', async (context) => {
  const { runtime, mlx } = await setup(context, { notes: { '/c.md': '---\ntitle: Jeg er `x` her.\n---\nJeg er `x` her.\n' } })
  mlx.behavior.malformed = 2
  runtime.translation.enqueue('/c.md')
  await runtime.translation.idle()
  let view = await runtime.translation.view('/c.md', 'en')
  assert.equal(view.content.trim(), 'Jeg er `x` her.')
  assert.equal(view.status, 'ready')
  const { runtime: second, mlx: secondMlx } = await setup(context, { notes: { '/d.md': '---\ntitle: Jeg er `x` her.\n---\nJeg er `x` her.\n' } })
  secondMlx.behavior.drop = true
  second.translation.enqueue('/d.md')
  await second.translation.idle()
  view = await second.translation.view('/d.md', 'en')
  assert.equal(view.content.trim(), 'Jeg er `x` her.')
  assert.equal(secondMlx.calls.length, 2)
})

test('auto translate is per note: off by default, enabling translates only that note, disabling stops it', async (context) => {
  const { runtime, mlx } = await setup(context, { auto: false, notes: { '/a.md': NOTE, '/b.md': NOTE.replace('Møtenotat', 'Annet') } })
  assert.deepEqual(await runtime.translation.getSettings(), { available: true })
  runtime.translation.enqueue('/a.md')
  runtime.translation.prioritize('/b.md')
  runtime.translation.startBackfill()
  await new Promise((resolve) => setTimeout(resolve, 20))
  await runtime.translation.idle()
  assert.equal(mlx.calls.length, 0)
  const off = await runtime.translation.view('/a.md', 'en')
  assert.equal(off.status, 'disabled')
  assert.equal(off.autoTranslate, false)
  assert.equal(mlx.calls.length, 0, 'viewing an auto-off note never starts model work')

  assert.deepEqual(await runtime.translation.setAuto('/a.md', true), { id: '/a.md', autoTranslate: true, available: true })
  await runtime.translation.idle()
  assert.equal((await runtime.translation.view('/a.md', 'en')).status, 'ready')
  assert.equal((await runtime.translation.view('/b.md', 'en')).status, 'disabled')
  const stored = JSON.parse(await fs.readFile(path.join(runtime.bundleRoot, '.folio', 'translation-notes.json'), 'utf8'))
  assert.deepEqual(Object.keys(stored.notes), ['/a.md'])
  assert.equal(stored.notes['/a.md'].autoTranslate, true)
  assert.equal(await fs.readFile(path.join(runtime.bundleRoot, 'a.md'), 'utf8'), NOTE, 'the note file is never rewritten')

  let busy = true
  mlx.isBusy = () => busy
  await fs.writeFile(path.join(runtime.bundleRoot, 'a.md'), NOTE.replace('nice', 'cold'))
  runtime.translation.enqueue('/a.md')
  await new Promise((resolve) => setTimeout(resolve, 20))
  const before = mlx.calls.length
  await runtime.translation.setAuto('/a.md', false)
  busy = false
  await runtime.translation.idle()
  assert.equal(mlx.calls.length, before)
  await assert.rejects(() => runtime.translation.setAuto('/missing.md', true), { status: 404 })
  await assert.rejects(() => runtime.translation.setAuto('untitled:1', true), { status: 400 })
})

test('the auto flag follows moves and is dropped on delete or folder removal', async (context) => {
  const { runtime } = await setup(context, { auto: ['/a.md', '/d/x.md', '/d/y.md'], notes: { '/a.md': NOTE, '/d/x.md': NOTE, '/d/y.md': NOTE } })
  const read = async () => Object.keys(JSON.parse(await fs.readFile(path.join(runtime.bundleRoot, '.folio', 'translation-notes.json'), 'utf8')).notes).sort()
  runtime.translation.moveNote('/a.md', '/moved/a.md')
  await runtime.translation.forget('/d/x.md')
  await runtime.translation.idle()
  await runtime.translation.close()
  assert.deepEqual(await read(), ['/d/y.md', '/moved/a.md'])
  const second = createTranslationService(runtime, { debounceMs: 0 })
  context.after(() => second.close())
  await second.forget('/d/')
  await second.close()
  assert.deepEqual(await read(), ['/moved/a.md'])
})

test('does nothing when no generation model is installed', async (context) => {
  const { runtime, mlx } = await setup(context, { mlx: fakeMlx({ installed: false }), notes: { '/a.md': NOTE } })
  runtime.translation.enqueue('/a.md')
  await runtime.translation.idle()
  assert.equal(mlx.calls.length, 0)
  assert.deepEqual(await runtime.translation.getSettings(), { available: false })
  assert.equal((await runtime.translation.view('/a.md', 'en')).status, 'unavailable')
})

test('yields to user-facing model work between blocks', async (context) => {
  const { runtime, mlx } = await setup(context, { notes: { '/a.md': NOTE } })
  let busy = true
  mlx.isBusy = () => busy
  runtime.translation.enqueue('/a.md')
  await new Promise((resolve) => setTimeout(resolve, 60))
  assert.equal(mlx.calls.length, 0)
  busy = false
  await runtime.translation.idle()
  assert.ok(mlx.calls.length > 0)
})

test('backfill translates bundle notes only and prunes unreferenced cache entries', async (context) => {
  const { runtime, mlx } = await setup(context, { notes: { '/a.md': '# Hei\n\nJeg er her.\n', '/x/b.md': 'The cat is here.\n' } })
  await fs.mkdir(path.join(runtime.bundleRoot, '.folio'), { recursive: true })
  await fs.writeFile(path.join(runtime.bundleRoot, '.folio', 'translations.json'), JSON.stringify({
    version: 1, entries: { stale: { source: 'no', translation: 'x', modelId: 'gemma4', translatedAt: '2000-01-01T00:00:00.000Z' } },
  }))
  await fs.writeFile(path.join(runtime.bundleRoot, 'image.png'), 'x')
  runtime.translation.startBackfill()
  await new Promise((resolve) => setTimeout(resolve, 30))
  await runtime.translation.idle()
  assert.ok(mlx.calls.some((call) => call.includes('The cat is here.')))
  await runtime.translation.close()
  const saved = JSON.parse(await fs.readFile(path.join(runtime.bundleRoot, '.folio', 'translations.json'), 'utf8'))
  assert.equal(saved.entries.stale, undefined)
  assert.equal(Object.keys(saved.entries).length, 4)
})

test('routes validate input and return the translation contract', async (context) => {
  const { runtime, mlx } = await setup(context, { notes: { '/a.md': NOTE } })
  const app = express()
  app.use(express.json())
  registerRoutes(app, runtime)
  const server = http.createServer(app)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  context.after(() => new Promise((resolve) => server.close(resolve)))
  const base = `http://127.0.0.1:${server.address().port}`
  const get = (query) => fetch(`${base}/api/note/translation?${query}`)
  const send = (url, method, body) => fetch(`${base}${url}`, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

  assert.equal((await get('id=/a.md&target=fr')).status, 400)
  assert.equal((await get('id=/.folio/translations.json&target=en')).status, 400)
  assert.equal((await get('id=untitled:1&target=en')).status, 400)
  assert.equal((await get('id=/missing.md&target=en')).status, 404)
  assert.equal((await send('/api/note/translation/prioritize', 'POST', { id: 'untitled:1' })).status, 400)
  assert.equal((await send('/api/note/translation/prioritize', 'POST', { id: '/missing.md' })).status, 404)

  const first = await (await get('id=/a.md&target=en')).json()
  assert.deepEqual(Object.keys(first).sort(), ['autoTranslate', 'content', 'description', 'id', 'noteLanguage', 'noteLanguageSource', 'status', 'target', 'title', 'totalBlocks', 'translatedBlocks'])
  assert.equal(first.status, 'pending')
  await runtime.translation.idle()
  assert.equal((await (await get('id=/a.md&target=en')).json()).status, 'ready')
  const prioritized = await send('/api/note/translation/prioritize', 'POST', { id: '/a.md' })
  assert.equal(prioritized.status, 202)
  assert.deepEqual(await prioritized.json(), { queued: true })

  assert.deepEqual(await (await fetch(`${base}/api/translation/settings`)).json(), { available: true })
  assert.equal((await send('/api/translation/settings', 'PUT', { enabled: false })).status, 404)
  assert.equal((await send('/api/note/translation/auto', 'PUT', { id: '/a.md', enabled: 'yes' })).status, 400)
  assert.equal((await send('/api/note/translation/auto', 'PUT', { id: 'untitled:1', enabled: true })).status, 400)
  assert.equal((await send('/api/note/translation/auto', 'PUT', { id: '/missing.md', enabled: true })).status, 404)
  assert.deepEqual(await (await fetch(`${base}/api/note/language?id=/a.md`)).json(),
    { id: '/a.md', noteLanguage: 'no', noteLanguageSource: 'detected', autoTranslate: true })
  assert.deepEqual(await (await send('/api/note/translation/auto', 'PUT', { id: '/a.md', enabled: false })).json(), { id: '/a.md', autoTranslate: false, available: true })
  assert.equal((await (await get('id=/a.md&target=en')).json()).autoTranslate, false)
  const callsBefore = mlx.calls.length
  await send('/api/note/translation/prioritize', 'POST', { id: '/a.md' })
  await runtime.translation.idle()
  assert.equal(mlx.calls.length, callsBefore)
})

test('retries unchanged detected-language output with a direct translation prompt', async (context) => {
  const { runtime, mlx } = await setup(context, { notes: { '/e.md': '---\ntitle: The cat is here\n---\nThe cat is here\n' } })
  mlx.behavior.untranslated = true
  runtime.translation.enqueue('/e.md')
  await runtime.translation.idle()
  assert.equal(mlx.behavior.directCalls, 1)
  const no = await runtime.translation.view('/e.md', 'no')
  assert.match(no.content, /DIRECT: The cat is here/)

  const second = await setup(context, { notes: { '/f.md': '---\ntitle: The cat is here\n---\nThe cat is here\n' } })
  second.mlx.behavior.untranslated = true
  second.mlx.behavior.directSame = true
  second.runtime.translation.enqueue('/f.md')
  await second.runtime.translation.idle()
  assert.equal(second.mlx.behavior.directCalls, 1)
  assert.equal((await second.runtime.translation.view('/f.md', 'no')).status, 'ready')
})

async function waitForJob(translation, jobId) {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const job = translation.getExport(jobId)
    if (!job || job.status !== 'running') return job
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error('export job did not finish')
}

const EXPORT_NOTE = '---\ntitle: Møtenotat\ndescription: Jeg er her\n---\n\nJeg snakket med [[Ola]] og `kode`.\n\n```\nkode\n```\n'

test('export jobs run to done, cache per-language entries, and protect placeholders', async (context) => {
  const { runtime, mlx } = await setup(context, { auto: false, notes: { '/a.md': EXPORT_NOTE } })
  const [started, again] = await Promise.all([
    runtime.translation.startExport('/a.md', 'de'), runtime.translation.startExport('/a.md', 'de'),
  ])
  assert.equal(started.status, 'running')
  assert.equal(started.totalBlocks, 3)
  assert.equal(again.jobId, started.jobId)
  const done = await waitForJob(runtime.translation, started.jobId)
  assert.equal(done.status, 'done')
  assert.equal(done.translatedBlocks, 3)
  assert.equal(done.failedBlocks, 0)
  assert.equal(done.title, 'DIRECT: EN: Møtenotat')
  assert.match(done.content, /DIRECT: EN: Jeg snakket med \[\[Ola\]\] og `kode`\./)
  assert.match(done.content, /```\nkode\n```/)
  const callsAfterFirst = mlx.calls.length
  assert.equal(callsAfterFirst, 6) // detect+translate, then pivot, per block
  const second = await runtime.translation.startExport('/a.md', 'de')
  assert.equal((await waitForJob(runtime.translation, second.jobId)).status, 'done')
  assert.equal(mlx.calls.length, callsAfterFirst)
  const saved = JSON.parse(await fs.readFile(path.join(runtime.bundleRoot, '.folio', 'translations.json'), 'utf8'))
  assert.ok(Object.keys(saved.entries).some((key) => key.endsWith(':de')))
})

test('en and no exports reuse the background cache', async (context) => {
  const { runtime, mlx } = await setup(context, { notes: { '/a.md': NOTE } })
  runtime.translation.enqueue('/a.md')
  await runtime.translation.idle()
  const calls = mlx.calls.length
  const job = await runtime.translation.startExport('/a.md', 'en')
  const done = await waitForJob(runtime.translation, job.jobId)
  assert.equal(done.status, 'done')
  assert.equal(mlx.calls.length, calls)
  assert.match(done.content, /EN: Jeg snakket/)
  assert.match(done.content, /^The weather is nice\.$/m)
})

test('cancelling stops further generate calls; unavailable model returns 503', async (context) => {
  const { runtime, mlx } = await setup(context, { notes: { '/a.md': NOTE } })
  const job = await runtime.translation.startExport('/a.md', 'fr')
  mlx.behavior.onCall = () => runtime.translation.cancelExport(job.jobId)
  await runtime.translation.idle()
  const calls = mlx.calls.length
  assert.ok(calls >= 1 && calls < 5)
  await new Promise((resolve) => setTimeout(resolve, 30))
  assert.equal(mlx.calls.length, calls)
  assert.equal(runtime.translation.getExport(job.jobId).status, 'cancelled')
  assert.deepEqual(runtime.translation.cancelExport(job.jobId), { jobId: job.jobId, status: 'cancelled' })
  assert.equal(runtime.translation.cancelExport('nope'), null)

  const none = await setup(context, { mlx: fakeMlx({ installed: false }), notes: { '/a.md': NOTE } })
  await assert.rejects(() => none.runtime.translation.startExport('/a.md', 'de'), { status: 503 })
  await assert.rejects(() => none.runtime.translation.startExport('/a.md', 'xx'), { status: 400 })
  await assert.rejects(() => none.runtime.translation.startExport('untitled:1', 'de'), { status: 400 })
})

test('backfill pruning keeps language entries whose base hash is referenced; export routes follow the contract', async (context) => {
  const { runtime } = await setup(context, { notes: { '/a.md': EXPORT_NOTE } })
  const app = express()
  app.use(express.json())
  registerRoutes(app, runtime)
  const server = http.createServer(app)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  context.after(() => new Promise((resolve) => server.close(resolve)))
  const base = `http://127.0.0.1:${server.address().port}`
  const post = (body) => fetch(`${base}/api/note/translation/export`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  assert.equal((await post({ id: '/a.md', target: 'xx' })).status, 400)
  assert.equal((await post({ id: '/missing.md', target: 'de' })).status, 404)
  const response = await post({ id: '/a.md', target: 'sv' })
  assert.equal(response.status, 202)
  const job = await response.json()
  await waitForJob(runtime.translation, job.jobId)
  const result = await (await fetch(`${base}/api/note/translation/export/${job.jobId}`)).json()
  assert.equal(result.status, 'done')
  assert.ok(result.content)
  assert.equal((await fetch(`${base}/api/note/translation/export/unknown`)).status, 404)
  assert.equal((await fetch(`${base}/api/note/translation/export/${job.jobId}`, { method: 'DELETE' })).status, 200)

  runtime.translation.startBackfill()
  await new Promise((resolve) => setTimeout(resolve, 30))
  await runtime.translation.idle()
  await runtime.translation.close()
  const saved = JSON.parse(await fs.readFile(path.join(runtime.bundleRoot, '.folio', 'translations.json'), 'utf8'))
  assert.equal(Object.keys(saved.entries).filter((key) => key.endsWith(':sv')).length, 3)
})

test('language exports pivot through English, label the source, and redo stale entries', async (context) => {
  const { runtime, mlx } = await setup(context, { notes: { '/a.md': '---\ntitle: Hei\n---\nJeg er her.\n\nThe cat is here.\n' } })
  const run = async (target) => waitForJob(runtime.translation, (await runtime.translation.startExport('/a.md', target)).jobId)
  const done = await run('de')
  assert.equal(done.status, 'done')
  const pivoted = mlx.behavior.prompts.filter((prompt) => prompt.startsWith('Translate the following English text into German'))
  assert.ok(pivoted.some((prompt) => prompt.includes('EN: Jeg er her.')))
  assert.ok(pivoted.some((prompt) => prompt.includes('The cat is here.')))
  assert.equal(mlx.calls.filter((call) => call === 'The cat is here.').length, 2) // one detect call, one German call (no NO-detour for en sources)
  const cacheFile = path.join(runtime.bundleRoot, '.folio', 'translations.json')
  await runtime.translation.close()
  const saved = JSON.parse(await fs.readFile(cacheFile, 'utf8'))
  const languageKeys = Object.keys(saved.entries).filter((key) => key.endsWith(':de'))
  assert.ok(languageKeys.length >= 2)
  assert.ok(languageKeys.every((key) => Object.hasOwn(saved.entries[key], 'pivot')))
  assert.equal(languageKeys.filter((key) => saved.entries[key].pivot === 'en').length, 2)

  const second = await setup(context, { notes: { '/a.md': '---\ntitle: Hei\n---\nJeg er her.\n' } })
  const first = await waitForJob(second.runtime.translation, (await second.runtime.translation.startExport('/a.md', 'es')).jobId)
  assert.equal(first.status, 'done')
  await second.runtime.translation.close()
  const file = path.join(second.runtime.bundleRoot, '.folio', 'translations.json')
  const stored = JSON.parse(await fs.readFile(file, 'utf8'))
  for (const key of Object.keys(stored.entries)) if (key.endsWith(':es')) delete stored.entries[key].pivot
  await fs.writeFile(file, JSON.stringify(stored))
  const fresh = await setup(context, { mlx: second.mlx })
  await fs.writeFile(path.join(fresh.runtime.bundleRoot, 'a.md'), await fs.readFile(path.join(second.runtime.bundleRoot, 'a.md')))
  await fs.mkdir(path.join(fresh.runtime.bundleRoot, '.folio'), { recursive: true })
  await fs.writeFile(path.join(fresh.runtime.bundleRoot, '.folio', 'translations.json'), JSON.stringify(stored))
  const before = second.mlx.calls.length
  const redone = await waitForJob(fresh.runtime.translation, (await fresh.runtime.translation.startExport('/a.md', 'es')).jobId)
  assert.equal(redone.status, 'done')
  assert.ok(second.mlx.calls.length > before)
})

test('deleting a finished job keeps its status and failedBlocks counts fallbacks', async (context) => {
  const { runtime, mlx } = await setup(context, { notes: { '/a.md': '---\ntitle: Hei\n---\nJeg er `x` her.\n' } })
  mlx.behavior.malformed = 2 // title block detect fails twice -> fallback; the paragraph then succeeds
  const job = await runtime.translation.startExport('/a.md', 'en')
  const done = await waitForJob(runtime.translation, job.jobId)
  assert.equal(done.status, 'done')
  assert.equal(done.failedBlocks, 1)
  assert.deepEqual(runtime.translation.cancelExport(job.jobId), { jobId: job.jobId, status: 'done' })
  assert.equal(runtime.translation.getExport(job.jobId).status, 'done')
})

test('note language comes from frontmatter, else length-weighted cached sources, else null', async (context) => {
  const { runtime } = await setup(context, { notes: {
    '/fm.md': '---\nlanguage: en\n---\nJeg er her og det er bra.\n',
    '/det.md': 'Jeg er her og det er bra.\n\nOk and yes.\n',
    '/tie.md': 'Jeg er her.\n\nThe cat is here.\n',
  } })
  assert.deepEqual(await runtime.translation.language('/det.md'), { id: '/det.md', noteLanguage: null, noteLanguageSource: null, autoTranslate: true })
  assert.deepEqual(await runtime.translation.language('/fm.md'), { id: '/fm.md', noteLanguage: 'en', noteLanguageSource: 'frontmatter', autoTranslate: true })
  runtime.translation.enqueue('/det.md')
  runtime.translation.enqueue('/tie.md')
  await runtime.translation.idle()
  const detected = await runtime.translation.language('/det.md')
  assert.equal(detected.noteLanguage, 'no')
  assert.equal(detected.noteLanguageSource, 'detected')
  assert.equal((await runtime.translation.view('/det.md', 'en')).noteLanguage, 'no')
  const tie = await runtime.translation.language('/tie.md')
  assert.equal(tie.noteLanguage === null, tie.noteLanguageSource === null)
})

const CAPTURE = (id, text) => `<!-- folio:capture:confirmation:${id}:start -->\n${text}\n<!-- folio:capture:confirmation:${id}:end -->`
const ID_A = 'e13334ea48c53b9398767ae7'
const ID_B = 'a13334ea48c53b9398767ae8'

test('filed captures are translated without markers or generated wrappers', async (context) => {
  const body = `# Captured note\n\n${CAPTURE(ID_A, 'Møte med regnskapsføreren er neste uke.')}\n\n<!-- folio:generated-related:start -->\n# Related\n\n- [Other](/other.md) - Related\n<!-- folio:generated-related:end -->`
  const aggregate = `# Todo\n\n${CAPTURE(ID_A, 'Jeg er klar og det er bra.')}\n\n---\n\n${CAPTURE(ID_B, 'The cat is here.')}`
  const { runtime, mlx } = await setup(context, { notes: {
    '/c.md': `---\ntitle: Møte\n---\n\n${body}\n`,
    '/todo-list.md': `---\ntitle: Todo\n---\n\n${aggregate}\n`,
  } })
  runtime.translation.enqueue('/c.md')
  runtime.translation.enqueue('/todo-list.md')
  await runtime.translation.idle()
  const view = await runtime.translation.view('/c.md', 'en')
  assert.equal(view.status, 'ready')
  assert.match(view.content, /^EN: Møte med regnskapsføreren er neste uke\.$/m)
  assert.doesNotMatch(view.content, /folio:|Captured note|Related/)
  assert.ok(mlx.calls.includes('Møte med regnskapsføreren er neste uke.'))
  const todo = await runtime.translation.view('/todo-list.md', 'en')
  assert.match(todo.content, /EN: Jeg er klar og det er bra\./)
  assert.match(todo.content, /The cat is here\./)
  const todoNo = await runtime.translation.view('/todo-list.md', 'no')
  assert.match(todoNo.content, /NO: The cat is here\./)
  assert.doesNotMatch(todo.content + todoNo.content, /folio:capture/)
  const job = await runtime.translation.startExport('/c.md', 'de')
  const done = await waitForJob(runtime.translation, job.jobId)
  assert.match(done.content, /DIRECT: EN: Møte med regnskapsføreren/)
  assert.doesNotMatch(done.content, /folio:|Captured note|Related/)
})

test('a standalone HTML comment line does not swallow the following paragraph', async () => {
  const { splitBody, translatableBlocks } = await import('../server/translation/blocks.js')
  const items = splitBody('<!-- note -->\nJeg er her og det er bra.\n\n<!--\nmulti\nline\n-->\nOg så mer tekst her.')
  assert.deepEqual(translatableBlocks(items).map((block) => block.text), ['Jeg er her og det er bra.', 'Og så mer tekst her.'])
})

test('export jobs report phase and the last translated text', async (context) => {
  const { runtime, mlx } = await setup(context, { notes: { '/a.md': NOTE } })
  let busy = true
  mlx.isBusy = () => busy
  const first = await runtime.translation.startExport('/a.md', 'de')
  const second = await runtime.translation.startExport('/a.md', 'fr')
  assert.equal(first.phase, 'waiting')
  assert.equal(second.phase, 'queued')
  assert.equal(first.lastTranslated, null)
  await new Promise((resolve) => setTimeout(resolve, 40))
  assert.equal(runtime.translation.getExport(first.jobId).phase, 'waiting')
  assert.equal(runtime.translation.getExport(second.jobId).phase, 'queued')
  const phases = new Set()
  mlx.behavior.onCall = () => phases.add(runtime.translation.getExport(first.jobId).phase)
  busy = false
  const done = await waitForJob(runtime.translation, first.jobId)
  assert.ok(phases.has('translating'))
  assert.equal(done.phase, 'done')
  assert.ok(done.lastTranslated && done.lastTranslated.length <= 160 && !/<x\d+\/>/.test(done.lastTranslated))
  assert.equal((await waitForJob(runtime.translation, second.jobId)).phase, 'done')
})

test('cached translations with delimiter echoes are sanitized on read', async (context) => {
  const { runtime } = await setup(context, { notes: { '/a.md': 'Jeg er her.\n' } })
  runtime.translation.enqueue('/a.md')
  await runtime.translation.idle()
  const file = path.join(runtime.bundleRoot, '.folio', 'translations.json')
  await runtime.translation.close()
  const saved = JSON.parse(await fs.readFile(file, 'utf8'))
  for (const entry of Object.values(saved.entries)) if (entry.translation) entry.translation = `<<<\n${entry.translation}\n>>>`
  await fs.writeFile(file, JSON.stringify(saved))
  const fresh = await setup(context, { notes: { '/a.md': 'Jeg er her.\n' } })
  await fs.mkdir(path.join(fresh.runtime.bundleRoot, '.folio'), { recursive: true })
  await fs.writeFile(path.join(fresh.runtime.bundleRoot, '.folio', 'translations.json'), JSON.stringify(saved))
  const view = await fresh.runtime.translation.view('/a.md', 'en')
  assert.doesNotMatch(view.content, /<<<|>>>/)
  assert.match(view.content, /EN: Jeg er her\./)
})
