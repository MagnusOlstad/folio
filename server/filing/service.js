import fs from 'node:fs/promises'
import path from 'node:path'
import { aggregateEntryContent } from './aggregate-formatting.js'

export function createFilingService(runtime) {
  const { bundleRoot, generatedRelatedStart, generatedRelatedEnd, normalizeInlineText, normalizeTag,
    slugify, parseMarkdownFile, markdownDocument, markdownLinkTarget, markdownText,
    captureMarker, captureContribution,
    captureMetadata, updatedGenerated, filingActor, stripGeneratedRelatedSection, indexedConceptContent,
    searchTerms, reuseExistingClassificationPath,
    isMovableConceptId, bundleFileId, dateKeyInTimeZone, cosineSimilarity, lexicalScore, assertNoBundleSymlinks } = runtime
function openingSpecialKind(content) {
  const firstLine = content.split('\n').find((line) => line.trim())?.trim() || ''
  const normalized = firstLine.replace(/^#{1,6}\s*/, '').toLowerCase()
  if (/^(?:todo|to-do|todos|task|tasks|oppgave|oppgaver|gj[øo]rem[aå]l)(?:\s*[:=-]\s*|\s+|$)/.test(normalized)) return 'todo'
  if (/^(?:daily note|daily|today log|today|daglig|dagsnotat)(?:\s*[:=-]\s*|\s+|$)/.test(normalized)) return 'daily'
  return null
}

function normalizedMorphology(value) {
  const word = String(value).toLocaleLowerCase()
    .normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
  const suffixes = ['ingly', 'edly', 'ing', 'ed', 'ies', 'es', 's']
  for (const suffix of suffixes) {
    if (word.endsWith(suffix) && word.length > suffix.length + 2) {
      const stem = suffix === 'ies' ? `${word.slice(0, -3)}y` : word.slice(0, -suffix.length)
      return stem.length > 2 && stem.at(-1) === stem.at(-2) ? stem.slice(0, -1) : stem
    }
  }
  return word
}

function canonicalizeExistingTags(tags, records) {
  const existing = new Map()
  for (const record of records) {
    if (record.id === '/todo-list.md' || record.id.startsWith('/daily/') || record.id.startsWith('/references/')) continue
    for (const value of record.tags || []) {
      const tag = normalizeTag(value)
      if (!tag) continue
      const key = tag.split('-').map(normalizedMorphology).sort().join('-')
      const entry = existing.get(key) || new Map()
      entry.set(tag, (entry.get(tag) || 0) + 1)
      existing.set(key, entry)
    }
  }
  return tags.map((tag) => {
    const key = tag.split('-').map(normalizedMorphology).sort().join('-')
    const spellings = existing.get(key)
    if (!spellings) return tag
    return [...spellings.entries()].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))[0][0]
  })
}

function continuationTarget(content, proposedPath, records) {
  if (!/\b(?:update|updated|follow[ -]?up|addendum|addition|additional|extension|correction|corrected|revision|revised|new development|oppdatering|oppdatert|tillegg|rettelse|revidert)\b/i.test(content)) return null
  const directory = proposedPath.join('/')
  const primaryText = String(content).replace(/```[\s\S]*?```/g, ' ').replace(/`[^`]*`/g, ' ')
    .split(/\r?\n/).filter((line) => !/^\s*>/.test(line)).join('\n')
    .replace(/"[^"\n]*"|“[^”\n]*”|‘[^’\n]*’/g, ' ')
  const searchableText = ` ${primaryText.toLocaleLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim()} `
  const matches = records.flatMap((record) => {
    if (record.id === '/todo-list.md' || record.id.startsWith('/daily/') || record.id.startsWith('/references/')) return []
    const recordDirectory = path.posix.dirname(record.id).replace(/^\/+/, '')
    if (!directory || recordDirectory !== directory) return []
    const titleWords = searchTerms(record.title || '')
    if (titleWords.length < 2) return []
    const titlePhrase = record.title.toLocaleLowerCase().normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
    const phrase = ` ${titlePhrase} `
    const titleOffset = searchableText.indexOf(phrase)
    if (titleOffset < 0) return []
    const opening = primaryText.split('\n').filter((line) => line.trim()).slice(0, 2).join(' ')
      .toLocaleLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^\p{L}\p{N}]+/gu, ' ')
    if (!` ${opening} `.includes(phrase)) return []
    const before = searchableText.slice(Math.max(0, titleOffset - 90), titleOffset)
    const after = searchableText.slice(titleOffset + phrase.length, titleOffset + phrase.length + 120)
    if (/(?:\bno\s+(?:relation|connection|link)|\bnot\s+(?:about|related|connected)|\bunrelated\s+to|\bwithout\s+relation|\bexcept\s+for)\s*$/i.test(before)
      || /\b(?:unrelated\s+to|not\s+(?:related|connected)|no\s+(?:relation|connection|link))\b/i.test(after)
      || !/\b(?:update|updated|follow[ -]?up|addendum|addition|additional|extension|correction|corrected|revision|revised|new development|oppdatering|oppdatert|tillegg|rettelse|revidert)\b/i.test(after)) return []
    return [{ record, specificity: titleWords.length }]
  }).sort((left, right) => right.specificity - left.specificity || left.record.id.localeCompare(right.record.id))
  if (!matches.length || (matches[1] && matches[0].specificity === matches[1].specificity)) return null
  return matches[0].record
}

function normalizeClassification(result, content, records, allowReconciliation = false, steering = '') {
  const firstLine = content.split('\n').find((line) => line.trim())?.replace(/^#+\s*/, '').replace(/:$/, '') || 'Untitled note'
  const candidate = result?.concept || (Array.isArray(result?.concepts) ? result.concepts[0] : result) || {}
  const title = normalizeInlineText(candidate.title || firstLine).slice(0, 100)
  const description = normalizeInlineText(candidate.description || firstLine).slice(0, 240)

  const type = normalizeInlineText(candidate.type || 'Note').slice(0, 80) || 'Note'
  const candidatePath = Array.isArray(candidate.path) ? candidate.path : String(candidate.path || '').split('/')
  const proposedPath = candidatePath
    .map((part) => slugify(String(part), ''))
    .filter(Boolean)
    .slice(0, 5)
  const conceptPath = reuseExistingClassificationPath(proposedPath, records)
  const proposedKind = ['note', 'todo', 'daily'].includes(candidate.kind) ? candidate.kind : 'note'

  const proposedTags = Array.from(new Set((Array.isArray(candidate.tags) ? candidate.tags : [])
    .map(normalizeTag)
    .filter(Boolean)))
  const reconciledTags = canonicalizeExistingTags(proposedTags, records)
  const continuation = allowReconciliation ? continuationTarget(content, conceptPath, records) : null

  return {
    title: continuation?.title || title,
    type: continuation?.type || type,
    description,
    tags: Array.from(new Set(reconciledTags)).slice(0, 6),
    kind: openingSpecialKind(steering) || openingSpecialKind(content) || proposedKind,
    path: continuation
      ? path.posix.dirname(continuation.id).replace(/^\/+/, '').split('/').filter(Boolean)
      : conceptPath.length ? conceptPath : [slugify(type, 'notes'), slugify(title)],
    relatedIds: [],
    relationships: [],
    generationModel: result?.model || null,
  }
}

function rawDocument(title, content, createdAt) {
  return markdownDocument({
    type: 'Raw Capture',
    title,
    status: 'draft',
    generated: { by: 'human:local', at: createdAt },
  }, content)
}

function mentionedRecordIds(content, records) {
  const prose = String(content)
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`]*`/g, ' ')
    .replace(/!?\[[^\]]*\]\([^)]*\)/g, ' ')
  const haystack = ` ${searchTerms(prose).join(' ')} `
  return records
    .filter((record) => {
      const title = searchTerms(record.title).join(' ')
      return title.length >= 4 && haystack.includes(` ${title} `)
    })
    .map((record) => record.id)
}

function creationRelationships(content, records, noteEmbedding = null) {
  const candidates = records.filter((record) => (
    record.id !== '/todo-list.md'
    && !record.id.startsWith('/daily/')
    && !record.id.startsWith('/references/')
  ))
  const mentionedIds = new Set(mentionedRecordIds(content, candidates))
  const ranked = candidates.map((record) => {
    const chunkSimilarity = noteEmbedding
      ? Math.max(0, ...(record.chunks || []).map((chunk) => cosineSimilarity(noteEmbedding, chunk.embedding)))
      : 0
    return {
      record,
      semantic: Math.max(noteEmbedding ? cosineSimilarity(noteEmbedding, record.embedding) : 0, chunkSimilarity),
      lexical: lexicalScore(record, content),
    }
  })
  const semanticOrder = [...ranked].sort((left, right) => right.semantic - left.semantic || left.record.id.localeCompare(right.record.id))
  const bestSemantic = semanticOrder[0]
  const nextSemantic = semanticOrder[1]?.semantic || 0
  // The native Atlas evaluation scored .694 against a .540 nearest unrelated note.
  const semanticMatchIds = new Set(ranked.filter(({ semantic }) => semantic >= 0.75).map(({ record }) => record.id))
  if (bestSemantic?.semantic >= 0.6 && bestSemantic.semantic - nextSemantic >= 0.08) semanticMatchIds.add(bestSemantic.record.id)
  const eligible = ranked
    .filter(({ record, lexical }) => mentionedIds.has(record.id) || lexical >= 0.45 || semanticMatchIds.has(record.id))
    .sort((left, right) => (
      Number(mentionedIds.has(right.record.id)) - Number(mentionedIds.has(left.record.id))
      || right.semantic - left.semantic
      || right.lexical - left.lexical
      || left.record.id.localeCompare(right.record.id)
    ))
    .slice(0, 3)

  return eligible.map(({ record }) => ({
    id: record.id,
    relation: mentionedIds.has(record.id) ? 'Mentions' : 'Related',
  }))
}

function generatedRelatedSection(relationships, recordsById) {
  if (!relationships.length) return ''
  const lines = [generatedRelatedStart, '# Related', '']
  for (const relationship of relationships) {
    const related = recordsById.get(relationship.id)
    if (!related) continue
    lines.push(`- [${markdownText(related.title)}](${markdownLinkTarget(relationship.id)}) - ${markdownText(relationship.relation)}`)
  }
  lines.push(generatedRelatedEnd)
  return lines.length > 4 ? lines.join('\n') : ''
}

function generatedRelatedIds(content) {
  const section = String(content).match(
    /<!-- folio:generated-related:start -->[\s\S]*?<!-- folio:generated-related:end -->/i,
  )?.[0]
  if (!section) return []
  return section.split('\n').flatMap((line) => {
    if (!/ - Related\s*$/.test(line)) return []
    const id = line.match(/\]\((\/[^)]+)\)\s+- Related\s*$/)?.[1]
    if (!id) return []
    try {
      return [decodeURI(id)]
    } catch {
      return [id]
    }
  })
}

async function recalculateGeneratedRelationships(records, documents) {
  const recordsById = new Map(records.map((record) => [record.id, record]))
  for (const document of documents) {
    let markdown
    let parsed
    try {
      await assertNoBundleSymlinks(document.filePath)
      markdown = await fs.readFile(document.filePath, 'utf8')
      parsed = parseMarkdownFile(markdown, document.filePath)
    } catch (error) {
      if (error.code === 'ENOENT') continue
      throw error
    }
    const hadGeneratedSection = parsed.content.includes(generatedRelatedStart)
    const generatedDocument = /^# (?:Captured note|Summary)\s*\n/i.test(parsed.content)
      || hadGeneratedSection
    if (!generatedDocument || parsed.type === 'Raw Capture') continue

    const content = stripGeneratedRelatedSection(parsed.content).trim()
    const indexedContent = indexedConceptContent(content)
    const confirmedIds = Array.isArray(parsed.frontmatter.folio_related)
      ? parsed.frontmatter.folio_related.map(String)
      : []
    const validConfirmedIds = confirmedIds.filter((id) => id !== document.id && recordsById.has(id))
    const frontmatterChanged = validConfirmedIds.length !== confirmedIds.length
    if (validConfirmedIds.length) parsed.frontmatter.folio_related = validConfirmedIds
    else delete parsed.frontmatter.folio_related
    const relationships = new Map()
    for (const id of validConfirmedIds) relationships.set(id, { id, relation: 'Confirmed related' })
    for (const id of generatedRelatedIds(parsed.content)) {
      if (id !== document.id && recordsById.has(id) && !relationships.has(id)) relationships.set(id, { id, relation: 'Related' })
    }
    for (const id of mentionedRecordIds(indexedContent, records.filter((record) => record.id !== document.id))) {
      if (!relationships.has(id)) relationships.set(id, { id, relation: 'Mentions' })
    }

    const generated = generatedRelatedSection(Array.from(relationships.values()), recordsById)
    if (!hadGeneratedSection && !generated && !frontmatterChanged) continue
    const nextContent = generated ? `${content}\n\n${generated}` : content
    const nextMarkdown = markdownDocument(parsed.frontmatter, nextContent)
    if (nextMarkdown !== markdown) {
      await assertNoBundleSymlinks(document.filePath)
      await fs.writeFile(document.filePath, nextMarkdown)
    }
  }
}

function conceptDocument(classification, rawId, createdAt, relatedConcepts, content, classifiedByModel, captureId, sourceContent = content) {
  const related = classification.relationships
    .map((relationship) => ({ ...relationship, concept: relatedConcepts.get(relationship.id) }))
    .filter((relationship) => relationship.concept)
  const lines = ['# Captured note', '', captureContribution(captureId, content)]

  const generated = generatedRelatedSection(related, relatedConcepts)
  if (generated) lines.push('', generated)
  return markdownDocument({
    type: classification.type,
    title: classification.title,
    description: classification.description,
    tags: classification.tags,
    status: 'draft',
    generated: { by: filingActor(classifiedByModel, classification.generationModel), at: createdAt },
    filing: { by: filingActor(classifiedByModel, classification.generationModel), at: createdAt },
    sources: [{
      id: 'raw-capture',
      resource: rawId,
      title: 'Raw inbox capture',
      author: 'human:local',
      capture_id: captureId,
      filing_by: filingActor(classifiedByModel, classification.generationModel),
      capture_content: sourceContent,
    }],
  }, lines.join('\n'))
}

async function findExactConceptFile(directory, title) {
  let entries
  try {
    entries = await fs.readdir(directory, { withFileTypes: true })
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }

  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isFile() || path.extname(entry.name) !== '.md') continue
    const filePath = path.join(directory, entry.name)
    if (!isMovableConceptId(bundleFileId(filePath))) continue
    try {
      const parsed = parseMarkdownFile(await fs.readFile(filePath, 'utf8'), filePath)
      if (parsed.type !== 'Raw Capture' && parsed.title === title) return filePath
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
  }
  return null
}

async function availableConceptFilename(
  directory,
  title,
  dateKey = null,
  reservedFilenames = new Set(),
) {
  const slug = slugify(title)
  for (let collision = 1; ; collision += 1) {
    const filename = `${slug}${collision === 1 ? '' : `-${collision}`}${dateKey ? `-${dateKey}` : ''}.md`
    if (reservedFilenames.has(filename)) continue
    try {
      await fs.access(path.join(directory, filename))
    } catch (error) {
      if (error.code === 'ENOENT') return filename
      throw error
    }
  }
}

async function appendConceptDocument({ filePath, classification, rawId, content, sourceContent = content, createdAt, captureId, filingBy }) {
  const parsed = parseMarkdownFile(await fs.readFile(filePath, 'utf8'), filePath)
  const existingContent = stripGeneratedRelatedSection(parsed.content).trim()
  const nextCapture = content
  const combinedContent = parsed.content.includes(captureMarker(captureId, 'start'))
    ? existingContent
    : `${existingContent}\n\n---\n\n${captureContribution(captureId, nextCapture)}`.trim()
  const sources = Array.isArray(parsed.frontmatter.sources) ? [...parsed.frontmatter.sources] : []
  sources.push({
    id: `raw-capture-${sources.length + 1}`,
    resource: rawId,
    title: 'Raw inbox capture',
    author: 'human:local',
    capture_id: captureId,
    filing_by: filingBy,
    capture_content: sourceContent,
  })
  const tags = Array.from(new Set([
    ...parsed.tags.map(normalizeTag),
    ...classification.tags,
  ].filter(Boolean)))
  const generated = updatedGenerated(parsed.frontmatter, filingBy, createdAt)
  sources[sources.length - 1].capture_metadata = captureMetadata(
    parsed.tags,
    parsed.frontmatter.generated,
    tags,
    generated,
    classification.tags,
  )
  await fs.writeFile(filePath, markdownDocument({
    ...parsed.frontmatter,
    tags,
    sources,
    generated,
  }, combinedContent))
}

function localTimeLabel(value, timeZone, includeDate = false) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    ...(includeDate ? { year: 'numeric', month: '2-digit', day: '2-digit' } : {}),
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(value).replace(',', '')
}

async function appendAggregateDocument({ filePath, id, kind, rawId, content, sourceContent = content, createdAt, timeZone, classifiedByModel, generationModel, captureId }) {
  let parsed = null
  try {
    parsed = parseMarkdownFile(await fs.readFile(filePath, 'utf8'), filePath)
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }

  const isDaily = kind === 'daily'
  const dateKey = dateKeyInTimeZone(new Date(createdAt), timeZone)
  const title = isDaily ? `Daily ${dateKey}` : 'Todo List'
  const type = isDaily ? 'Daily Note' : 'Todo List'
  const description = isDaily ? `Daily notes captured on ${dateKey}.` : 'Master list of captured todos.'
  const sectionTitle = localTimeLabel(new Date(createdAt), timeZone, !isDaily)
  const existingContent = parsed?.content.trim() || `# ${title}`
  const aggregateContent = `${existingContent}\n\n${captureMarker(captureId, 'start')}\n## ${sectionTitle}\n\n${aggregateEntryContent(content, kind)}\n${captureMarker(captureId, 'end')}`
  const sources = Array.isArray(parsed?.frontmatter.sources) ? [...parsed.frontmatter.sources] : []
  sources.push({
    id: `raw-capture-${sources.length + 1}`,
    resource: rawId,
    title: 'Raw inbox capture',
    author: 'human:local',
    capture_id: captureId,
    filing_by: filingActor(classifiedByModel, generationModel),
    capture_content: sourceContent,
  })

  const frontmatter = {
    ...(parsed?.frontmatter || {}),
    type,
    title,
    description,
    tags: isDaily ? ['daily'] : ['todo'],
    status: parsed?.frontmatter.status || 'draft',
    generated: parsed
      ? updatedGenerated(parsed.frontmatter, filingActor(classifiedByModel, generationModel), createdAt)
      : { by: filingActor(classifiedByModel, generationModel), at: createdAt },
    ...(parsed ? {} : { filing: { by: filingActor(classifiedByModel, generationModel), at: createdAt } }),
    sources,
  }
  sources[sources.length - 1].capture_metadata = captureMetadata(
    parsed?.tags || [],
    parsed?.frontmatter.generated,
    frontmatter.tags,
    frontmatter.generated,
    frontmatter.tags,
    !parsed,
  )
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  await fs.writeFile(filePath, markdownDocument(frontmatter, aggregateContent))
  return { id, appended: Boolean(parsed) }
}

function bundleFileContents(records) {
  const grouped = new Map()
  for (const record of records) {
    if (!grouped.has(record.type)) grouped.set(record.type, [])
    grouped.get(record.type).push(record)
  }

  const indexLines = ['---', 'okf_version: "0.2"', '---', '', '# Personal knowledge', '']
  for (const [type, items] of [...grouped.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    indexLines.push(`## ${type}`, '')
    for (const item of items.sort((left, right) => right.createdAt.localeCompare(left.createdAt))) {
      indexLines.push(`- [${markdownText(item.title)}](${markdownLinkTarget(item.id.replace(/^\//, ''))}) - ${markdownText(item.description)}`)
    }
    indexLines.push('')
  }
  const byDate = new Map()
  for (const record of records) {
    const date = record.createdAt.slice(0, 10)
    if (!byDate.has(date)) byDate.set(date, [])
    byDate.get(date).push(record)
  }
  const logLines = ['# Bundle update log', '']
  for (const [date, items] of [...byDate.entries()].sort(([left], [right]) => right.localeCompare(left))) {
    logLines.push(`## ${date}`)
    for (const item of items) {
      logLines.push(`- **Creation**: Added [${markdownText(item.title)}](${markdownLinkTarget(item.id)}).`)
    }
    logLines.push('')
  }
  return new Map([
    [path.join(bundleRoot, 'index.md'), indexLines.join('\n')],
    [path.join(bundleRoot, 'log.md'), logLines.join('\n')],
  ])
}

async function rebuildBundleFiles(records) {
  for (const [filePath, content] of bundleFileContents(records)) {
    await assertNoBundleSymlinks(filePath, { allowMissing: true })
    await fs.writeFile(filePath, content)
  }
}

  return { openingSpecialKind, aggregateEntryContent, normalizeClassification, rawDocument, mentionedRecordIds, creationRelationships,
    generatedRelatedSection, recalculateGeneratedRelationships, conceptDocument, findExactConceptFile,
    availableConceptFilename, appendConceptDocument, localTimeLabel, appendAggregateDocument, bundleFileContents, rebuildBundleFiles }
}
