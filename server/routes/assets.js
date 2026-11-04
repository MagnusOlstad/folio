import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import express from 'express'

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

export function registerRoutes(app, runtime) {
  // The runtime is a per-request proxy, so read bundle-specific values lazily.
  const assetsDirectory = () => path.join(typeof runtime.getBundleRoot === 'function' ? runtime.getBundleRoot() : runtime.bundleRoot, 'assets')
  const assertNoBundleSymlinks = (...args) => runtime.assertNoBundleSymlinks(...args)

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
      const requested = String(request.query.path || '')
      const match = /^\/assets\/([A-Za-z0-9][A-Za-z0-9._-]*)$/.exec(requested)
      const type = match ? EXTENSION_TYPES.get(path.extname(match[1]).toLowerCase()) : null
      if (!match || !type || match[1].includes('..')) throw httpError(400, 'Invalid asset path.')
      const filePath = path.join(assetsDirectory(), match[1])
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
}
