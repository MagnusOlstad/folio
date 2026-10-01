import assert from 'node:assert/strict'
import test from 'node:test'
import { createFilingService } from '../server/filing/service.js'

const { aggregateEntryContent } = createFilingService({})

test('formats each plain Todo line as a separate unchecked task', () => {
  assert.equal(
    aggregateEntryContent('Call Sam\nEmail Pat\nBook the room', 'todo'),
    '- [ ] Call Sam\n- [ ] Email Pat\n- [ ] Book the room',
  )
})

test('strips Todo steering from an inline first task', () => {
  assert.equal(
    aggregateEntryContent('TODO: Call Sam\nEmail Pat', 'todo'),
    '- [ ] Call Sam\n- [ ] Email Pat',
  )
})

test('preserves existing unchecked and checked task markers', () => {
  assert.equal(
    aggregateEntryContent('- [ ] Buy milk\n- [x] Pay rent', 'todo'),
    '- [ ] Buy milk\n- [x] Pay rent',
  )
})

test('normalizes common bullet and numbered list markers', () => {
  assert.equal(
    aggregateEntryContent('- Buy milk\n* Call Sam\n+ Email Pat\n1. Book the room\n2) Confirm the time', 'todo'),
    '- [ ] Buy milk\n- [ ] Call Sam\n- [ ] Email Pat\n- [ ] Book the room\n- [ ] Confirm the time',
  )
})

test('ignores blank lines without adding empty tasks', () => {
  assert.equal(
    aggregateEntryContent('\nFirst task\n\n  \nSecond task\n\n', 'todo'),
    '- [ ] First task\n- [ ] Second task',
  )
})

test('keeps indented continuation and nested task lines under their parent', () => {
  assert.equal(
    aggregateEntryContent('Plan trip\n  Pack passport\n  - [ ] Check expiry\nBook hotel', 'todo'),
    '- [ ] Plan trip\n  Pack passport\n  - [ ] Check expiry\n- [ ] Book hotel',
  )
})

test('keeps daily aggregate formatting unchanged', () => {
  assert.equal(
    aggregateEntryContent('Daily: Morning walk\n\nReview notes', 'daily'),
    'Morning walk\n\nReview notes',
  )
})
