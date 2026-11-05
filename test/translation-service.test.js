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
      const text = messages.at(-1).content.match(/<<<\n([\s\S]*)\n>>>/)[1]
      calls.push(text)
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

async function setup(context, { mlx = fakeMlx(), notes = {} } = {}) {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'folio-translation-'))
  context.after(() => fs.rm(dataRoot, { recursive: true, force: true }))
  await fs.mkdir(path.join(dataRoot, 'bundle'), { recursive: true })
  const runtime = createRuntime({ FOLIO_DATA_ROOT: dataRoot, FOLIO_MODEL_ROOT: path.join(dataRoot, 'models') }, mlx)
  runtime.translation = createTranslationService(runtime, { debounceMs: 0, backfillDelayMs: 0, statusTtlMs: 0, busyPollMs: 5 })
  context.after(() => runtime.translation.close())
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

test('disabled setting stops all generation and settings are persisted app-wide', async (context) => {
  const { runtime, mlx } = await setup(context, { notes: { '/a.md': NOTE } })
  assert.deepEqual(await runtime.translation.getSettings(), { enabled: true, available: true })
  assert.deepEqual(await runtime.translation.setEnabled(false), { enabled: false, available: true })
  runtime.translation.enqueue('/a.md')
  runtime.translation.prioritize('/a.md')
  runtime.translation.startBackfill()
  await runtime.translation.idle()
  const view = await runtime.translation.view('/a.md', 'en')
  assert.equal(view.status, 'disabled')
  assert.equal(mlx.calls.length, 0)
  assert.ok((await fs.readFile(path.join(runtime.modelRoot, 'translation-settings.json'), 'utf8')).includes('false'))
})

test('does nothing when no generation model is installed', async (context) => {
  const { runtime, mlx } = await setup(context, { mlx: fakeMlx({ installed: false }), notes: { '/a.md': NOTE } })
  runtime.translation.enqueue('/a.md')
  await runtime.translation.idle()
  assert.equal(mlx.calls.length, 0)
  assert.deepEqual(await runtime.translation.getSettings(), { enabled: true, available: false })
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
  assert.deepEqual(Object.keys(first).sort(), ['content', 'description', 'id', 'status', 'target', 'title', 'totalBlocks', 'translatedBlocks'])
  assert.equal(first.status, 'pending')
  await runtime.translation.idle()
  assert.equal((await (await get('id=/a.md&target=en')).json()).status, 'ready')
  const prioritized = await send('/api/note/translation/prioritize', 'POST', { id: '/a.md' })
  assert.equal(prioritized.status, 202)
  assert.deepEqual(await prioritized.json(), { queued: true })

  assert.deepEqual(await (await fetch(`${base}/api/translation/settings`)).json(), { enabled: true, available: true })
  assert.equal((await send('/api/translation/settings', 'PUT', { enabled: 'no' })).status, 400)
  assert.deepEqual(await (await send('/api/translation/settings', 'PUT', { enabled: false })).json(), { enabled: false, available: true })
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
