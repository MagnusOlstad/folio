import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const serverRoot = path.join(projectRoot, 'server')

async function javascriptFiles(directory) {
  const entries = await fs.readdir(directory, { withFileTypes: true })
  const nested = await Promise.all(entries.map((entry) => {
    const entryPath = path.join(directory, entry.name)
    if (entry.isDirectory()) return javascriptFiles(entryPath)
    return entry.isFile() && path.extname(entry.name) === '.js' ? [entryPath] : []
  }))
  return nested.flat()
}

test('server modules stay below 500 lines', async () => {
  const oversized = []
  for (const filePath of await javascriptFiles(serverRoot)) {
    const content = await fs.readFile(filePath, 'utf8')
    const lines = content.endsWith('\n') ? content.slice(0, -1).split('\n').length : content.split('\n').length
    if (lines >= 500) oversized.push(`${path.relative(projectRoot, filePath)} (${lines} lines)`)
  }
  assert.deepEqual(oversized, [], `Split oversized server modules:\n${oversized.join('\n')}`)
})
