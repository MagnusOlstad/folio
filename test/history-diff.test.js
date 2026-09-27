import assert from 'node:assert/strict'
import test from 'node:test'

import { unifiedDiff } from '../server/history/diff.js'

test('history diff shows current-to-selected changes in separate hunks', () => {
  const current = Array.from({ length: 30 }, (_, index) => `current ${index}`).join('\n')
  const selectedLines = Array.from({ length: 30 }, (_, index) => `current ${index}`)
  selectedLines[2] = 'selected first'
  selectedLines[25] = 'selected second'
  const diff = unifiedDiff(current, selectedLines.join('\n'), 'notes/example.md')

  assert.match(diff, /\+selected first/)
  assert.match(diff, /-current 2/)
  assert.match(diff, /\+selected second/)
  assert.match(diff, /-current 25/)
  assert.equal((diff.match(/^@@ /gm) || []).length, 2)
  assert.doesNotMatch(diff, /[+-]current (?:10|11|12|13|14|15|16|17|18|19)/)
})

test('history diff reports valid ranges for insertions, deletions, and identical text', () => {
  assert.match(unifiedDiff('one\ntwo', 'one\nadded\ntwo', 'note.md'), /@@ -1,2 \+1,3 @@/)
  assert.match(unifiedDiff('one\nremoved\ntwo', 'one\ntwo', 'note.md'), /@@ -1,3 \+1,2 @@/)
  assert.match(unifiedDiff('', 'added', 'note.md'), /@@ -0,0 \+1,1 @@\n\+added/)
  assert.equal(unifiedDiff('same', 'same', 'note.md'), '')
})

test('history diff rejects pathological work without inventing unchanged deletions', () => {
  const current = Array.from({ length: 2_001 }, (_, index) => `current ${index}`).join('\n')
  const selected = Array.from({ length: 2_001 }, (_, index) => `selected ${index}`).join('\n')
  assert.throws(() => unifiedDiff(current, selected, 'note.md'), /comparison limit/)
})
