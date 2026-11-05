import { ZipArchive } from 'archiver'

function backupFilename() {
  const timestamp = new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-')
  return `folio-bundle-backup-${timestamp}.zip`
}

function safeBundleName(name) {
  const normalized = String(name || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
  return normalized || 'bundle'
}

function compareBundles(left, right) {
  for (const key of ['name', 'id', 'markdownPath']) {
    if (left[key] < right[key]) return -1
    if (left[key] > right[key]) return 1
  }
  return 0
}

function archiveRoots(bundles) {
  const counts = new Map()
  return [...bundles]
    .sort(compareBundles)
    .map((bundle) => {
      const baseName = safeBundleName(bundle.name)
      const collisionKey = baseName.toLowerCase()
      const count = (counts.get(collisionKey) || 0) + 1
      counts.set(collisionKey, count)
      return { ...bundle, archivePath: `bundles/${baseName}${count === 1 ? '' : `-${count}`}` }
    })
}

export function registerRoutes(app, manager) {
  app.get('/api/backup', async (_request, response, next) => {
    const bundles = manager.registry.list()
    if (!bundles.length) {
      response.status(409).json({ code: 'NO_BUNDLE', error: 'Set up a bundle before downloading a backup.' })
      return
    }

    let bundleBackups
    try {
      bundleBackups = await Promise.all(archiveRoots(bundles).map(async (bundle) => {
        const entityService = manager.runtimeFor(bundle).entityService
        await entityService.restoreBundleSidecar?.()
        return { ...bundle, entityMetadata: await entityService.exportUserMetadata() }
      }))
    } catch (error) {
      if (error.code === 'ENTITY_LEDGER_DAMAGED') {
        response.status(error.status || 503).json({ code: error.code, error: error.message })
        return
      }
      next(error)
      return
    }

    const archive = new ZipArchive({ zlib: { level: 9 } })
    let failed = false
    const fail = (error) => {
      if (failed) return
      failed = true
      if (response.headersSent) response.destroy(error)
      else next(error)
    }

    archive.on('warning', (error) => {
      if (error.code !== 'ENOENT') fail(error)
    })
    archive.on('error', fail)
    response.on('close', () => {
      if (!response.writableEnded) archive.abort()
    })

    response.status(200)
    response.set('Cache-Control', 'no-store')
    response.attachment(backupFilename())
    archive.pipe(response)
    for (const bundle of bundleBackups) {
      archive.directory(bundle.markdownPath, bundle.archivePath, (entry) => entry.name === '.folio/entity-metadata.json' ? false : entry)
      archive.append(`${JSON.stringify(bundle.entityMetadata, null, 2)}\n`, { name: `${bundle.archivePath}/.folio/entity-metadata.json` })
    }
    void archive.finalize().catch(fail)
  })
}
