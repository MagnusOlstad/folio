import assert from 'node:assert/strict'
import test from 'node:test'

import { annotateRelativeDates } from '../server/knowledge/relative-dates.js'

const oslo = { now: new Date('2026-10-01T12:00:00.000Z'), timeZone: 'Europe/Oslo' }

test('relative day references are resolved in metadata in English and Norwegian', () => {
  assert.equal(
    annotateRelativeDates('Send it tomorrow, after reviewing it today.', 'Tomorrow I will send the revision today.', oslo),
    'Send it tomorrow (2026-10-02), after reviewing it today (2026-10-01).',
  )
  assert.equal(
    annotateRelativeDates('We heard about it yesterday and will retry i morgen.', 'I går we heard about it; i morgen we will retry.', oslo),
    'We heard about it yesterday (2026-09-30) and will retry i morgen (2026-10-02).',
  )
})

test('relative week and modified weekday phrases resolve to unambiguous calendar dates', () => {
  assert.equal(annotateRelativeDates('Review it next week and send it next Friday.', 'Review it next week and send it next Friday.', oslo),
    'Review it next week (week of 2026-10-05) and send it next Friday (2026-10-02).')
  assert.equal(annotateRelativeDates('Schedule it this Monday and report last Monday.', 'This Monday we scheduled it; last Monday we reported it.', oslo),
    'Schedule it this Monday (2026-09-28) and report last Monday (2026-09-28).')
})

test('timezone rollover, quotations, code, and explicit dates are handled without changing the note', () => {
  const content = [
    'Tomorrow I will send the permit.',
    '> “Yesterday we sent the old draft.”',
    '`Next Friday` is shown as literal Markdown.',
    'The note already says tomorrow (2026-10-02).',
  ].join('\n')
  assert.equal(annotateRelativeDates('Tomorrow is the send date.', content, oslo), 'Tomorrow (2026-10-02) is the send date.')
  assert.equal(annotateRelativeDates('Yesterday is in an old quote.', '> Yesterday is in an old quote.', oslo), 'Yesterday is in an old quote.')
  assert.equal(annotateRelativeDates('Tomorrow is in an old quote.', "'Tomorrow is in an old quote.'", oslo), 'Tomorrow is in an old quote.')
  assert.equal(annotateRelativeDates('Tomorrow (2026-10-02) is already explicit.', 'Tomorrow is scheduled.', oslo), 'Tomorrow (2026-10-02) is already explicit.')

  const rollover = { now: new Date('2026-03-29T23:30:00.000Z'), timeZone: 'Europe/Oslo' }
  assert.equal(annotateRelativeDates('Do it tomorrow.', 'Tomorrow do it.', rollover), 'Do it tomorrow (2026-03-31).')
})

test('no relative phrase in the note means the model description is left alone', () => {
  assert.equal(annotateRelativeDates('Tomorrow, the author will act.', 'The author will act on 2026-10-02.', oslo), 'Tomorrow, the author will act.')
})
