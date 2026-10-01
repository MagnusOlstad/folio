const WEEKDAYS = {
  sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6,
  søndag: 0, mandag: 1, tirsdag: 2, onsdag: 3, torsdag: 4, fredag: 5, lørdag: 6,
}

function localDateKey(date, timeZone) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date)
}

function dateAtLocalNoon(dateKey) {
  return new Date(`${dateKey}T12:00:00.000Z`)
}

function addCalendarDays(dateKey, amount) {
  const date = dateAtLocalNoon(dateKey)
  date.setUTCDate(date.getUTCDate() + amount)
  return date.toISOString().slice(0, 10)
}

function localWeekday(dateKey) {
  return ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'][dateAtLocalNoon(dateKey).getUTCDay()]
}

function mondayOfWeek(dateKey) {
  const day = WEEKDAYS[localWeekday(dateKey)]
  return addCalendarDays(dateKey, day === 0 ? -6 : 1 - day)
}

function resolvedDate(phrase, today) {
  const normalized = phrase.toLocaleLowerCase().replace(/\s+/g, ' ').trim()
  if (['today', 'i dag'].includes(normalized)) return today
  if (['tomorrow', 'i morgen'].includes(normalized)) return addCalendarDays(today, 1)
  if (['yesterday', 'i går'].includes(normalized)) return addCalendarDays(today, -1)
  if (['this week', 'denne uke', 'denne uka', 'denne uken'].includes(normalized)) return `week of ${mondayOfWeek(today)}`
  if (['next week', 'neste uke', 'neste uka', 'neste uken'].includes(normalized)) return `week of ${addCalendarDays(mondayOfWeek(today), 7)}`

  const weekdayMatch = normalized.match(/^(next|this|last|neste|kommende|forrige)\s+([\p{L}]+)$/u)
  if (!weekdayMatch) return null
  const requestedDay = WEEKDAYS[weekdayMatch[2]]
  if (requestedDay === undefined) return null
  const currentDay = WEEKDAYS[localWeekday(today)]
  const modifier = weekdayMatch[1]
  const difference = requestedDay - currentDay
  if (['last', 'forrige'].includes(modifier)) return addCalendarDays(today, difference >= 0 ? difference - 7 : difference)
  if (['next', 'neste', 'kommende'].includes(modifier)) return addCalendarDays(today, difference > 0 ? difference : difference + 7)
  return addCalendarDays(today, difference)
}

export function unquotedSource(content) {
  return String(content)
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`]*`/g, ' ')
    .split(/\r?\n/)
    .filter((line) => !/^\s*>/.test(line))
    .join('\n')
    .replace(/"[^"\n]*"|“[^”\n]*”|‘[^’\n]*’|(?<!\w)'[^'\n]+'(?!\w)/g, ' ')
}

function dateAfterPhrase(text, endOffset) {
  return /^\s*\(\s*(?:\d{4}-\d{2}-\d{2}|week of \d{4}-\d{2}-\d{2})\s*\)/i.test(text.slice(endOffset))
}

function phrasePattern(phrase, global = false) {
  const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+')
  return new RegExp(`\\b${escaped}\\b`, global ? 'gi' : 'i')
}

function supportedRelativePhrases(text) {
  const phrases = [
    'next week', 'this week', 'neste uke', 'neste uka', 'neste uken', 'denne uke', 'denne uka', 'denne uken',
    'tomorrow', 'yesterday', 'today', 'i morgen', 'i går', 'i dag',
    ...Object.keys(WEEKDAYS).flatMap((weekday) => [
      `next ${weekday}`, `this ${weekday}`, `last ${weekday}`,
      `neste ${weekday}`, `kommende ${weekday}`, `forrige ${weekday}`,
    ]),
  ].sort((left, right) => right.length - left.length)
  const found = new Set()
  for (const phrase of phrases) {
    const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+')
    if (new RegExp(`\\b${escaped}\\b`, 'i').test(text)) found.add(phrase)
  }
  return found
}

export function annotateRelativeDates(description, content, { now = new Date(), timeZone = 'UTC' } = {}) {
  const summary = String(description)
  const eligibleSource = unquotedSource(content)
  const today = localDateKey(now, timeZone)
  const sourceDates = new Set()
  for (const phrase of supportedRelativePhrases(eligibleSource)) {
    const matcher = phrasePattern(phrase, true)
    for (const match of eligibleSource.matchAll(matcher)) {
      if (dateAfterPhrase(eligibleSource, match.index + match[0].length)) continue
      const date = resolvedDate(phrase, today)
      if (date) sourceDates.add(date)
    }
  }
  if (!sourceDates.size) return summary

  let annotated = summary
  for (const phrase of supportedRelativePhrases(summary)) {
    const date = resolvedDate(phrase, today)
    if (!date || !sourceDates.has(date)) continue
    const matcher = phrasePattern(phrase)
    const match = matcher.exec(annotated)
    if (!match || dateAfterPhrase(annotated, match.index + match[0].length) || annotated.length + ` (${date})`.length > 240) continue
    annotated = `${annotated.slice(0, match.index)}${match[0]} (${date})${annotated.slice(match.index + match[0].length)}`
  }
  return annotated
}
