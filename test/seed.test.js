import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import YAML from 'yaml'

const bundleRoot = path.resolve('seed-data/bundle')

async function markdownFiles(directory) {
  const entries = await fs.readdir(directory, { withFileTypes: true })
  const files = await Promise.all(entries.map((entry) => {
    const entryPath = path.join(directory, entry.name)
    return entry.isDirectory() ? markdownFiles(entryPath) : entry.name.endsWith('.md') ? [entryPath] : []
  }))
  return files.flat()
}

function parseSeedMarkdown(markdown, filePath) {
  const match = markdown.match(/^---\n([\s\S]*?)\n---\n+([\s\S]*)$/)
  assert.ok(match, `${filePath} must contain YAML frontmatter and a Markdown body`)
  return { frontmatter: YAML.parse(match[1]), content: match[2].trim() }
}

test('starter bundle contains valid linked onboarding notes', async () => {
  const expectedIds = [
    '/daily/2026-09-03.md',
    '/getting-started/capture-and-organize.md',
    '/getting-started/ollama.md',
    '/getting-started/search-ask-and-workspace.md',
    '/getting-started/start-here.md',
    '/todo-list.md',
  ]
  const files = await markdownFiles(bundleRoot)
  const conceptFiles = files.filter((filePath) => !['index.md', 'log.md'].includes(path.basename(filePath)))
  const ids = conceptFiles.map((filePath) => `/${path.relative(bundleRoot, filePath).split(path.sep).join('/')}`).sort()
  assert.deepEqual(ids, expectedIds)

  const concepts = new Map()
  for (const filePath of conceptFiles) {
    const id = `/${path.relative(bundleRoot, filePath).split(path.sep).join('/')}`
    const parsed = parseSeedMarkdown(await fs.readFile(filePath, 'utf8'), filePath)
    assert.equal(typeof parsed.frontmatter.type, 'string')
    assert.equal(typeof parsed.frontmatter.title, 'string')
    assert.equal(typeof parsed.frontmatter.description, 'string')
    assert.ok(Array.isArray(parsed.frontmatter.tags))
    assert.ok(['draft', 'stable', 'deprecated'].includes(parsed.frontmatter.status))
    assert.ok(parsed.frontmatter.generated?.by)
    assert.ok(!Number.isNaN(Date.parse(parsed.frontmatter.generated?.at)))
    assert.ok(parsed.content)
    concepts.set(id, parsed)
  }

  for (const [id, concept] of concepts) {
    for (const relatedId of concept.frontmatter.folio_related || []) {
      assert.ok(concepts.has(relatedId), `${id} links to missing starter note ${relatedId}`)
    }
  }

  assert.match(concepts.get('/todo-list.md').content, /- \[ \] Add your first task/)
  assert.match(concepts.get('/todo-list.md').content, /todo:/)
  assert.match(concepts.get('/daily/2026-09-03.md').content, /daily:/)
  assert.match(concepts.get('/getting-started/ollama.md').content, /embeddinggemma/)
})
