import fs from 'node:fs/promises'
import path from 'node:path'
import YAML from 'yaml'

export function createMarkdownMoves(runtime) {
  const { bundleRoot, markdownLinkTarget, resolveBundleMarkdownPath, normalizeMoveDirectory, parseMarkdownFile,
    readOptionalFile, bundleFileId, readRecords, writeRecords } = runtime
  const readBundleDocuments = (...args) => runtime.readBundleDocuments(...args)
  const indexedConceptContent = (...args) => runtime.indexedConceptContent(...args)
  const embeddingInputHash = (...args) => runtime.embeddingInputHash(...args)
  const noteChunks = (...args) => runtime.noteChunks(...args)
  const chunkInputHash = (...args) => runtime.chunkInputHash(...args)
  const recordChunks = (...args) => runtime.recordChunks(...args)
function resolveMarkdownLink(currentId, target) {
  let cleanTarget = String(target || '').replace(/^<|>$/g, '').split(/[?#]/)[0]
  try {
    cleanTarget = decodeURIComponent(cleanTarget)
  } catch {
    return null
  }
  cleanTarget = cleanTarget.replace(/\\([\\()[\]<>])/g, '$1')
  if (!cleanTarget || /^[a-z][a-z\d+.-]*:/i.test(cleanTarget) || cleanTarget.startsWith('#')) return null
  if (!cleanTarget.endsWith('.md')) return null
  const resolved = cleanTarget.startsWith('/')
    ? path.posix.normalize(cleanTarget)
    : path.posix.resolve(path.posix.dirname(currentId), cleanTarget)
  return resolved.startsWith('/') && !resolved.startsWith('/../') ? resolved : null
}

function resolveBundleResource(currentId, target) {
  let cleanTarget = String(target || '').replace(/^<|>$/g, '').split(/[?#]/)[0]
  try {
    cleanTarget = decodeURIComponent(cleanTarget)
  } catch {
    return null
  }
  cleanTarget = cleanTarget.replace(/\\([\\()[\]<>])/g, '$1')
  if (!cleanTarget || /^[a-z][a-z\d+.-]*:/i.test(cleanTarget) || cleanTarget.startsWith('#')) return null
  const pathLike = cleanTarget.startsWith('/')
    || cleanTarget.startsWith('./')
    || cleanTarget.startsWith('../')
    || /\.[a-z\d]{1,12}$/i.test(cleanTarget)
  if (!pathLike) return null
  const resolved = cleanTarget.startsWith('/')
    ? path.posix.normalize(cleanTarget)
    : path.posix.resolve(path.posix.dirname(currentId), cleanTarget)
  return resolved.startsWith('/') && !resolved.startsWith('/../') ? resolved : null
}

function markdownRelationships(currentId, parsed) {
  const relationships = []
  let section = 'Link'
  for (const line of parsed.content.split('\n')) {
    const heading = line.match(/^#{1,6}\s+(.+)$/)?.[1]?.trim()
    if (heading) section = heading
    const linkPattern = /!?\[[^\]]*\]\(([^)\s]+)(?:\s+["'][^)]*)?\)/g
    for (const match of line.matchAll(linkPattern)) {
      const id = resolveMarkdownLink(currentId, match[1])
      if (!id) continue
      const trailingText = line.slice((match.index || 0) + match[0].length).replace(/^\s*[-:–]\s*/, '').trim()
      relationships.push({ id, relation: trailingText || section, origin: 'content' })
    }
  }

  for (const source of parsed.sources) {
    const id = resolveMarkdownLink(currentId, source?.resource)
    if (id) relationships.push({ id, relation: source.title ? `Source: ${source.title}` : 'Source', origin: 'frontmatter' })
  }

  for (const related of Array.isArray(parsed.frontmatter.folio_related) ? parsed.frontmatter.folio_related : []) {
    const id = resolveMarkdownLink(currentId, related)
    if (id) relationships.push({ id, relation: 'Confirmed related', origin: 'frontmatter' })
  }

  return Array.from(new Map(
    relationships.map((relationship) => [`${relationship.id}\u0000${relationship.relation}`, relationship]),
  ).values())
}

function rewrittenBundleTarget(value, currentId, oldId, newId, pathResolver = resolveMarkdownLink) {
  const target = String(value || '')
  const suffixIndex = target.search(/[?#]/)
  const suffix = suffixIndex === -1 ? '' : target.slice(suffixIndex)
  const resolved = pathResolver(currentId, suffixIndex === -1 ? target : target.slice(0, suffixIndex))
  if (!resolved || (currentId !== oldId && resolved !== oldId)) return target
  return `${markdownLinkTarget(resolved === oldId ? newId : resolved)}${suffix}`
}

function rewriteMarkdownLinkTargets(content, currentId, oldId, newId) {
  let fence = null
  return String(content).split('\n').map((line) => {
    const fenceMatch = line.match(/^\s*(?:>\s*)*(`{3,}|~{3,})/)
    if (fenceMatch) {
      const marker = fenceMatch[1]
      if (!fence) fence = { character: marker[0], length: marker.length }
      else if (marker[0] === fence.character && marker.length >= fence.length) fence = null
      return line
    }
    if (fence || /^\s*(?:>\s*)?(?: {4}|\t)/.test(line)) return line

    const codeSpans = []
    let rewrittenLine = line.replace(/(`+)(.*?)\1/g, (span) => {
      const token = `@@FOLIO_CODE_SPAN_${codeSpans.length}@@`
      codeSpans.push(span)
      return token
    })
    rewrittenLine = rewrittenLine.replace(
      /(!?\[[^\]]*\]\(\s*)([^()\s]+(?:\([^()\s]*\)[^()\s]*)+)(\s*(?:["'][^)]*["'])?\))/g,
      (match, opening, target, closing) => {
        const rewritten = rewrittenBundleTarget(target, currentId, oldId, newId)
        return rewritten === target ? match : `${opening}${rewritten}${closing}`
      },
    )
    rewrittenLine = rewrittenLine.replace(
      /(!?\[[^\]]*\]\(\s*)((?:\\.|[^\s\\)])+)(\s*(?:["'][^)]*["'])?\))/g,
      (match, opening, target, closing) => {
        const rewritten = rewrittenBundleTarget(target, currentId, oldId, newId)
        return rewritten === target ? match : `${opening}${rewritten}${closing}`
      },
    )
    rewrittenLine = rewrittenLine.replace(
      /(!?\[[^\]]*\]\(\s*)(?:<([^>]+)>|([^\s)]+))([^)]*\))/g,
      (match, opening, angleTarget, plainTarget, closing) => {
        const target = angleTarget || plainTarget
        const rewritten = rewrittenBundleTarget(target, currentId, oldId, newId)
        if (rewritten === target) return match
        return `${opening}${angleTarget ? `<${rewritten}>` : rewritten}${closing}`
      },
    )
    rewrittenLine = rewrittenLine.replace(
      /^(\s*\[[^\]]+\]:\s*)(?:<([^>]+)>|(\S+))(.*)$/,
      (match, opening, angleTarget, plainTarget, closing) => {
        const target = angleTarget || plainTarget
        const rewritten = rewrittenBundleTarget(target, currentId, oldId, newId)
        if (rewritten === target) return match
        return `${opening}${angleTarget ? `<${rewritten}>` : rewritten}${closing}`
      },
    )
    rewrittenLine = rewrittenLine.replace(/<([^>\s]+)>/g, (match, target) => {
      const rewritten = rewrittenBundleTarget(target, currentId, oldId, newId)
      return rewritten === target ? match : `<${rewritten}>`
    })
    return rewrittenLine.replace(/@@FOLIO_CODE_SPAN_(\d+)@@/g, (_match, index) => codeSpans[Number(index)])
  }).join('\n')
}

function rewriteFrontmatterYaml(yamlSource, currentId, oldId, newId, movedAt = null, updates = null) {
  const document = YAML.parseDocument(yamlSource, { keepSourceTokens: true })
  if (document.errors.length) throw document.errors[0]
  const frontmatter = document.toJS() || {}
  let changed = false
  const rewriteField = (fieldPath) => {
    const value = document.getIn(fieldPath)
    if (typeof value !== 'string') return
    const rewritten = rewrittenBundleTarget(value, currentId, oldId, newId, resolveBundleResource)
    if (rewritten !== value) {
      document.setIn(fieldPath, rewritten)
      changed = true
    }
  }

  rewriteField(['resource'])
  rewriteField(['computation'])
  rewriteField(['executor', 'resource'])
  rewriteField(['attester', 'resource'])
  if (Array.isArray(frontmatter.sources)) {
    for (let index = 0; index < frontmatter.sources.length; index += 1) rewriteField(['sources', index, 'resource'])
  }
  if (Array.isArray(frontmatter.folio_related)) {
    const related = frontmatter.folio_related.map((id) => String(id) === oldId ? newId : id)
    if (related.some((id, index) => id !== frontmatter.folio_related[index])) {
      document.set('folio_related', related)
      changed = true
    }
  }
  if (movedAt) {
    const previousPaths = filingPreviousPaths({ frontmatter })
    document.set('filing', {
      by: 'human:local',
      at: movedAt,
      previous_path: oldId,
      previous_paths: Array.from(new Set([...previousPaths, oldId])),
    })
    changed = true
  }
  if (updates) {
    for (const [key, value] of Object.entries(updates)) {
      document.set(key, value)
      changed = true
    }
  }
  return { yaml: document.toString({ lineWidth: 0 }).trimEnd(), changed }
}

function filingPreviousPaths(parsed) {
  const filing = parsed.frontmatter.filing
  if (!filing || typeof filing !== 'object' || Array.isArray(filing)) return []
  return Array.from(new Set([
    ...(Array.isArray(filing.previous_paths) ? filing.previous_paths.map(String) : []),
    ...(filing.previous_path ? [String(filing.previous_path)] : []),
  ]))
}

async function resolveCurrentConceptId(requestedId) {
  const requestedPath = resolveBundleMarkdownPath(requestedId)
  if (!requestedPath) return null
  try {
    await fs.access(requestedPath)
    return requestedId
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  const { documents } = await readBundleDocuments()
  return documents.find((document) => filingPreviousPaths(document.parsed).includes(requestedId))?.id || null
}

async function removeEmptyBundleDirectories(directory) {
  let current = directory
  while (current.startsWith(`${bundleRoot}${path.sep}`)) {
    const entries = await fs.readdir(current)
    if (entries.length) return
    await fs.rmdir(current)
    current = path.dirname(current)
  }
}

async function moveConceptMarkdown(oldId, directory, movedAt, options = {}) {
  const oldPath = resolveBundleMarkdownPath(oldId)
  const normalizedDirectory = normalizeMoveDirectory(directory)
  if (!oldPath || !normalizedDirectory) {
    const error = new Error('Choose a valid destination with one to five directory names.')
    error.status = 400
    throw error
  }
  const filename = path.posix.basename(oldId)
  const newId = normalizedDirectory === '/'
    ? `/${filename}`
    : `${normalizedDirectory}/${filename}`
  const newPath = resolveBundleMarkdownPath(newId)
  if (!newPath) {
    const error = new Error('Invalid destination path.')
    error.status = 400
    throw error
  }
  if (newId === oldId) return { newId, rollback: async () => {} }

  try {
    await fs.access(newPath)
    const error = new Error('That path already contains a conflicting note. Choose another path.')
    error.status = 409
    throw error
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }

  const { documents, errors } = await readBundleDocuments()
  if (errors.length) {
    const error = new Error('Fix invalid Markdown files before moving a concept.')
    error.status = 409
    throw error
  }
  const movedDocument = documents.find((document) => document.id === oldId)
  if (!movedDocument) {
    const error = new Error('Note not found.')
    error.status = 404
    throw error
  }

  const rewrites = documents.map((document) => {
    const parsed = parseMarkdownFile(document.markdown, document.filePath)
    if (parsed.type === 'Raw Capture') {
      return {
        originalPath: document.filePath,
        nextPath: document.filePath,
        originalMarkdown: document.markdown,
        nextMarkdown: document.markdown,
        changed: false,
      }
    }
    const normalized = document.markdown.replace(/\r\n/g, '\n')
    const frontmatterEnd = normalized.indexOf('\n---\n', 4)
    if (!normalized.startsWith('---\n') || frontmatterEnd === -1) {
      const nextContent = rewriteMarkdownLinkTargets(normalized, document.id, oldId, newId)
      if (document.id === oldId) {
        parsed.frontmatter.type ||= parsed.type
        parsed.frontmatter.filing = {
          by: 'human:local',
          at: movedAt,
          previous_path: oldId,
          previous_paths: [oldId],
        }
        Object.assign(parsed.frontmatter, options.frontmatter || {})
      }
      const changed = document.id === oldId || nextContent !== normalized
      return {
        originalPath: document.filePath,
        nextPath: document.id === oldId ? newPath : document.filePath,
        originalMarkdown: document.markdown,
        nextMarkdown: changed
          ? (document.id === oldId
              ? `---\n${YAML.stringify(parsed.frontmatter, { lineWidth: 0 }).trim()}\n---\n\n${nextContent}`
              : nextContent)
          : document.markdown,
        changed,
      }
    }
    const yamlSource = normalized.slice(4, frontmatterEnd)
    const body = normalized.slice(frontmatterEnd + 5)
    const rewrittenFrontmatter = rewriteFrontmatterYaml(
      yamlSource,
      document.id,
      oldId,
      newId,
      document.id === oldId ? movedAt : null,
      document.id === oldId ? options.frontmatter : null,
    )
    const nextBody = rewriteMarkdownLinkTargets(body, document.id, oldId, newId)
    const changed = rewrittenFrontmatter.changed || nextBody !== body
    return {
      originalPath: document.filePath,
      nextPath: document.id === oldId ? newPath : document.filePath,
      originalMarkdown: document.markdown,
      nextMarkdown: changed ? `---\n${rewrittenFrontmatter.yaml}\n---\n${nextBody}` : document.markdown,
      changed,
    }
  })

  let destinationLinked = false
  let sourceRemoved = false
  const rollback = async () => {
    if (destinationLinked) {
      const movedRewrite = rewrites.find((rewrite) => rewrite.originalPath === oldPath)
      await fs.mkdir(path.dirname(oldPath), { recursive: true })
      if (sourceRemoved) {
        try {
          await fs.link(newPath, oldPath)
        } catch (error) {
          if (error.code !== 'EEXIST') throw error
        }
      }
      const restoredSource = await readOptionalFile(oldPath)
      const restoredMarkdown = restoredSource?.toString('utf8')
      if (movedRewrite && restoredMarkdown !== movedRewrite.originalMarkdown && restoredMarkdown !== movedRewrite.nextMarkdown) {
        throw new Error(`Refusing to replace a concurrent file at ${oldId} while rolling back its move.`)
      }
      try {
        await fs.unlink(newPath)
      } catch (error) {
        if (error.code !== 'ENOENT') throw error
      }
    }
    for (const rewrite of rewrites) {
      if (!rewrite.changed) continue
      const rollbackPath = rewrite.originalPath === oldPath ? oldPath : rewrite.nextPath
      const current = await readOptionalFile(rollbackPath)
      const currentMarkdown = current?.toString('utf8')
      if (currentMarkdown === rewrite.originalMarkdown) continue
      if (currentMarkdown !== rewrite.nextMarkdown) {
        throw new Error(`Refusing to overwrite a concurrent edit while rolling back ${bundleFileId(rewrite.originalPath)}.`)
      }
      await fs.mkdir(path.dirname(rewrite.originalPath), { recursive: true })
      await fs.writeFile(rewrite.originalPath, rewrite.originalMarkdown)
    }
  }

  try {
    await fs.mkdir(path.dirname(newPath), { recursive: true })
    try {
      await fs.link(oldPath, newPath)
      destinationLinked = true
    } catch (error) {
      if (error.code === 'EEXIST') {
        const conflict = new Error('That path already contains a conflicting note. Choose another path.')
        conflict.status = 409
        throw conflict
      }
      throw error
    }
    await fs.unlink(oldPath)
    sourceRemoved = true
    for (const rewrite of rewrites) {
      if (!rewrite.changed) continue
      const current = await fs.readFile(rewrite.nextPath, 'utf8')
      if (current !== rewrite.originalMarkdown) {
        throw new Error(`The file changed while moving ${rewrite.originalPath}.`)
      }
      await fs.writeFile(rewrite.nextPath, rewrite.nextMarkdown)
    }
    await removeEmptyBundleDirectories(path.dirname(oldPath))
  } catch (error) {
    try {
      await rollback()
    } catch (rollbackError) {
      console.error(`Could not fully roll back concept move: ${rollbackError.message}`)
    }
    throw error
  }

  return { newId, rollback }
}

function embeddingEquivalentText(value) {
  return String(value)
    .replace(/!?\[([^\]]*)\]\([^()\s]+(?:\([^()]*\)[^()]*)+\)/g, '$1')
    .replace(/!?\[([^\]]*)\]\((?:\\.|[^\\)])*\)/g, '$1')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^(\s*\[[^\]]+\]:)\s*(?:<[^>]+>|\S+)/gm, '$1')
}

async function migrateIndexedRecordsAfterMove(oldId, newId) {
  const records = await readRecords()
  const { documents } = await readBundleDocuments()
  const documentsById = new Map(documents.map((document) => [document.id, document]))
  const missingEmbeddingIds = new Set()
  for (const record of records) {
    const nextId = record.id === oldId ? newId : record.id
    const document = documentsById.get(nextId)
    if (document) {
      const nextContent = indexedConceptContent(document.parsed.content)
      if (embeddingEquivalentText(record.content) === embeddingEquivalentText(nextContent)) {
        const previousChunks = [...(record.chunks || [])]
        record.id = nextId
        record.content = nextContent
        record.embeddingInputHash = embeddingInputHash(record)
        record.chunks = noteChunks(`${record.description}\n\n${nextContent}`).map((content) => {
          const comparable = embeddingEquivalentText(content)
          const previousIndex = previousChunks.findIndex((chunk) => embeddingEquivalentText(chunk.content) === comparable)
          const previous = previousIndex === -1 ? null : previousChunks.splice(previousIndex, 1)[0]
          return {
            content,
            embedding: previous?.embedding || null,
            embeddingInputHash: chunkInputHash(record, content),
          }
        })
        if (!record.embedding || record.chunks.some((chunk) => !chunk.embedding)) missingEmbeddingIds.add(nextId)
      } else {
        record.id = nextId
        record.content = nextContent
        record.embedding = null
        record.embeddingInputHash = embeddingInputHash(record)
        record.chunks = recordChunks(record, null)
        missingEmbeddingIds.add(nextId)
      }
    } else if (record.id === oldId) {
      record.id = newId
    }
    if (record.relatedIds) record.relatedIds = record.relatedIds.map((id) => id === oldId ? newId : id)
    if (record.suggestedRelatedIds) record.suggestedRelatedIds = record.suggestedRelatedIds.map((id) => id === oldId ? newId : id)
  }
  await writeRecords(records)
  return missingEmbeddingIds
}


  return { resolveMarkdownLink, resolveBundleResource, markdownRelationships, rewrittenBundleTarget,
    rewriteMarkdownLinkTargets, rewriteFrontmatterYaml, filingPreviousPaths, resolveCurrentConceptId,
    removeEmptyBundleDirectories, moveConceptMarkdown, embeddingEquivalentText, migrateIndexedRecordsAfterMove }
}
