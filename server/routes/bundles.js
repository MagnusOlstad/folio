import fs from 'node:fs/promises'
import path from 'node:path'

function errorResponse(response, error) {
  const message = error instanceof Error ? error.message : 'Bundle operation failed.'
  const status = /not found/i.test(message) ? 404 : 400
  response.status(status).json({ error: message })
}

function slugify(value) {
  return String(value || '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'bundle'
}

function isWithin(parent, child) {
  return child === parent || child.startsWith(`${parent}${path.sep}`)
}

async function canonicalExisting(directory) {
  const canonical = await fs.realpath(String(directory || ''))
  const stat = await fs.stat(canonical)
  if (!stat.isDirectory()) throw new Error('Select a folder for the bundle.')
  await fs.access(canonical, 2)
  return canonical
}

export function registerRoutes(app, manager) {
  const { registry } = manager
  app.get('/api/bundles', (_request, response) => {
    response.json({ version: 1, bundles: registry.list(), error: registry.getError() })
  })

  app.post('/api/bundles/setup', async (request, response) => {
    try {
      registry.assertMutable()
      const body = request.body || {}
      const destination = body.destination === 'existing' ? 'existing' : 'new'
      const source = ['empty', 'existing', 'obsidian'].includes(body.source) ? body.source : 'empty'
      const name = String(body.name || '').trim()
      if (destination === 'existing' && source === 'empty') throw new Error('Choose a source for an existing bundle.')
      const destinationBundleId = destination === 'existing' ? String(body.bundleId || body.destinationBundleId || '') : ''
      if (destinationBundleId) {
        if (source !== 'obsidian') throw new Error('Existing bundles can only receive an Obsidian import from this flow.')
        const existingBundle = registry.get(destinationBundleId)
        if (!existingBundle) throw new Error('Bundle not found.')
        if (source === 'obsidian' && body.scanId) {
          await manager.prepare(existingBundle)
          await manager.run(existingBundle, () => manager.activeRuntime().refreshObsidianScan(String(body.scanId)))
        }
        response.status(200).json({ bundle: existingBundle, bundles: registry.list(), error: registry.getError() })
        return
      }
      if (!name) throw new Error('Bundle name is required.')
      if (name === '.' || name === '..' || name.includes('/') || name.includes('\\')) throw new Error('Bundle name cannot contain a path separator.')
      let markdownPath = body.markdownPath ? String(body.markdownPath) : ''
      let managed = false
      if (destination === 'existing') {
        markdownPath = await canonicalExisting(markdownPath)
      } else if (source === 'existing') {
        markdownPath = await canonicalExisting(body.sourcePath || body.markdownPath)
      } else {
        const slug = slugify(name)
        if (body.parentPath) {
          const parentPath = await canonicalExisting(body.parentPath)
          markdownPath = path.join(parentPath, name)
          if (!isWithin(parentPath, markdownPath)) throw new Error('Bundle path must stay inside the selected parent folder.')
        } else {
          markdownPath = path.join(manager.config?.dataRoot || process.env.FOLIO_DATA_ROOT || path.resolve('data'), 'bundles', slug)
          managed = true
        }
        await fs.mkdir(path.dirname(markdownPath), { recursive: true })
      }
      const bundle = await registry.setup({ name, markdownPath, managed, source: destination === 'existing' ? source : source === 'existing' ? 'existing' : 'empty' })
      if (source === 'obsidian' && body.scanId) {
        await manager.prepare(bundle)
        await manager.run(bundle, () => manager.activeRuntime().refreshObsidianScan(String(body.scanId)))
      }
      response.status(201).json({ bundle, bundles: registry.list(), error: registry.getError() })
    } catch (error) {
      errorResponse(response, error)
    }
  })

  app.patch('/api/bundles/:id', async (request, response) => {
    try {
      const bundle = await registry.rename(request.params.id, request.body?.name)
      response.json({ bundle, bundles: registry.list(), error: registry.getError() })
    } catch (error) {
      errorResponse(response, error)
    }
  })

  app.post('/api/bundles/:id/detach', async (request, response) => {
    try {
      const bundle = await registry.detach(request.params.id)
      response.json({ bundle, bundles: registry.list(), error: registry.getError() })
    } catch (error) {
      errorResponse(response, error)
    }
  })
}
