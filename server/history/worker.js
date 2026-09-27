import fs from 'node:fs/promises'
import path from 'node:path'
import YAML from 'yaml'

import { createTextHelpers } from '../core/text.js'
import { createInProcessHistoryService } from './service.js'

const { normalizeInlineText } = createTextHelpers()

async function markdownFiles(root, directory = root) {
  const entries = await fs.readdir(directory, { withFileTypes: true })
  entries.sort((left, right) => left.name.localeCompare(right.name))
  return (await Promise.all(entries.map(async (entry) => {
    const target = path.join(directory, entry.name)
    if (entry.name === '.git' || path.resolve(target) === path.resolve(root, '.folio')) return []
    if (entry.isDirectory()) return markdownFiles(root, target)
    return entry.isFile() && entry.name.endsWith('.md') ? [target] : []
  }))).flat()
}

function parseMarkdownFile(markdown, filename) {
  const normalized = markdown.replace(/\r\n/g, '\n')
  let frontmatter = {}
  let content = normalized
  if (normalized.startsWith('---\n')) {
    const end = normalized.indexOf('\n---\n', 4)
    if (end !== -1) {
      const parsed = YAML.parse(normalized.slice(4, end))
      frontmatter = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
      content = normalized.slice(end + 5).trimStart()
    }
  }
  const filing = frontmatter.filing && typeof frontmatter.filing === 'object' && !Array.isArray(frontmatter.filing)
    ? frontmatter.filing
    : null
  const heading = content.match(/^#\s+(.+)$/m)?.[1]
  return {
    title: normalizeInlineText(frontmatter.title || heading || path.basename(filename, '.md')),
    description: normalizeInlineText(frontmatter.description || ''),
    tags: Array.isArray(frontmatter.tags) ? frontmatter.tags.map(normalizeInlineText) : [],
    status: ['draft', 'stable', 'deprecated'].includes(frontmatter.status) ? frontmatter.status : 'stable',
    staleAfter: frontmatter.stale_after ? String(frontmatter.stale_after) : null,
    content,
    frontmatter: { ...frontmatter, filing },
  }
}

let service = null
let bundleConfig = null

async function handle(request) {
  if (!service) {
    bundleConfig = request.config
    service = createInProcessHistoryService({
      ...bundleConfig,
      parseMarkdownFile,
      listBundleMarkdownFiles: () => markdownFiles(bundleConfig.bundleRoot),
    })
  }
  if (!['init', 'reconcile', 'entries', 'version'].includes(request.method)) throw new Error('Unknown note history request.')
  const value = await service[request.method](...(request.args || []))
  return { id: request.id, value }
}

async function respond(request, send) {
  try {
    send(await handle(request))
  } catch (error) {
    send({ id: request.id, error: error instanceof Error ? error.message : String(error) })
  }
}

if (process.parentPort) {
  process.parentPort.on('message', (event) => { void respond(event.data, (message) => process.parentPort.postMessage(message)) })
} else {
  process.on('message', (request) => { void respond(request, (message) => process.send?.(message)) })
}
