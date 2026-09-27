import 'dotenv/config'

import fs from 'node:fs/promises'
import express from 'express'

import { createConfig } from './config.js'
import { createTextHelpers } from './core/text.js'
import { createFileStorage } from './storage/files.js'
import { createMarkdownDocuments } from './markdown/documents.js'
import { createMarkdownMoves } from './markdown/moves.js'
import { createKnowledgeIndex } from './knowledge/indexing.js'
import { createOllamaService } from './ollama/service.js'
import { createClassificationService } from './knowledge/classification.js'
import { createSearchService } from './knowledge/search.js'
import { createFilingService } from './filing/service.js'
import { createReleaseService } from './updates/service.js'
import { createObsidianImportService } from './imports/obsidian.js'
import { registerRoutes as registerSystemRoutes } from './routes/system.js'
import { registerRoutes as registerFileRoutes } from './routes/files.js'
import { registerRoutes as registerCaptureRoutes } from './routes/capture.js'
import { registerRoutes as registerConfirmationRoutes } from './routes/confirmation.js'
import { registerRoutes as registerAskRoutes } from './routes/ask.js'
import { registerRoutes as registerImportRoutes } from './routes/imports.js'
import { registerRoutes as registerBackupRoutes } from './routes/backup.js'
import { registerRoutes as registerBundleRoutes } from './routes/bundles.js'
import { createBundleRuntimeManager } from './bundles/registry.js'

export function createRuntime(env = process.env) {
  const runtime = { ...createConfig(env), ...createTextHelpers() }
  Object.assign(runtime, createFileStorage(runtime))
  Object.assign(runtime, createMarkdownDocuments(runtime))
  Object.assign(runtime, createMarkdownMoves(runtime))
  Object.assign(runtime, createKnowledgeIndex(runtime))
  Object.assign(runtime, createOllamaService(runtime))
  Object.assign(runtime, createClassificationService(runtime))
  Object.assign(runtime, createSearchService(runtime))
  Object.assign(runtime, createFilingService(runtime))
  Object.assign(runtime, createReleaseService(runtime))
  Object.assign(runtime, createObsidianImportService(runtime))
  return runtime
}

export async function createApp(runtime = createRuntime()) {
  const manager = createBundleRuntimeManager({
    config: runtime,
    defaultRuntime: runtime,
    createRuntimeForBundle: (bundleConfig) => createRuntime({
      ...process.env,
      FOLIO_DATA_ROOT: bundleConfig.dataRoot,
      FOLIO_BUNDLE_ROOT: bundleConfig.bundleRoot,
      FOLIO_RAW_ROOT: bundleConfig.rawRoot,
      FOLIO_DRAFTS_ROOT: bundleConfig.draftsRoot,
      FOLIO_IMPORTS_ROOT: bundleConfig.importsRoot,
      FOLIO_INDEX_PATH: bundleConfig.indexPath,
    }),
  })
  const initialBundles = await manager.initialize()
  const legacyBundle = initialBundles.find((bundle) => bundle.markdownPath === runtime.bundleRoot)
  if (legacyBundle) {
    await Promise.all([
      fs.mkdir(runtime.rawRoot, { recursive: true }),
      fs.mkdir(runtime.draftsRoot, { recursive: true }),
      fs.mkdir(runtime.importsRoot, { recursive: true }),
    ])
    await runtime.reindexBundle()
    void runtime.refreshMissingEmbeddingsInBackground()
  }

  const app = express()
  app.use(express.json({ limit: '1mb' }))
  registerBundleRoutes(app, manager)
  registerBackupRoutes(app, manager)
  app.use((request, response, next) => {
    const requestedId = request.header('x-folio-bundle') || request.header('x-folio-bundle-id') || String(request.query.bundle || '') || null
    const entry = requestedId ? manager.registry.get(requestedId) : manager.registry.list()[0] || null
    if (requestedId && !entry) {
      response.status(404).json({ error: 'Bundle not found.' })
      return
    }
    if (!entry) {
      if (request.method === 'POST' && request.path === '/api/imports/obsidian/scan') {
        manager.preparePending()
          .then(() => manager.runPending(next))
          .catch(next)
        return
      }
      response.status(409).json({ code: 'NO_BUNDLE', error: 'Set up a bundle before using the workspace.' })
      return
    }
    const preparation = manager.prepare(entry)
    preparation
      .then(() => manager.run(entry, next))
      .catch(next)
  })
  const scopedRuntime = manager.proxyRuntime()
  registerImportRoutes(app, scopedRuntime)
  registerSystemRoutes(app, scopedRuntime)
  registerFileRoutes(app, scopedRuntime)
  registerCaptureRoutes(app, scopedRuntime)
  registerConfirmationRoutes(app, scopedRuntime)
  registerAskRoutes(app, scopedRuntime)
  app.bundleManager = manager
  return app
}
