import 'dotenv/config'

import fs from 'node:fs/promises'
import path from 'node:path'
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
import { createTranscriptionStorage } from './transcription/storage.js'
import { createTranscriptionService } from './transcription/service.js'
import { registerRoutes as registerTranscriptionRoutes } from './transcription/routes.js'

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
  Object.assign(runtime, { transcriptionStorage: createTranscriptionStorage(runtime) })
  Object.assign(runtime, { transcriptionService: createTranscriptionService(runtime) })
  return runtime
}

export async function createApp(runtime = createRuntime()) {
  await Promise.all([
    fs.mkdir(runtime.rawRoot, { recursive: true }),
    fs.mkdir(runtime.draftsRoot, { recursive: true }),
    fs.mkdir(runtime.importsRoot, { recursive: true }),
    fs.mkdir(runtime.transcriptionsRoot, { recursive: true }),
    fs.mkdir(path.dirname(runtime.whisperModelPath), { recursive: true }),
  ])
  await runtime.transcriptionService.recoverInterrupted()
  await runtime.reindexBundle()
  void runtime.refreshMissingEmbeddingsInBackground()

  const app = express()
  registerImportRoutes(app, runtime)
  registerBackupRoutes(app, runtime)
  app.use(express.json({ limit: '1mb' }))
  registerSystemRoutes(app, runtime)
  registerFileRoutes(app, runtime)
  registerCaptureRoutes(app, runtime)
  registerConfirmationRoutes(app, runtime)
  registerAskRoutes(app, runtime)
  registerTranscriptionRoutes(app, runtime)
  return app
}
