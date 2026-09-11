import fs from 'node:fs/promises'
import path from 'node:path'

export function createFilingService(runtime) {
  const { bundleRoot, generatedRelatedStart, generatedRelatedEnd, normalizeInlineText, normalizeTag,
    slugify, parseMarkdownFile, markdownDocument, markdownLinkTarget, markdownText,
    captureMarker, captureContribution,
    captureMetadata, updatedGenerated, filingActor, stripGeneratedRelatedSection, indexedConceptContent,
    searchTerms, reuseExistingClassificationPath,
    isMovableConceptId, bundleFileId, dateKeyInTimeZone, cosineSimilarity, lexicalScore } = runtime
function openingSpecialKind(content) {
  const firstLine = content.split('\n').find((line) => line.trim())?.trim() || ''
  const normalized = firstLine.replace(/^#{1,6}\s*/, '').toLowerCase()
  if (/^(?:todo|to-do|todos|task|tasks|oppgave|oppgaver|gj[øo]rem[aå]l)(?:\s*[:=-]\s*|\s+|$)/.test(normalized)) return 'todo'
  if (/^(?:daily note|daily|today log|daglig|dagsnotat)(?:\s*[:=-]\s*|\s+|$)/.test(normalized)) return 'daily'
  return null
}

function aggregateEntryContent(content, kind) {
  const lines = content.split('\n')
  const firstContentLine = lines.findIndex((line) => line.trim())
  if (firstContentLine !== -1) {
    const guide = kind === 'todo'
      ? /^(?:todo|to-do|todos|task|tasks|oppgave|oppgaver|gj[øo]rem[aå]l)(?:\s*[:=-]\s*|\s+|$)/i
      : /^(?:daily note|daily|today log|daglig|dagsnotat)(?:\s*[:=-]\s*|\s+|$)/i
    const withoutHeading = lines[firstContentLine].replace(/^#{1,6}\s*/, '')
    if (guide.test(withoutHeading)) {
      const remainder = withoutHeading.replace(guide, '').trim()
      if (remainder) lines[firstContentLine] = remainder
      else lines.splice(firstContentLine, 1)
    }
  }

  const entry = lines.join('\n').trim() || content.trim()
  return kind === 'todo' ? `- [ ] ${entry.replace(/\n/g, '\n  ')}` : entry
}

function normalizeClassification(result, content, records) {
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

  return {
    title,
    type,
    description,
    tags: Array.from(new Set((Array.isArray(candidate.tags) ? candidate.tags : [])
      .map(normalizeTag)
      .filter(Boolean)))
      .slice(0, 6),
    kind: openingSpecialKind(content) || proposedKind,
    path: conceptPath.length ? conceptPath : [slugify(type, 'notes'), slugify(title)],
    relatedIds: [],
    relationships: [],
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
    && path.posix.dirname(record.id) !== '/'
  ))
  const mentionedIds = new Set(mentionedRecordIds(content, candidates))
  const ranked = candidates
    .map((record) => ({
      record,
      semantic: noteEmbedding ? cosineSimilarity(noteEmbedding, record.embedding) : 0,
      lexical: lexicalScore(record, content),
    }))
    .filter(({ record, semantic, lexical }) => mentionedIds.has(record.id) || semantic >= 0.75 || lexical >= 0.45)
    .sort((left, right) => (
      Number(mentionedIds.has(right.record.id)) - Number(mentionedIds.has(left.record.id))
      || right.semantic - left.semantic
      || right.lexical - left.lexical
      || left.record.id.localeCompare(right.record.id)
    ))
    .slice(0, 3)

  return ranked.map(({ record }) => ({
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
    if (nextMarkdown !== markdown) await fs.writeFile(document.filePath, nextMarkdown)
  }
}

function conceptDocument(classification, rawId, createdAt, relatedConcepts, content, classifiedByModel, captureId) {
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
    generated: { by: filingActor(classifiedByModel), at: createdAt },
    filing: { by: filingActor(classifiedByModel), at: createdAt },
    sources: [{
      id: 'raw-capture',
      resource: rawId,
      title: 'Raw inbox capture',
      author: 'human:local',
      capture_id: captureId,
      filing_by: filingActor(classifiedByModel),
      capture_content: content,
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

async function appendConceptDocument({ filePath, classification, rawId, content, createdAt, captureId, filingBy }) {
  const parsed = parseMarkdownFile(await fs.readFile(filePath, 'utf8'), filePath)
  const existingContent = stripGeneratedRelatedSection(parsed.content).trim()
  const nextCapture = content.trim()
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
    capture_content: content,
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

async function appendAggregateDocument({ filePath, id, kind, rawId, content, createdAt, timeZone, classifiedByModel, captureId }) {
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
    filing_by: filingActor(classifiedByModel),
    capture_content: content,
  })

  const frontmatter = {
    ...(parsed?.frontmatter || {}),
    type,
    title,
    description,
    tags: isDaily ? ['daily'] : ['todo'],
    status: parsed?.frontmatter.status || 'draft',
    generated: parsed
      ? updatedGenerated(parsed.frontmatter, filingActor(classifiedByModel), createdAt)
      : { by: filingActor(classifiedByModel), at: createdAt },
    ...(parsed ? {} : { filing: { by: filingActor(classifiedByModel), at: createdAt } }),
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

async function rebuildBundleFiles(records) {
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
  await fs.writeFile(path.join(bundleRoot, 'index.md'), indexLines.join('\n'))

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
  await fs.writeFile(path.join(bundleRoot, 'log.md'), logLines.join('\n'))
}

  return { openingSpecialKind, aggregateEntryContent, normalizeClassification, rawDocument, mentionedRecordIds, creationRelationships,
    generatedRelatedSection, recalculateGeneratedRelationships, conceptDocument, findExactConceptFile,
    availableConceptFilename, appendConceptDocument, localTimeLabel, appendAggregateDocument, rebuildBundleFiles }
}
