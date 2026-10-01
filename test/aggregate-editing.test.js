import assert from 'node:assert/strict'
import test from 'node:test'
import { mergeAppendedContent, preservePendingCaptureMarkers, prepareAggregateContentForSave } from '../server/filing/aggregate-editing.js'

const captureOne = '<!-- folio:capture:first:start -->\n## 2026-10-01 10:30\n\n- [ ] Repeat the same task\n<!-- folio:capture:first:end -->'
const captureTwo = '<!-- folio:capture:second:start -->\n## 2026-10-01 10:30\n\n- [ ] Repeat the same task\n<!-- folio:capture:second:end -->'
const firstSource = { capture_id: 'first', confirmation: { finalId: null } }
const secondSource = { capture_id: 'second', confirmation: { finalId: null } }

test('keeps a repeated capture even when its text is already in the observed Todo base', () => {
  const base = `# Todo\n\n${captureOne.replace(/<!-- folio:capture:[^>]+ -->/g, '')}`
  const current = `${base}\n\n${captureTwo.replace(/<!-- folio:capture:[^>]+ -->/g, '')}`
  const merged = mergeAppendedContent(base, base, current)
  assert.equal((merged.match(/Repeat the same task/g) || []).length, 2)
})

test('restores markers to distinct ordered copies of identical pending captures', () => {
  const current = `# Todo\n\n${captureOne}\n\n${captureTwo}`
  const next = `# Todo\n\n## 2026-10-01 10:30\n\n- [x] Repeat the same task\n\n## 2026-10-01 10:30\n\n- [ ] Repeat the same task`
  const restored = preservePendingCaptureMarkers(current, next, [firstSource, secondSource])
  assert.ok(restored)
  assert.ok(restored.indexOf('first:start') < restored.indexOf('first:end'))
  assert.ok(restored.indexOf('first:end') < restored.indexOf('second:start'))
  assert.ok(restored.indexOf('second:start') < restored.indexOf('second:end'))
  assert.match(restored, /first:start -->\n## 2026-10-01 10:30\n\n- \[x\] Repeat the same task/)
  assert.match(restored, /second:start -->\n## 2026-10-01 10:30\n\n- \[ \] Repeat the same task/)
})

test('rejects marker restoration when identical content makes attribution ambiguous', () => {
  const current = `# Todo\n\n${captureOne}\n\n${captureTwo}`
  const next = `# Todo\n\n## 2026-10-01 10:30\n\n- [ ] Repeat the same task\n\n## 2026-10-01 10:30\n\n- [ ] Repeat the same task\n\n## 2026-10-01 10:30\n\n- [ ] Repeat the same task`
  assert.equal(preservePendingCaptureMarkers(current, next, [firstSource, secondSource]), null)
})

test('merges Daily Note edits as plain paragraphs while retaining pending receipt markers', () => {
  const base = '# Daily 2026-10-01\nMorning entry.'
  const captureId = 'daily-capture'
  const current = `${base}\n\n<!-- folio:capture:${captureId}:start -->\n## 10:30\n\nAfternoon entry.\n<!-- folio:capture:${captureId}:end -->`
  const incoming = `${base}\n\nA local paragraph written before the capture.`
  const result = prepareAggregateContentForSave({
    baseContent: base,
    content: incoming,
    parsed: {
      content: current,
      frontmatter: { sources: [{ capture_id: captureId, confirmation: { finalId: null } }] },
    },
    indexedConceptContent: () => current,
  })
  assert.equal(result.error, undefined)
  assert.match(result.content, /Morning entry\./)
  assert.match(result.content, /A local paragraph written before the capture\./)
  assert.match(result.content, /Afternoon entry\./)
  assert.match(result.content, new RegExp(`<!-- folio:capture:${captureId}:start -->`))
  assert.doesNotMatch(result.content, /- \[[ x]\]/)
})
