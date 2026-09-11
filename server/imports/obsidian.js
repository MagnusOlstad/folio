import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

const IGNORED_DIRECTORIES = new Set(['.obsidian', '.trash', '.git'])

function hash(value) {
  return crypto.createHash('sha256').update(value).digest('hex')
}

function normalizedRelativePath(value) {
  const relativePath = String(value || '').replaceAll('\\', '/').replace(/^\/+/, '')
  if (!relativePath || relativePath.split('/').some((part) => !part || part === '.' || part === '..')) return null
  return relativePath
}

function isMarkdown(relativePath) {
  return path.posix.extname(relativePath).toLowerCase() === '.md'
}

function sourceTitle(parsed, relativePath) {
  return String(parsed.frontmatter.title || parsed.title || path.posix.basename(relativePath, '.md')).trim()
}

function sourceTags(frontmatter, normalizeTag) {
  const values = Array.isArray(frontmatter.tags)
    ? frontmatter.tags
    : typeof frontmatter.tags === 'string'
      ? frontmatter.tags.split(',')
      : frontmatter.tag
        ? [frontmatter.tag]
        : []
  return values.map(normalizeTag).filter(Boolean)
}

function sourceAliases(frontmatter) {
  const values = Array.isArray(frontmatter.aliases)
    ? frontmatter.aliases
    : frontmatter.aliases ? [frontmatter.aliases] : []
  return values.map((value) => String(value).trim()).filter(Boolean)
}

function sourceDate(frontmatter, stat) {
  for (const key of ['created', 'created_at', 'date']) {
    if (!frontmatter[key]) continue
    const date = new Date(frontmatter[key])
    if (!Number.isNaN(date.getTime())) return date.toISOString()
  }
  return (stat?.birthtimeMs > 0 ? stat.birthtime : stat?.mtime || new Date()).toISOString()
}

function lookupKeys(relativePath, aliases = []) {
  const withoutExtension = relativePath.replace(/\.md$/i, '')
  return [
    withoutExtension,
    path.posix.basename(withoutExtension),
    ...aliases,
  ].map((value) => value.toLowerCase())
}

function relativeConceptLink(fromId, toId) {
  let result = path.posix.relative(path.posix.dirname(fromId), toId)
  if (!result.startsWith('.')) result = `./${result}`
  return result
}

export function rewriteObsidianLinks(content, currentSourcePath, currentDestination, notes) {
  const exact = new Map()
  const ambiguous = new Set()
  for (const note of notes) {
    if (!note.destination) continue
    for (const key of lookupKeys(note.relativePath, note.aliases)) {
      if (exact.has(key) && exact.get(key) !== note.destination) ambiguous.add(key)
      else exact.set(key, note.destination)
    }
  }
  const resolve = (rawTarget) => {
    const clean = decodeURIComponent(rawTarget).split('#')[0].replaceAll('\\', '/').replace(/\.md$/i, '')
    const sibling = path.posix.normalize(path.posix.join(path.posix.dirname(currentSourcePath), clean)).toLowerCase()
    const candidates = [clean.toLowerCase(), sibling, path.posix.basename(clean).toLowerCase()]
    const key = candidates.find((candidate) => exact.has(candidate) && !ambiguous.has(candidate))
    return key ? exact.get(key) : null
  }
  let unresolved = 0
  let rewritten = content.replace(/(!?)\[\[([^\]]+)\]\]/g, (original, embed, inner) => {
    const [targetAndHeading, label] = inner.split('|')
    const destination = resolve(targetAndHeading)
    if (!destination) {
      unresolved += 1
      return original
    }
    const heading = targetAndHeading.includes('#') ? `#${targetAndHeading.split('#').slice(1).join('#')}` : ''
    const text = label || targetAndHeading.split('#')[0]
    return `${embed ? '!' : ''}[${text}](${relativeConceptLink(currentDestination, destination)}${heading})`
  })
  rewritten = rewritten.replace(/(!?)\[([^\]]*)\]\(([^)]+)\)/g, (original, embed, label, rawTarget) => {
    if (/^(?:[a-z]+:|#)/i.test(rawTarget) || embed) return original
    const destination = resolve(rawTarget)
    if (!destination) return original
    const heading = rawTarget.includes('#') ? `#${rawTarget.split('#').slice(1).join('#')}` : ''
    return `[${label}](${relativeConceptLink(currentDestination, destination)}${heading})`
  })
  return { content: rewritten, unresolved }
}

async function writeJsonAtomic(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  const temporaryPath = `${filePath}.${process.pid}.${crypto.randomBytes(3).toString('hex')}.tmp`
  await fs.writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' })
  await fs.rename(temporaryPath, filePath)
}

async function readJson(filePath, fallback) {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8'))
  } catch (error) {
    if (error.code === 'ENOENT' || error instanceof SyntaxError) return fallback
    throw error
  }
}

async function collectFilesystemFiles(root, directory = root) {
  const files = []
  let attachments = 0
  const entries = await fs.readdir(directory, { withFileTypes: true })
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (entry.isSymbolicLink()) continue
    if (entry.isDirectory()) {
      if (IGNORED_DIRECTORIES.has(entry.name) || entry.name.startsWith('.')) continue
      const nested = await collectFilesystemFiles(root, path.join(directory, entry.name))
      files.push(...nested.files)
      attachments += nested.attachments
    } else if (entry.isFile()) {
      const relativePath = path.relative(root, path.join(directory, entry.name)).split(path.sep).join('/')
      if (isMarkdown(relativePath)) {
        const absolutePath = path.join(directory, entry.name)
        const [bytes, stat] = await Promise.all([fs.readFile(absolutePath), fs.stat(absolutePath)])
        files.push({ relativePath, absolutePath, hash: hash(bytes), size: bytes.length, mtime: stat.mtime.toISOString(), birthtime: stat.birthtime.toISOString() })
      } else attachments += 1
    }
  }
  return { files, attachments }
}

export function createObsidianImportService(runtime) {
  const scans = new Map()
  const jobs = new Map()

  function vaultRoot(vaultId) {
    return path.join(runtime.importsRoot, 'obsidian', vaultId)
  }

  async function manifestFor(vaultId, name) {
    const manifestPath = path.join(vaultRoot(vaultId), 'manifest.json')
    const manifest = await readJson(manifestPath, { version: 1, vaultId, name, files: {}, updatedAt: null })
    let recovered = false
    const { documents } = await runtime.readBundleDocuments()
    for (const document of documents) {
      const provenance = document.parsed.frontmatter.import
      if (provenance?.provider !== 'obsidian' || provenance?.vault_id !== vaultId || !provenance?.source_path || !provenance?.source_hash) continue
      const current = manifest.files[provenance.source_path]
      if (current?.status === 'complete' && current.destination === document.id && current.hash === provenance.source_hash) continue
      manifest.files[provenance.source_path] = {
        ...(current || {}),
        hash: provenance.source_hash,
        status: 'complete',
        destination: document.id,
        importedAt: provenance.imported_at || document.parsed.filedAt,
        error: null,
      }
      recovered = true
    }
    if (recovered) {
      manifest.updatedAt = new Date().toISOString()
      await writeJsonAtomic(manifestPath, manifest)
    }
    return { manifest, manifestPath }
  }

  async function summarize(scan, manifest) {
    const counts = { new: 0, imported: 0, changed: 0, retryable: 0, invalid: 0, attachments: scan.attachments }
    for (const file of scan.files) {
      const previous = manifest.files[file.relativePath]
      if (!previous) counts.new += 1
      else if (previous.hash !== file.hash && previous.status === 'complete') counts.changed += 1
      else if (previous.status === 'complete') {
        const destinationPath = runtime.resolveBundleMarkdownPath(previous.destination)
        if (destinationPath && await runtime.readOptionalFile(destinationPath)) counts.imported += 1
        else counts.retryable += 1
      } else counts.retryable += 1
    }
    return counts
  }

  async function finishScan(scan) {
    const { manifest } = await manifestFor(scan.vaultId, scan.name)
    scan.counts = await summarize(scan, manifest)
    scan.requiredUploads = scan.provider === 'browser'
      ? scan.files.filter((file) => {
        const previous = manifest.files[file.relativePath]
        return !previous || previous.hash === file.hash && previous.status !== 'complete'
      }).map((file) => file.relativePath)
      : []
    scans.set(scan.id, scan)
    return publicScan(scan)
  }

  function publicScan(scan) {
    return { id: scan.id, vaultId: scan.vaultId, name: scan.name, provider: scan.provider, total: scan.files.length, counts: scan.counts, requiredUploads: scan.requiredUploads }
  }

  async function scanObsidianFilesystem(vaultPath) {
    const canonicalPath = await fs.realpath(vaultPath)
    const stat = await fs.stat(canonicalPath)
    if (!stat.isDirectory()) throw new Error('Select an Obsidian vault folder.')
    const collected = await collectFilesystemFiles(canonicalPath)
    return finishScan({ id: crypto.randomUUID(), vaultId: hash(canonicalPath).slice(0, 24), name: path.basename(canonicalPath), provider: 'electron', root: canonicalPath, ...collected })
  }

  async function scanObsidianBrowser({ vaultId, name, files, attachments = 0 }) {
    if (!/^[a-zA-Z0-9_-]{8,80}$/.test(vaultId)) throw new Error('Invalid browser vault identifier.')
    const normalized = files.map((file) => ({ relativePath: normalizedRelativePath(file.relativePath), hash: String(file.hash || ''), size: Number(file.size || 0), mtime: String(file.mtime || '') }))
    if (normalized.some((file) => !file.relativePath || !isMarkdown(file.relativePath) || !/^[a-f0-9]{64}$/.test(file.hash))) throw new Error('The vault scan contains invalid files.')
    return finishScan({ id: crypto.randomUUID(), vaultId, name: String(name || 'Obsidian vault').slice(0, 120), provider: 'browser', files: normalized, attachments: Number(attachments) || 0, uploads: new Map() })
  }

  async function stageBrowserFile(scanId, relativePath, bytes) {
    const scan = scans.get(scanId)
    const normalized = normalizedRelativePath(relativePath)
    const descriptor = scan?.files.find((file) => file.relativePath === normalized)
    if (!scan || scan.provider !== 'browser' || !descriptor) throw new Error('Import scan not found.')
    if (hash(bytes) !== descriptor.hash) throw new Error(`The selected file changed during scanning: ${normalized}`)
    const stagingPath = path.join(vaultRoot(scan.vaultId), 'staging', scan.id, normalized)
    await fs.mkdir(path.dirname(stagingPath), { recursive: true })
    await fs.writeFile(stagingPath, bytes)
    scan.uploads.set(normalized, stagingPath)
    return { uploaded: normalized }
  }

  async function sourceBytes(scan, file) {
    return fs.readFile(scan.provider === 'electron' ? file.absolutePath : scan.uploads.get(file.relativePath) || path.join(vaultRoot(scan.vaultId), 'source', file.relativePath))
  }

  async function runJob(job, scan) {
    const { manifest, manifestPath } = await manifestFor(scan.vaultId, scan.name)
    let wrote = false
    let reindexAttempted = false

    async function reindexWrittenFiles() {
      if (!wrote || reindexAttempted) return
      reindexAttempted = true
      job.phase = 'indexing'
      await runtime.reindexBundle()
      void runtime.refreshMissingEmbeddingsInBackground()
    }

    try {
      const status = await runtime.ollamaStatus()
      if (!status.online || !runtime.hasOllamaModel(runtime.classifierModel, status.installed)) throw new Error(`The classifier model ${runtime.classifierModel} must be installed before importing.`)
      const records = await runtime.readRecords()
      const candidates = []
      for (const file of scan.files) {
        const previous = manifest.files[file.relativePath]
        if (previous?.status === 'complete' && previous.hash !== file.hash) continue
        const destinationPath = previous?.destination && runtime.resolveBundleMarkdownPath(previous.destination)
        if (previous?.status === 'complete' && previous.hash === file.hash && destinationPath && await runtime.readOptionalFile(destinationPath)) continue
        candidates.push(file)
      }
      job.total = candidates.length
      job.phase = 'planning'
      const sources = new Map()
      const reservedByDirectory = new Map()
      for (const file of candidates) {
        const bytes = await sourceBytes(scan, file)
        if (hash(bytes) !== file.hash) {
          manifest.files[file.relativePath] = { ...(manifest.files[file.relativePath] || {}), hash: file.hash, status: 'failed', error: 'The source changed after the vault was scanned.' }
          job.failed += 1
          job.processed += 1
          manifest.updatedAt = new Date().toISOString()
          await writeJsonAtomic(manifestPath, manifest)
          continue
        }
        const raw = bytes.toString('utf8')
        const archivePath = path.join(vaultRoot(scan.vaultId), 'source', file.relativePath)
        await fs.mkdir(path.dirname(archivePath), { recursive: true })
        await fs.writeFile(archivePath, bytes)
        if (job.cancelRequested) break
        try {
          const parsed = runtime.parseMarkdownFile(raw, file.relativePath)
          sources.set(file.relativePath, { raw, parsed })
          const result = runtime.normalizeClassification(
            await runtime.classify(`Source path: ${file.relativePath}\n\n${parsed.content}`, records, { keepAlive: 0 }),
            parsed.content,
            records,
          )
          const directory = `/${result.path.join('/')}`
          const directoryPath = path.join(runtime.bundleRoot, ...result.path)
          await fs.mkdir(directoryPath, { recursive: true })
          const reserved = reservedByDirectory.get(directory) || new Set()
          reservedByDirectory.set(directory, reserved)
          const filename = await runtime.availableConceptFilename(directoryPath, sourceTitle(parsed, file.relativePath), null, reserved)
          reserved.add(filename)
          manifest.files[file.relativePath] = { ...(manifest.files[file.relativePath] || {}), hash: file.hash, status: 'planned', destination: path.posix.join(directory, filename), archive: path.relative(runtime.dataRoot, archivePath).split(path.sep).join('/'), classification: result, error: null }
        } catch (error) {
          manifest.files[file.relativePath] = { ...(manifest.files[file.relativePath] || {}), hash: file.hash, status: 'failed', error: error.message }
          job.failed += 1
        }
        manifest.updatedAt = new Date().toISOString()
        await writeJsonAtomic(manifestPath, manifest)
        job.processed += 1
      }
      if (job.cancelRequested) { job.phase = 'cancelled'; return }
      job.phase = 'writing'
      job.processed = 0
      const allNotes = scan.files.map((file) => {
        const entry = manifest.files[file.relativePath]
        const parsed = sources.get(file.relativePath)?.parsed
        return { relativePath: file.relativePath, destination: entry?.destination, aliases: parsed ? sourceAliases(parsed.frontmatter) : [] }
      })
      for (const file of candidates) {
        if (job.cancelRequested) break
        const entry = manifest.files[file.relativePath]
        if (entry?.status !== 'planned') {
          job.processed += 1
          continue
        }
        try {
          const { raw, parsed } = sources.get(file.relativePath) || { raw: (await sourceBytes(scan, file)).toString('utf8') }
          const source = parsed || runtime.parseMarkdownFile(raw, file.relativePath)
          const classified = entry.classification
          if (!classified) throw new Error('The saved import plan is incomplete; scan the vault again.')
          const linked = rewriteObsidianLinks(source.content, file.relativePath, entry.destination, allNotes)
          const importedAt = new Date().toISOString()
          const tags = Array.from(new Set([...sourceTags(source.frontmatter, runtime.normalizeTag), ...classified.tags])).slice(0, 12)
          const frontmatter = {
            title: sourceTitle(source, file.relativePath),
            type: String(source.frontmatter.type || classified.type),
            description: String(source.frontmatter.description || classified.description),
            tags,
            ...(sourceAliases(source.frontmatter).length ? { aliases: sourceAliases(source.frontmatter) } : {}),
            status: 'draft',
            generated: { by: `okf-notetaker/${runtime.classifierModel}`, at: sourceDate(source.frontmatter, { birthtime: new Date(file.birthtime || file.mtime), birthtimeMs: Date.parse(file.birthtime || ''), mtime: new Date(file.mtime) }) },
            filing: { by: 'import:obsidian', at: importedAt },
            import: { provider: 'obsidian', vault_id: scan.vaultId, source_path: file.relativePath, source_hash: file.hash, imported_at: importedAt, destination: entry.destination },
          }
          const destinationPath = runtime.resolveBundleMarkdownPath(entry.destination)
          await fs.mkdir(path.dirname(destinationPath), { recursive: true })
          try {
            await fs.writeFile(destinationPath, runtime.markdownDocument(frontmatter, linked.content), { flag: 'wx' })
          } catch (error) {
            if (error.code !== 'EEXIST') throw error
            const existing = runtime.parseMarkdownFile(await fs.readFile(destinationPath, 'utf8'), destinationPath)
            const provenance = existing.frontmatter.import
            if (provenance?.provider !== 'obsidian' || provenance?.vault_id !== scan.vaultId || provenance?.source_path !== file.relativePath || provenance?.source_hash !== file.hash) throw error
          }
          Object.assign(entry, { status: 'complete', importedAt, unresolvedLinks: linked.unresolved, error: null })
          job.imported += 1
          job.unresolvedLinks += linked.unresolved
          wrote = true
        } catch (error) {
          entry.status = 'failed'
          entry.error = error.message
          job.failed += 1
        }
        manifest.updatedAt = new Date().toISOString()
        await writeJsonAtomic(manifestPath, manifest)
        job.processed += 1
      }
      await reindexWrittenFiles()
      job.phase = job.cancelRequested ? 'cancelled' : 'completed'
    } catch (error) {
      try {
        await reindexWrittenFiles()
      } catch (reindexError) {
        console.error(`Could not index partially imported Obsidian notes: ${reindexError.message}`)
      }
      job.phase = 'failed'
      job.error = error.message
    } finally {
      job.finishedAt = new Date().toISOString()
    }
  }

  async function startObsidianImport(scanId) {
    const scan = scans.get(scanId)
    if (!scan) throw new Error('Import scan not found. Select the vault again.')
    if (scan.jobId) {
      const existing = jobs.get(scan.jobId)
      if (existing && !['completed', 'cancelled', 'failed'].includes(existing.phase)) throw new Error('This vault import is already running.')
    }
    const missing = scan.requiredUploads.filter((relativePath) => !scan.uploads?.has(relativePath))
    if (missing.length) throw new Error(`Upload the scanned vault files before importing (${missing.length} missing).`)
    const job = { id: crypto.randomUUID(), scanId, phase: 'staging', processed: 0, total: 0, imported: 0, failed: 0, unresolvedLinks: 0, error: null, cancelRequested: false, startedAt: new Date().toISOString(), finishedAt: null }
    jobs.set(job.id, job)
    scan.jobId = job.id
    void runJob(job, scan)
    return { ...job, cancelRequested: undefined }
  }

  function getObsidianImportJob(jobId) {
    const job = jobs.get(jobId)
    if (!job) throw new Error('Import job not found.')
    return { ...job, cancelRequested: undefined }
  }

  function cancelObsidianImport(jobId) {
    const job = jobs.get(jobId)
    if (!job) throw new Error('Import job not found.')
    job.cancelRequested = true
    return getObsidianImportJob(jobId)
  }

  return { scanObsidianFilesystem, scanObsidianBrowser, stageBrowserFile, startObsidianImport, getObsidianImportJob, cancelObsidianImport }
}
