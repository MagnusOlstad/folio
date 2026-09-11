import { ZipArchive } from 'archiver'

function backupFilename() {
  const timestamp = new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-')
  return `folio-bundle-backup-${timestamp}.zip`
}

export function registerRoutes(app, runtime) {
  app.get('/api/backup', (_request, response, next) => {
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
    archive.directory(runtime.bundleRoot, 'bundle')
    void archive.finalize().catch(fail)
  })
}
