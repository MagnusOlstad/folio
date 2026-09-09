import crypto from 'node:crypto'
import path from 'node:path'
import YAML from 'yaml'

export function createMarkdownDocuments(runtime) {
  const { classifierModel, normalizeInlineText, normalizeTag, normalizeMoveDirectory } = runtime
function parseMarkdownFile(markdown, filename) {
  const normalized = markdown.replace(/\r\n/g, '\n')
  let frontmatter = {}
  let content = normalized

  if (normalized.startsWith('---\n')) {
    const frontmatterEnd = normalized.indexOf('\n---\n', 4)
    if (frontmatterEnd !== -1) {
      const parsed = YAML.parse(normalized.slice(4, frontmatterEnd))
      frontmatter = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
      content = normalized.slice(frontmatterEnd + 5).trimStart()
    }
  }

  const heading = content.match(/^#\s+(.+)$/m)?.[1]
  const generated = frontmatter.generated && typeof frontmatter.generated === 'object' && !Array.isArray(frontmatter.generated)
    ? frontmatter.generated
    : null
  const filing = frontmatter.filing && typeof frontmatter.filing === 'object' && !Array.isArray(frontmatter.filing)
    ? frontmatter.filing
    : null
  const generatedDate = generated?.at ? new Date(generated.at) : null
  const generatedAt = generatedDate && !Number.isNaN(generatedDate.getTime()) ? generatedDate.toISOString() : null
  const filedDate = filing?.at ? new Date(filing.at) : null
  const filedAt = filedDate && !Number.isNaN(filedDate.getTime()) ? filedDate.toISOString() : null
  const tags = Array.isArray(frontmatter.tags) ? frontmatter.tags.map(normalizeInlineText) : []
  const sources = Array.isArray(frontmatter.sources) ? frontmatter.sources : []

  return {
    frontmatter,
    type: normalizeInlineText(frontmatter.type || 'OKF file'),
    title: normalizeInlineText(frontmatter.title || heading || path.basename(filename, '.md')),
    description: normalizeInlineText(frontmatter.description || ''),
    tags,
    status: ['draft', 'stable', 'deprecated'].includes(frontmatter.status) ? frontmatter.status : 'stable',
    staleAfter: frontmatter.stale_after ? String(frontmatter.stale_after) : null,
    sources,
    generatedAt,
    filedBy: normalizeInlineText(filing?.by || '') || null,
    filedAt,
    content,
  }
}

function markdownDocument(frontmatter, content) {
  return `---\n${YAML.stringify(frontmatter, { lineWidth: 0 }).trimEnd()}\n---\n\n${content.trim()}\n`
}

function updatedGenerated(frontmatter, by, at) {
  const generated = frontmatter.generated && typeof frontmatter.generated === 'object' && !Array.isArray(frontmatter.generated)
    ? frontmatter.generated
    : {}
  return { ...generated, by, at }
}

function captureMarker(captureId, edge) {
  return `<!-- folio:capture:${captureId}:${edge} -->`
}

function captureContribution(captureId, content) {
  return `${captureMarker(captureId, 'start')}\n${content.trim()}\n${captureMarker(captureId, 'end')}`
}

function captureMetadata(
  previousTags,
  previousGenerated,
  appliedTags,
  appliedGenerated,
  captureTags,
  createdAggregate = false,
) {
  return {
    previous_tags: previousTags,
    previous_generated: previousGenerated || null,
    applied_tags: appliedTags,
    applied_generated: appliedGenerated || null,
    capture_tags: captureTags,
    ...(createdAggregate ? { created_aggregate: true } : {}),
  }
}

function restoreCaptureMetadata(frontmatter, source, allSources) {
  const metadata = source?.capture_metadata
  if (!metadata) return
  const captures = (Array.isArray(allSources) ? allSources : [])
    .filter((item) => item?.capture_metadata)
  const remaining = captures.filter((item) => item !== source)
  const firstMetadata = captures[0]?.capture_metadata
  if (!firstMetadata) return
  const currentTags = Array.isArray(frontmatter.tags) ? frontmatter.tags.map(normalizeTag).filter(Boolean) : []
  const baseTags = Array.isArray(firstMetadata.previous_tags) ? firstMetadata.previous_tags : []
  const captureTags = (item) => Array.isArray(item.capture_metadata.capture_tags)
    ? item.capture_metadata.capture_tags
    : []
  const knownTags = new Set([...baseTags, ...captures.flatMap(captureTags)])
  const humanTags = currentTags.filter((tag) => !knownTags.has(tag))
  frontmatter.tags = Array.from(new Set([...baseTags, ...remaining.flatMap(captureTags), ...humanTags]))

  const currentGenerated = frontmatter.generated || null
  const knownGenerated = captures.map((item) => item.capture_metadata.applied_generated || null)
  if (knownGenerated.some((generated) => JSON.stringify(generated) === JSON.stringify(currentGenerated))) {
    const latest = remaining.at(-1)?.capture_metadata
    const restored = latest ? latest.applied_generated : firstMetadata.previous_generated
    if (restored) frontmatter.generated = restored
    else delete frontmatter.generated
  }

  const createdAggregate = captures.some((item) => item.capture_metadata.created_aggregate)
  let previousTags = Array.from(new Set([...baseTags, ...humanTags]))
  let previousGenerated = firstMetadata.previous_generated || null
  for (const [index, item] of remaining.entries()) {
    const entry = item.capture_metadata
    const appliedTags = Array.from(new Set([...previousTags, ...captureTags(item)]))
    entry.previous_tags = previousTags
    entry.previous_generated = previousGenerated
    entry.applied_tags = appliedTags
    if (createdAggregate && index === 0) entry.created_aggregate = true
    else delete entry.created_aggregate
    previousTags = appliedTags
    previousGenerated = entry.applied_generated || null
  }
}

function filingActor(classifiedByModel) {
  return classifiedByModel ? `okf-notetaker/${classifierModel}` : 'process:folio-fallback'
}

function confirmationIdFor(rawId) {
  return `confirmation:${crypto.createHash('sha256').update(rawId).digest('hex').slice(0, 24)}`
}

function normalizeConfirmationFields(value, fallback, internalFilename = fallback.filename) {
  const requestedDirectory = value?.directory ?? fallback.directory
  const directory = normalizeMoveDirectory(requestedDirectory)
    || (requestedDirectory === fallback.directory && requestedDirectory === '/daily' ? '/daily' : null)
  const filename = String(internalFilename || '').trim()
  const title = normalizeInlineText(value?.title ?? fallback.title).slice(0, 100)
  const description = normalizeInlineText(value?.description ?? fallback.description).slice(0, 240)
  const tags = Array.from(new Set((Array.isArray(value?.tags) ? value.tags : fallback.tags)
    .map(normalizeTag).filter(Boolean))).slice(0, 12)
  if (!directory || path.posix.basename(filename) !== filename || path.posix.extname(filename) !== '.md' || !title) return null
  return { directory, filename, title, description, tags }
}

function destinationFor(id) {
  return { id, directory: path.posix.dirname(id), filename: path.posix.basename(id) }
}


  return { parseMarkdownFile, markdownDocument, updatedGenerated, captureMarker, captureContribution,
    captureMetadata, restoreCaptureMetadata, filingActor, confirmationIdFor, normalizeConfirmationFields,
    destinationFor }
}

