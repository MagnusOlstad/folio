import path from 'node:path'

export function createSearchService(runtime) {
  const { normalizeTag, markdownText, recordIsStale, lifecycleFactor, embedQuery, embeddingDimension, cosineSimilarity,
    bestSemanticChunk } = runtime
const searchStopWords = new Set([
  'a', 'about', 'all', 'and', 'are', 'do', 'for', 'from', 'have', 'i', 'in', 'is', 'me', 'my', 'notes', 'of', 'on', 'say', 'the', 'to', 'what',
  'alle', 'den', 'det', 'er', 'fra', 'har', 'hva', 'jeg', 'med', 'mine', 'notater', 'notatene', 'og', 'om', 'på', 'sier', 'som', 'til',
])

function searchTerms(value) {
  const terms = String(value)
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .match(/[\p{L}\p{N}]+/gu) || []
  const meaningful = terms.filter((term) => term.length > 1 && !searchStopWords.has(term))
  return meaningful.length ? Array.from(new Set(meaningful)) : Array.from(new Set(terms))
}

function textMatchScore(text, terms) {
  if (!terms.length) return 0
  const words = searchTerms(text)
  const matches = terms.filter((term) => words.some((word) => (
    word === term
    || (Math.min(word.length, term.length) >= 4 && (word.startsWith(term) || term.startsWith(word)))
  )))
  return matches.length / terms.length
}

function lexicalScores(record, query) {
  const terms = searchTerms(query)
  const metadata = `${record.title} ${record.description} ${record.type} ${record.tags.join(' ')}`
  const pathMetadata = path.posix.dirname(record.id).replaceAll('/', ' ')
  return {
    metadata: textMatchScore(metadata, terms) * 0.85 + textMatchScore(pathMetadata, terms) * 0.15,
    content: textMatchScore(record.content, terms),
  }
}

function lexicalScore(record, query) {
  const scores = lexicalScores(record, query)
  return scores.metadata * 0.65 + scores.content * 0.35
}

function searchResultSnippet(content, query, maxLength = 320) {
  const normalized = String(content).replace(/\s+/g, ' ').trim()
  if (normalized.length <= maxLength) return normalized
  const positions = searchTerms(query)
    .map((term) => normalized.toLocaleLowerCase().indexOf(term.toLocaleLowerCase()))
    .filter((position) => position >= 0)
  const matchPosition = positions.length ? Math.min(...positions) : 0
  const start = Math.max(0, Math.min(matchPosition - 80, normalized.length - maxLength))
  return `${start ? '...' : ''}${normalized.slice(start, start + maxLength)}${start + maxLength < normalized.length ? '...' : ''}`
}

function publicSearchRecord({
  embedding: _embedding,
  chunks: _chunks,
  embeddingModel: _embeddingModel,
  embeddingSchemaVersion: _embeddingSchemaVersion,
  embeddingInputHash: _embeddingInputHash,
  suggestedRelatedIds: _suggestedRelatedIds,
  content,
  bestChunk,
  snippet,
  ...record
}) {
  return {
    ...record,
    stale: recordIsStale(record),
    snippet: snippet || searchResultSnippet(bestChunk?.content || content, ''),
  }
}

function updateSemanticSuggestions(records) {
  for (const record of records) {
    const linked = new Set(record.relatedIds || [])
    record.suggestedRelatedIds = record.embedding
      ? records
        .filter((candidate) => candidate.id !== record.id && candidate.embedding && !linked.has(candidate.id))
        .map((candidate) => ({ id: candidate.id, score: cosineSimilarity(record.embedding, candidate.embedding) }))
        .filter((candidate) => candidate.score >= 0.75)
        .sort((left, right) => right.score - left.score)
        .slice(0, 3)
        .map((candidate) => candidate.id)
      : []
  }
}

async function rankedRecords(query, records, limit = 8, tag = '') {
  const normalizedTag = normalizeTag(tag)
  const candidates = normalizedTag
    ? records.filter((record) => record.tags.some((recordTag) => normalizeTag(recordTag) === normalizedTag))
    : records
  if (!query) {
    return candidates
      .map((record) => ({ ...record, score: lifecycleFactor(record), bestChunk: null, snippet: searchResultSnippet(record.content, '') }))
      .sort((left, right) => right.score - left.score || right.createdAt.localeCompare(left.createdAt) || left.id.localeCompare(right.id))
      .slice(0, limit)
  }

  let queryEmbedding = null
  try {
    queryEmbedding = await embedQuery(query, embeddingDimension(candidates))
  } catch {
    // Full-text search remains available while Ollama is stopped.
  }

  return candidates
    .map((record) => {
      const bestChunk = bestSemanticChunk(record, queryEmbedding)
      const semantic = Math.max(cosineSimilarity(queryEmbedding, record.embedding), bestChunk?.score || 0)
      return {
        ...record,
        bestChunk,
        snippet: searchResultSnippet(bestChunk?.content || record.content, query),
        score: (lexicalScore(record, query) * 0.45 + semantic * 0.55) * lifecycleFactor(record),
      }
    })
    .filter((record) => record.score > 0)
    .sort((left, right) => right.score - left.score || right.createdAt.localeCompare(left.createdAt) || left.id.localeCompare(right.id))
    .slice(0, limit)
}

function dateKeyInTimeZone(value, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(value)
  const part = (type) => parts.find((item) => item.type === type)?.value
  return `${part('year')}-${part('month')}-${part('day')}`
}

function addDateKeyDays(dateKey, days) {
  const date = new Date(`${dateKey}T12:00:00Z`)
  date.setUTCDate(date.getUTCDate() + days)
  return date.toISOString().slice(0, 10)
}

function startOfWeekDateKey(dateKey) {
  const date = new Date(`${dateKey}T12:00:00Z`)
  const mondayOffset = (date.getUTCDay() + 6) % 7
  return addDateKeyDays(dateKey, -mondayOffset)
}

function monthStartDateKey(dateKey, monthOffset = 0) {
  const [year, month] = dateKey.split('-').map(Number)
  return new Date(Date.UTC(year, month - 1 + monthOffset, 1, 12)).toISOString().slice(0, 10)
}

function temporalQueryContext(question, now, timeZone) {
  const normalized = question.toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
  const day = dateKeyInTimeZone(now, timeZone)
  let startDate = null
  let endDate = null
  let label = ''
  let relativeDayOffset = null
  let creationRelevant = false

  if (/\b(last week|previous week|forrige uke|sist uke)\b/.test(normalized)) {
    endDate = startOfWeekDateKey(day)
    startDate = addDateKeyDays(endDate, -7)
    label = 'last week'
    creationRelevant = true
  } else if (/\b(this week|denne uka|denne uken)\b/.test(normalized)) {
    startDate = startOfWeekDateKey(day)
    endDate = addDateKeyDays(startDate, 7)
    label = 'this week'
    creationRelevant = true
  } else if (/\b(next week|neste uke)\b/.test(normalized)) {
    startDate = addDateKeyDays(startOfWeekDateKey(day), 7)
    endDate = addDateKeyDays(startDate, 7)
    label = 'next week'
  } else if (/\b(last month|previous month|forrige maned|sist maned)\b/.test(normalized)) {
    endDate = monthStartDateKey(day)
    startDate = monthStartDateKey(day, -1)
    label = 'last month'
    creationRelevant = true
  } else if (/\b(this month|denne maneden|denne maned)\b/.test(normalized)) {
    startDate = monthStartDateKey(day)
    endDate = monthStartDateKey(day, 1)
    label = 'this month'
    creationRelevant = true
  } else if (/\b(next month|neste maned)\b/.test(normalized)) {
    startDate = monthStartDateKey(day, 1)
    endDate = monthStartDateKey(day, 2)
    label = 'next month'
  } else if (/\b(tomorrow|i morgen)\b/.test(normalized)) {
    startDate = addDateKeyDays(day, 1)
    endDate = addDateKeyDays(startDate, 1)
    label = 'tomorrow'
    relativeDayOffset = 1
  } else if (/\b(yesterday|i gar)\b/.test(normalized)) {
    startDate = addDateKeyDays(day, -1)
    endDate = day
    label = 'yesterday'
    relativeDayOffset = -1
    creationRelevant = true
  } else if (/\b(today|i dag)\b/.test(normalized)) {
    startDate = day
    endDate = addDateKeyDays(day, 1)
    label = 'today'
    relativeDayOffset = 0
    creationRelevant = true
  } else if (/\b(recent|recently|latest|newest|nylig|siste|nyeste)\b/.test(normalized)) {
    startDate = addDateKeyDays(day, -30)
    endDate = addDateKeyDays(day, 1)
    label = 'the last 30 days'
    creationRelevant = true
  }

  if (!startDate || !endDate) return null
  return {
    startDate,
    endDate,
    timeZone,
    label,
    relativeDayOffset,
    creationRelevant,
    searchText: `${label} ${startDate} through ${addDateKeyDays(endDate, -1)}`,
  }
}

function temporalScore(record, temporal) {
  if (!temporal) return 0
  const createdAt = new Date(record.createdAt)
  const createdDate = dateKeyInTimeZone(createdAt, temporal.timeZone)
  let score = temporal.creationRelevant && createdDate >= temporal.startDate && createdDate < temporal.endDate ? 0.85 : 0
  const content = record.content.toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '')

  for (let dateKey = temporal.startDate, count = 0; dateKey < temporal.endDate && count < 32; dateKey = addDateKeyDays(dateKey, 1), count += 1) {
    const [year, month, day] = dateKey.split('-')
    const numericDates = [`${Number(day)}.${Number(month)}.${year.slice(-2)}`, `${day}.${month}.${year.slice(-2)}`]
    if (content.includes(dateKey) || numericDates.some((value) => content.includes(value))) score = 1
  }

  if (temporal.relativeDayOffset !== null) {
    const relativeTerms = temporal.relativeDayOffset === 1
      ? /\b(tomorrow|i morgen)\b/
      : temporal.relativeDayOffset === -1
        ? /\b(yesterday|i gar)\b/
        : /\b(today|i dag)\b/
    const referencedDate = addDateKeyDays(createdDate, temporal.relativeDayOffset)
    if (relativeTerms.test(content) && referencedDate >= temporal.startDate && referencedDate < temporal.endDate) score = 1
  }

  return score
}

function splitByUtf8Bytes(value, maxBytes) {
  const parts = []
  let current = ''
  let currentBytes = 0
  for (const character of value) {
    const characterBytes = Buffer.byteLength(character)
    if (current && currentBytes + characterBytes > maxBytes) {
      parts.push(current)
      current = ''
      currentBytes = 0
    }
    current += character
    currentBytes += characterBytes
  }
  if (current) parts.push(current)
  return parts
}

function noteChunks(content, maxBytes = 1600, overlapBytes = 240) {
  const rawUnits = String(content).match(/\S+\s*/gu) || []
  const units = rawUnits.flatMap((unit) => (
    Buffer.byteLength(unit) > maxBytes ? splitByUtf8Bytes(unit, maxBytes) : [unit]
  ))
  const chunks = []
  let current = []

  const flush = () => {
    const chunk = current.join('').trim()
    if (chunk) chunks.push(chunk)
    const overlap = []
    let bytes = 0
    for (let index = current.length - 1; index >= 0; index -= 1) {
      const unitBytes = Buffer.byteLength(current[index])
      if (bytes + unitBytes > overlapBytes) break
      overlap.unshift(current[index])
      bytes += unitBytes
    }
    current = overlap
  }

  for (const unit of units) {
    if (current.length && Buffer.byteLength(current.join('')) + Buffer.byteLength(unit) > maxBytes) {
      flush()
      if (current.length && Buffer.byteLength(current.join('')) + Buffer.byteLength(unit) > maxBytes) current = []
    }
    current.push(unit)
  }
  if (current.length) {
    const chunk = current.join('').trim()
    if (chunk && chunk !== chunks.at(-1)) chunks.push(chunk)
  }
  return chunks.length ? chunks : [String(content).slice(0, maxBytes)]
}

async function retrieveKnowledge(question, records, now, timeZone) {
  const temporal = temporalQueryContext(question, now, timeZone)
  const retrievalQuery = temporal ? `${question}\nRelevant time range: ${temporal.searchText}` : question
  let queryEmbedding = null
  try {
    queryEmbedding = await embedQuery(retrievalQuery, embeddingDimension(records))
  } catch {
    // OKF metadata and keyword retrieval remain available without embeddings.
  }

  const chunksById = new Map()
  for (const record of records) {
    const chunks = (record.chunks?.length ? record.chunks : noteChunks(record.content)).map((chunk) => {
      const content = typeof chunk === 'string' ? chunk : chunk.content
      const embedding = typeof chunk === 'string' ? null : chunk.embedding
      return {
        content,
        score: queryEmbedding && embedding
          ? cosineSimilarity(queryEmbedding, embedding)
          : textMatchScore(content, searchTerms(question)),
      }
    }).sort((left, right) => right.score - left.score)
    chunksById.set(record.id, chunks)
  }

  const rankedConcepts = records
    .map((record) => {
      const lexical = lexicalScores(record, question)
      const semantic = queryEmbedding
        ? Math.max(cosineSimilarity(queryEmbedding, record.embedding), chunksById.get(record.id)?.[0]?.score || 0)
        : 0
      const time = temporalScore(record, temporal)
      return {
        ...record,
        lexicalMetadata: lexical.metadata,
        lexicalContent: lexical.content,
        semantic,
        time,
        candidateScore: semantic * 0.5 + lexical.metadata * 0.2 + lexical.content * 0.2 + time * 0.1,
      }
    })
    .sort((left, right) => right.candidateScore - left.candidateScore)

  const candidates = rankedConcepts.slice(0, 24)
  const candidateIds = new Set(candidates.map((record) => record.id))
  for (const candidate of [...candidates]) {
    const linkedIds = new Set([
      ...(candidate.relatedIds || []),
      ...records.filter((record) => record.relatedIds?.includes(candidate.id)).map((record) => record.id),
    ])
    for (const id of linkedIds) {
      if (candidates.length >= 24) break
      if (candidateIds.has(id)) continue
      const linked = rankedConcepts.find((record) => record.id === id)
      if (linked) {
        candidates.push({ ...linked, linked: true })
        candidateIds.add(id)
      }
    }
  }

  const reranked = candidates
    .map((record) => {
      const excerpts = (chunksById.get(record.id) || []).sort((left, right) => right.score - left.score)
      const excerptScore = excerpts[0]?.score || 0
      return {
        ...record,
        score: (excerptScore * 0.45
          + record.semantic * 0.25
          + record.lexicalContent * 0.15
          + record.lexicalMetadata * 0.1
          + record.time * 0.05
          + (record.linked ? 0.03 : 0)) * lifecycleFactor(record, now),
        excerpts: excerpts.slice(0, 2).map((excerpt) => excerpt.content),
      }
    })
    .sort((left, right) => right.score - left.score)

  const bestScore = reranked[0]?.score || 0
  const threshold = Math.max(0.3, bestScore * 0.72)
  let matches = reranked.filter((record) => record.score >= threshold || record.time >= 0.85).slice(0, 8)
  if (!matches.length && bestScore >= 0.25) matches = reranked.slice(0, 1)

  const hasIndexedEmbeddings = records.some((record) => record.embedding || record.chunks?.some((chunk) => chunk.embedding))
  return { matches, usedEmbeddings: Boolean(queryEmbedding && hasIndexedEmbeddings), temporal }
}

function validTimeZone(value) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value }).format()
    return value
  } catch {
    return Intl.DateTimeFormat().resolvedOptions().timeZone
  }
}

function buildKnowledgeContext(matches, maxLength) {
  const sources = []
  let remaining = maxLength

  for (const note of matches) {
    const source = {
      citation: `[${markdownText(note.title)}](${note.id})`,
      path: note.id,
      capturedAt: note.createdAt,
      evidence: note.excerpts.join('\n\n[... nearby omitted ...]\n\n'),
      routingHints: {
        title: note.title,
        type: note.type,
        tags: note.tags,
      },
    }
    let serialized = JSON.stringify(source, null, 2)
    if (serialized.length > remaining) {
      const fixedLength = serialized.length - source.evidence.length
      const availableEvidence = remaining - fixedLength - 20
      if (availableEvidence < 200) break
      source.evidence = `${source.evidence.slice(0, availableEvidence)}\n[truncated]`
      serialized = JSON.stringify(source, null, 2)
    }
    sources.push(source)
    remaining -= serialized.length
  }

  return JSON.stringify(sources, null, 2)
}


  return { searchTerms, textMatchScore, lexicalScores, lexicalScore, searchResultSnippet, publicSearchRecord,
    updateSemanticSuggestions, rankedRecords, dateKeyInTimeZone, addDateKeyDays, startOfWeekDateKey,
    monthStartDateKey, temporalQueryContext, temporalScore, splitByUtf8Bytes, noteChunks, retrieveKnowledge,
    validTimeZone, buildKnowledgeContext }
}
