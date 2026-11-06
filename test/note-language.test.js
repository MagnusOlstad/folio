import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import YAML from 'yaml'

import { createApp, createRuntime } from '../server/app.js'
import { createMlxService } from '../server/mlx/service.js'
import { configureFakeMlx } from './fixtures/mlx-test-support.js'

function frontmatterOf(markdown) {
  return YAML.parse(markdown.slice(4, markdown.indexOf('\n---\n', 4)))
}

test('filing stores language in frontmatter only for new no/en notes and it survives edits, moves and refiles', async (context) => {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'folio-language-'))
  const fixture = await configureFakeMlx(context, { modelRoot: path.join(dataRoot, 'models') })
  const mlxService = createMlxService({ modelRoot: fixture.modelRoot, mlxHelperPath: fixture.helperPath })
  await mlxService.install('gemma4')
  await mlxService.install('embeddinggemma')
  fixture.restorePlatform()
  await fs.mkdir(path.join(dataRoot, 'bundle'), { recursive: true })
  const runtime = createRuntime({ ...process.env, FOLIO_DATA_ROOT: dataRoot, FOLIO_MODEL_ROOT: fixture.modelRoot }, mlxService)
  const app = await createApp(runtime)
  const server = await new Promise((resolve) => { const listener = app.listen(0, '127.0.0.1', () => resolve(listener)) })
  context.after(async () => {
    await new Promise((resolve) => server.close(resolve))
    await app.bundleManager.close()
    await mlxService.close()
    await fs.rm(dataRoot, { recursive: true, force: true })
  })
  const base = `http://127.0.0.1:${server.address().port}`
  const send = (url, method, body) => fetch(`${base}${url}`, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  const file = (id) => path.join(dataRoot, 'bundle', id.slice(1))
  const file_ = async (content) => {
    const response = await send('/api/notes', 'POST', { content, timeZone: 'Europe/Oslo' })
    assert.equal(response.status, 201)
    return (await response.json()).note.id
  }

  const english = await file_('Planning note: we will meet on Friday and the plan is not final.')
  const norwegian = await file_('Semantic neighbor: Jeg har ikke tid til møtet på fredag, og det er synd.')
  const other = await file_('Attribution path 12345 67890')
  assert.equal(frontmatterOf(await fs.readFile(file(english), 'utf8')).language, 'en')
  assert.equal(frontmatterOf(await fs.readFile(file(norwegian), 'utf8')).language, 'no')
  assert.equal('language' in frontmatterOf(await fs.readFile(file(other), 'utf8')), false)

  const todo = await send('/api/notes', 'POST', { content: 'Path override todo: buy milk and eggs for the week.', timeZone: 'Europe/Oslo' })
  assert.equal(todo.status, 201)
  assert.equal('language' in frontmatterOf(await fs.readFile(file('/todo-list.md'), 'utf8')), false, 'appends never set language')

  const patch = await send(`/api/note?id=${encodeURIComponent(norwegian)}`, 'PATCH', { content: 'Oppdatert tekst, og det er bra.', tags: ['ny'] })
  assert.equal(patch.status, 200)
  assert.equal(frontmatterOf(await fs.readFile(file(norwegian), 'utf8')).language, 'no')

  const moved = await (await send('/api/file/move', 'POST', { id: norwegian, directory: '/manual/curated' })).json()
  assert.equal(frontmatterOf(await fs.readFile(file(moved.newId), 'utf8')).language, 'no')

  const proposal = await (await send('/api/file/refile/propose', 'POST', { id: moved.newId })).json()
  const refiled = await (await send('/api/file/refile', 'POST', {
    id: moved.newId, hash: proposal.hash,
    fields: { directory: '/archive', filename: proposal.proposal.filename, title: 'Ny tittel', description: 'Ny beskrivelse.', tags: ['a'] },
  })).json()
  assert.equal(frontmatterOf(await fs.readFile(file(refiled.newId), 'utf8')).language, 'no')

  const detail = await (await fetch(`${base}/api/note/language?id=${encodeURIComponent(refiled.newId)}`)).json()
  assert.deepEqual(detail, { id: refiled.newId, noteLanguage: 'no', noteLanguageSource: 'frontmatter' })
  const nothing = await (await fetch(`${base}/api/note/language?id=${encodeURIComponent(other)}`)).json()
  assert.deepEqual(nothing, { id: other, noteLanguage: null, noteLanguageSource: null })
  assert.equal((await fetch(`${base}/api/note/language?id=untitled:1`)).status, 400)
  assert.equal((await fetch(`${base}/api/note/language?id=/missing.md`)).status, 404)
  const view = await (await fetch(`${base}/api/note/translation?id=${encodeURIComponent(english)}&target=no`)).json()
  assert.equal(view.noteLanguage, 'en')
  assert.equal(view.noteLanguageSource, 'frontmatter')
})
