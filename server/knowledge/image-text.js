import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

import { OCR_MODEL_ID, OCR_MODELS } from '../mlx/ocr-models.js'

const OCR_CACHE_VERSION = 1
const MAX_IMAGES_PER_DOCUMENT = 24
const MAX_IMAGE_TEXT_CHARS = 40_000
const MAX_MEMOIZED_HASHES = 5_000
const ASSET_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp'])

// Hashing is the expensive part of a reindex, so remember it per file version.
const hashMemo = new Map()

/** Mirrors the client cleaner in src/features/workspace/model/image-ocr.ts. */
export function cleanOcrText(text) {
  const normalized = String(text ?? '').replace(/\r\n?/g, '\n').replace(/[ \t]+$/gm, '')
  const withoutWrappers = normalized.replace(
    /^<table>\n([\s\S]*?)\n<\/table>$/gm,
    (match, inner) => (/<tr[\s>]/i.test(inner) ? match : inner),
  )
  return withoutWrappers
    .replace(/^### [A-Za-z]+ - .*\n\*Type: [^*\n]+\*\n(?:\n)?/gm, '')
    .replace(/^\n+|\n+$/g, '')
}

/** Mirrors resolveAssetHref in src/lib/assets.ts. */
export function resolveAssetName(href) {
  if (!href || /^[a-z][a-z\d+.-]*:/i.test(href) || href.startsWith('//')) return null
  let target = href.split(/[?#]/)[0]
  try {
    target = decodeURIComponent(target)
  } catch {
    return null
  }
  const segments = target.split('/')
  if (segments[0] === '.' || segments[0] === '..') {
    while (segments[0] === '.' || segments[0] === '..') segments.shift()
  } else if (segments[0] === '') {
    segments.shift()
  }
  if (segments.length !== 2 || segments[0] !== 'assets') return null
  const name = segments[1]
  return ASSET_NAME.test(name) && !name.includes('..') && IMAGE_EXTENSIONS.has(path.extname(name).toLowerCase()) ? name : null
}

function withoutCode(markdown) {
  return String(markdown)
    .replace(/^ {0,3}(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:\n {0,3}\1[`~]*[ \t]*(?=\n|$)|$)/gm, (block) => block.replace(/[^\n]/g, ' '))
    .replace(/(`+)[^`\n]*?\1/g, (span) => ' '.repeat(span.length))
}

/** Returns `{ alt, name }` for each embedded asset image, in link order. */
export function assetImageLinks(markdown) {
  const links = []
  const pattern = /!\[((?:\\.|[^\]\\])*)\]\(\s*(<[^>\n]*>|[^\s)]*)(?:\s+(?:"[^"]*"|'[^']*'))?\s*\)/g
  for (const match of withoutCode(markdown).matchAll(pattern)) {
    const href = match[2].replace(/^<|>$/g, '')
    const name = resolveAssetName(href)
    if (!name) continue
    const alt = match[1].replace(/\\(.)/g, '$1').replace(/\s+/g, ' ').replace(/\|\d+(?:x\d+)?\s*$/, '').trim()
    links.push({ alt: alt || name, name })
  }
  return links
}

async function fileSha256(filePath, stat) {
  const key = `${filePath}\0${stat.size}\0${stat.mtimeMs}`
  const known = hashMemo.get(key)
  if (known) return known
  const sha256 = crypto.createHash('sha256').update(await fs.readFile(filePath)).digest('hex')
  if (hashMemo.size >= MAX_MEMOIZED_HASHES) hashMemo.clear()
  hashMemo.set(key, sha256)
  return sha256
}

async function cachedText(cacheDirectory, sha256, revision) {
  try {
    const entry = JSON.parse(await fs.readFile(path.join(cacheDirectory, `${sha256}.json`), 'utf8'))
    if (entry?.version === OCR_CACHE_VERSION && entry.sha256 === sha256 && entry.revision === revision
      && typeof entry.text === 'string') return cleanOcrText(entry.text)
  } catch {
    // Missing or unreadable cache entries simply contribute no text.
  }
  return ''
}

/**
 * Collects cached OCR text for the images each note embeds. The result is index-only text:
 * Markdown files and `record.content` are never changed.
 */
export async function collectImageText(documents, { bundleRoot, assertNoBundleSymlinks, revision = OCR_MODELS[OCR_MODEL_ID].revision }) {
  const result = new Map()
  const cacheDirectory = path.join(bundleRoot, '.folio', 'ocr-cache')
  const assetsDirectory = path.join(bundleRoot, 'assets')
  const byName = new Map()

  async function textForAsset(name) {
    if (!byName.has(name)) {
      byName.set(name, (async () => {
        try {
          const filePath = path.join(assetsDirectory, name)
          await assertNoBundleSymlinks(filePath)
          await assertNoBundleSymlinks(cacheDirectory)
          const stat = await fs.stat(filePath)
          if (!stat.isFile()) return null
          const sha256 = await fileSha256(filePath, stat)
          return { sha256, text: await cachedText(cacheDirectory, sha256, revision) }
        } catch {
          return null
        }
      })())
    }
    return byName.get(name)
  }

  for (const document of documents) {
    const seen = new Set()
    const blocks = []
    for (const link of assetImageLinks(document.parsed?.content ?? '').slice(0, MAX_IMAGES_PER_DOCUMENT)) {
      const asset = await textForAsset(link.name)
      if (!asset?.text || seen.has(asset.sha256)) continue
      seen.add(asset.sha256)
      blocks.push(`Image text (${link.alt}):\n${asset.text}`)
    }
    if (blocks.length) result.set(document.id, blocks.join('\n\n').slice(0, MAX_IMAGE_TEXT_CHARS))
  }
  return result
}
