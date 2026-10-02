import 'dotenv/config'

import fs from 'node:fs/promises'
import express from 'express'

import { createConfig } from './config.js'
import { createTextHelpers } from './core/text.js'
import { createFileStorage } from './storage/files.js'
import { createMarkdownDocuments } from './markdown/documents.js'
import { createMarkdownMoves } from './markdown/moves.js'
import { createKnowledgeIndex } from './knowledge/indexing.js'
import { createMlxService } from './mlx/service.js'
import { createTranscriptionStorage } from './transcription/storage.js'
import { createTranscriptionService } from './transcription/service.js'
import { createClassificationService } from './knowledge/classification.js'
import { createSearchService } from './knowledge/search.js'
import { createFilingService } from './filing/service.js'
import { createReleaseService } from './updates/service.js'
import { createObsidianImportService } from './imports/obsidian.js'
import { createHistoryService } from './history/service.js'
import { registerRoutes as registerMlxRoutes } from './routes/mlx.js'
import { registerRoutes as registerSystemRoutes } from './routes/system.js'
import { registerRoutes as registerFileRoutes } from './routes/files.js'
import { registerRoutes as registerExplorerRoutes } from './routes/explorer.js'
import { registerRoutes as registerCaptureRoutes } from './routes/capture.js'
import { registerRoutes as registerConfirmationRoutes } from './routes/confirmation.js'
import { registerRoutes as registerAskRoutes } from './routes/ask.js'
import { registerRoutes as registerImportRoutes } from './routes/imports.js'
import { registerRoutes as registerBackupRoutes } from './routes/backup.js'
import { registerRoutes as registerBundleRoutes } from './routes/bundles.js'
import { registerRoutes as registerHistoryRoutes } from './routes/history.js'
import { registerRoutes as registerTranscriptionRoutes } from './transcription/routes.js'
import { createBundleRuntimeManager } from './bundles/registry.js'

export function createRuntime(env = process.env, sharedMlxService = null) {
  const runtime = { ...createConfig(env), ...createTextHelpers() }
  runtime.mlxService = sharedMlxService || createMlxService(runtime)
  runtime.transcriptionStorage = createTranscriptionStorage(runtime)
  runtime.transcriptionService = createTranscriptionService(runtime)
  Object.assign(runtime, createFileStorage(runtime))
  Object.assign(runtime, createMarkdownDocuments(runtime))
  Object.assign(runtime, createMarkdownMoves(runtime))
  Object.assign(runtime, createKnowledgeIndex(runtime))
  Object.assign(runtime, createClassificationService(runtime))
  Object.assign(runtime, createSearchService(runtime))
  Object.assign(runtime, createFilingService(runtime))
  Object.assign(runtime, createReleaseService(runtime))
  Object.assign(runtime, createObsidianImportService(runtime))
  Object.assign(runtime, { history: createHistoryService(runtime) })
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
      FOLIO_HISTORY_BUNDLE_ID: bundleConfig.historyBundleId,
      FOLIO_HISTORY_GIT_DIR: bundleConfig.historyGitDir,
      FOLIO_LEGACY_HISTORY_GIT_DIR: bundleConfig.legacyHistoryGitDir,
      FOLIO_MODEL_ROOT: runtime.modelRoot,
    }, runtime.mlxService),
  })
  const initialBundles = await manager.initialize()
  await runtime.transcriptionService.recoverInterrupted()
  const legacyBundle = initialBundles.find((bundle) => bundle.markdownPath === runtime.bundleRoot)
  if (legacyBundle) {
    await Promise.all([
      fs.mkdir(runtime.rawRoot, { recursive: true }),
      fs.mkdir(runtime.draftsRoot, { recursive: true }),
      fs.mkdir(runtime.importsRoot, { recursive: true }),
    ])
    await runtime.reindexBundle()
    manager.trackBackground(
      runtime.history.reconcile('Baseline'),
      'Could not initialize note history.',
    )
    manager.trackBackground(
      runtime.refreshMissingEmbeddingsInBackground(),
      'Could not refresh the semantic index.',
    )
  }

  const app = express()
  app.use(express.json({ limit: '1mb' }))
  registerBundleRoutes(app, manager)
  registerBackupRoutes(app, manager)
  registerMlxRoutes(app, runtime.mlxService, manager)
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
  registerExplorerRoutes(app, scopedRuntime)
  registerFileRoutes(app, scopedRuntime)
  registerHistoryRoutes(app, scopedRuntime)
  registerTranscriptionRoutes(app, scopedRuntime)
  registerCaptureRoutes(app, scopedRuntime)
  registerConfirmationRoutes(app, scopedRuntime)
  registerAskRoutes(app, scopedRuntime)
  app.bundleManager = manager
  return app
}
