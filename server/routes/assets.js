import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import express from 'express'
import { OCR_MODEL_ID, OCR_MODELS } from '../mlx/ocr-models.js'
import { captionModelRevision } from '../mlx/caption-models.js'

const MAX_ASSET_BYTES = 20 * 1024 * 1024
const ASSET_TYPES = new Map([
  ['image/png', 'png'],
  ['image/jpeg', 'jpg'],
  ['image/gif', 'gif'],
  ['image/webp', 'webp'],
])
const EXTENSION_TYPES = new Map([
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.gif', 'image/gif'],
  ['.webp', 'image/webp'],
])

function httpError(status, message) {
  const error = new Error(message)
  error.status = status
  return error
}

function matchesMagicBytes(type, buffer) {
  if (type === 'image/png') {
    return buffer.length > 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  }
  if (type === 'image/jpeg') return buffer.length > 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff
  if (type === 'image/gif') {
    const header = buffer.subarray(0, 6).toString('latin1')
    return header === 'GIF87a' || header === 'GIF89a'
  }
  if (type === 'image/webp') {
    return buffer.length > 12 && buffer.subarray(0, 4).toString('latin1') === 'RIFF'
      && buffer.subarray(8, 12).toString('latin1') === 'WEBP'
  }
  return false
}

function filenameSlug(slugify, header) {
  let name = ''
  try {
    name = decodeURIComponent(String(header || ''))
  } catch {
    name = ''
  }
  const base = path.posix.basename(name.replaceAll('\\', '/')).replace(/\.[^.]*$/, '')
  return String(slugify(base, 'image') || 'image').slice(0, 48).replace(/^-+|-+$/g, '') || 'image'
}

// Cached text is valid only for the OCR model revision that produced it.
export const OCR_MODEL_REVISION = OCR_MODELS[OCR_MODEL_ID].revision
const OCR_CACHE_VERSION = 1

const CAPTION_CACHE_VERSION = 1

// A caption is valid only for the currently selected caption model at its pinned revision.
async function readCaptionCache(file, sha256, modelId) {
  try {
    const entry = JSON.parse(await fs.readFile(file, 'utf8'))
    if (entry?.version === CAPTION_CACHE_VERSION && entry.sha256 === sha256 && entry.model === modelId
      && entry.revision === captionModelRevision(modelId) && typeof entry.text === 'string' && entry.text) return entry
  } catch {
    // Missing or corrupt cache entries are regenerated.
  }
  return null
}

function parseAssetPath(requested) {
  const match = /^\/assets\/([A-Za-z0-9][A-Za-z0-9._-]*)$/.exec(String(requested || ''))
  const type = match ? EXTENSION_TYPES.get(path.extname(match[1]).toLowerCase()) : null
  if (!match || !type || match[1].includes('..')) throw httpError(400, 'Invalid asset path.')
  return match[1]
}

async function readOcrCache(file, sha256) {
  try {
    const entry = JSON.parse(await fs.readFile(file, 'utf8'))
    if (entry?.version === OCR_CACHE_VERSION && entry.sha256 === sha256 && entry.revision === OCR_MODEL_REVISION
      && typeof entry.model === 'string' && typeof entry.text === 'string') return entry
  } catch {
    // Missing or corrupt cache entries are recomputed.
  }
  return null
}

export function registerRoutes(app, runtime) {
  // The runtime is a per-request proxy, so read bundle-specific values lazily.
  const assetsDirectory = () => path.join(typeof runtime.getBundleRoot === 'function' ? runtime.getBundleRoot() : runtime.bundleRoot, 'assets')
  const assertNoBundleSymlinks = (...args) => runtime.assertNoBundleSymlinks(...args)

  // New OCR text becomes searchable once the index is rebuilt; this never delays or fails a response.
  function refreshIndexInBackground() {
    try {
      void Promise.resolve(runtime.reindexBundle())
        .then(() => runtime.refreshMissingEmbeddingsInBackground())
        .catch(() => {})
    } catch {
      // Index freshness is best effort.
    }
  }

  app.post(
    '/api/assets',
    express.raw({ type: () => true, limit: MAX_ASSET_BYTES }),
    async (request, response, next) => {
      try {
        const contentType = String(request.header('content-type') || '').split(';')[0].trim().toLowerCase()
        const extension = ASSET_TYPES.get(contentType)
        if (!extension) throw httpError(415, 'Only PNG, JPEG, GIF, and WebP images are supported.')
        const body = Buffer.isBuffer(request.body) ? request.body : Buffer.alloc(0)
        if (!body.length) throw httpError(400, 'The image is empty.')
        if (!matchesMagicBytes(contentType, body)) throw httpError(400, 'The file contents do not match the image type.')

        const date = new Date().toISOString().slice(0, 10)
        const slug = filenameSlug(runtime.slugify, request.header('x-folio-filename'))
        const directory = assetsDirectory()
        await assertNoBundleSymlinks(directory, { allowMissing: true })
        await fs.mkdir(directory, { recursive: true })
        await assertNoBundleSymlinks(directory)

        for (let attempt = 0; attempt < 5; attempt += 1) {
          const name = `${date}-${slug}-${crypto.randomBytes(3).toString('hex')}.${extension}`
          try {
            await fs.writeFile(path.join(directory, name), body, { flag: 'wx' })
            response.status(201).json({ path: `/assets/${name}` })
            return
          } catch (error) {
            if (error.code !== 'EEXIST') throw error
          }
        }
        throw httpError(500, 'Could not choose a unique image name.')
      } catch (error) {
        if (error.type === 'entity.too.large') return response.status(413).json({ error: 'The image is larger than 20 MB.' })
        if (error.status) return response.status(error.status).json({ error: error.message })
        next(error)
      }
    },
  )

  app.get('/api/assets', async (request, response, next) => {
    try {
      const name = parseAssetPath(request.query.path)
      const type = EXTENSION_TYPES.get(path.extname(name).toLowerCase())
      const filePath = path.join(assetsDirectory(), name)
      await assertNoBundleSymlinks(filePath)
      const stat = await fs.stat(filePath)
      if (!stat.isFile()) throw httpError(404, 'Asset not found.')
      response.set('Content-Type', type)
      response.set('X-Content-Type-Options', 'nosniff')
      response.set('Cache-Control', 'private, max-age=3600')
      response.sendFile(filePath, { dotfiles: 'deny' }, (error) => {
        if (error && !response.headersSent) next(error)
      })
    } catch (error) {
      if (error.code === 'ENOENT') return response.status(404).json({ error: 'Asset not found.' })
      if (error.status) return response.status(error.status).json({ error: error.message })
      next(error)
    }
  })

  app.post('/api/assets/ocr', async (request, response, next) => {
    const controller = new AbortController()
    response.on('close', () => {
      if (!response.writableFinished) controller.abort()
    })
    try {
      const name = parseAssetPath(request.body?.path)
      const filePath = path.join(assetsDirectory(), name)
      await assertNoBundleSymlinks(filePath)
      const stat = await fs.stat(filePath)
      if (!stat.isFile()) throw httpError(404, 'Asset not found.')
      const sha256 = crypto.createHash('sha256').update(await fs.readFile(filePath)).digest('hex')
      const cacheDirectory = path.join(typeof runtime.getBundleRoot === 'function' ? runtime.getBundleRoot() : runtime.bundleRoot, '.folio', 'ocr-cache')
      const cacheFile = path.join(cacheDirectory, `${sha256}.json`)

      const cached = await readOcrCache(cacheFile, sha256)
      if (cached) {
        response.json({ text: cached.text, cached: true })
        return
      }

      const result = await runtime.mlxService.extractText(filePath, { signal: controller.signal })
      if (controller.signal.aborted) return
      const entry = {
        version: OCR_CACHE_VERSION,
        sha256,
        model: result.model,
        revision: result.revision,
        text: result.text,
        createdAt: new Date().toISOString(),
      }
      try {
        await assertNoBundleSymlinks(cacheDirectory, { allowMissing: true })
        await fs.mkdir(cacheDirectory, { recursive: true })
        const temporary = path.join(cacheDirectory, `.${sha256}.${crypto.randomBytes(4).toString('hex')}.tmp`)
        await fs.writeFile(temporary, JSON.stringify(entry))
        await fs.rename(temporary, cacheFile)
        refreshIndexInBackground()
      } catch {
        // A cache write failure should not discard the extracted text.
      }
      response.json({ text: result.text, cached: false })
    } catch (error) {
      if (error.code === 'ENOENT') return response.status(404).json({ error: 'Asset not found.' })
      if (error.status) return response.status(error.status).json({ error: error.message })
      if (error.statusCode === 409) return response.status(409).json({ error: error.message })
      if (controller.signal.aborted) return
      next(error)
    }
  })

  app.post('/api/assets/caption', async (request, response, next) => {
    const controller = new AbortController()
    response.on('close', () => {
      if (!response.writableFinished) controller.abort()
    })
    try {
      const name = parseAssetPath(request.body?.path)
      const filePath = path.join(assetsDirectory(), name)
      await assertNoBundleSymlinks(filePath)
      const stat = await fs.stat(filePath)
      if (!stat.isFile()) throw httpError(404, 'Asset not found.')
      const sha256 = crypto.createHash('sha256').update(await fs.readFile(filePath)).digest('hex')
      const cacheDirectory = path.join(typeof runtime.getBundleRoot === 'function' ? runtime.getBundleRoot() : runtime.bundleRoot, '.folio', 'caption-cache')
      const cacheFile = path.join(cacheDirectory, `${sha256}.json`)

      // Selection errors (409) surface before any cache lookup, so a cache never hides "no model chosen".
      const selected = await runtime.mlxService.selectedCaptionModel()
      const cached = selected ? await readCaptionCache(cacheFile, sha256, selected) : null
      if (cached) {
        response.json({ text: cached.text, cached: true, model: cached.model })
        return
      }

      const result = await runtime.mlxService.captionImage(filePath, { signal: controller.signal })
      if (controller.signal.aborted) return
      const entry = {
        version: CAPTION_CACHE_VERSION,
        sha256,
        model: result.modelId,
        repository: result.model,
        revision: result.revision,
        text: result.text,
        createdAt: new Date().toISOString(),
      }
      try {
        await assertNoBundleSymlinks(cacheDirectory, { allowMissing: true })
        await fs.mkdir(cacheDirectory, { recursive: true })
        const temporary = path.join(cacheDirectory, `.${sha256}.${crypto.randomBytes(4).toString('hex')}.tmp`)
        await fs.writeFile(temporary, JSON.stringify(entry))
        await fs.rename(temporary, cacheFile)
        refreshIndexInBackground()
      } catch {
        // A cache write failure should not discard the description.
      }
      response.json({ text: result.text, cached: false, model: result.modelId })
    } catch (error) {
      if (error.code === 'ENOENT') return response.status(404).json({ error: 'Asset not found.' })
      if (error.status) return response.status(error.status).json({ error: error.message })
      if (error.statusCode === 409) {
        return response.status(409).json({
          error: error.message,
          ...(error.code ? { code: error.code } : {}),
          ...(error.modelId ? { modelId: error.modelId } : {}),
        })
      }
      if (controller.signal.aborted) return
      next(error)
    }
  })
}
