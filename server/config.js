import fsSync from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

function readPackageVersion(projectRoot) {
  try {
    return JSON.parse(fsSync.readFileSync(path.join(projectRoot, 'package.json'), 'utf8')).version || '0.0.0'
  } catch {
    return '0.0.0'
  }
}

export function createConfig(env = process.env) {
  const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  const dataRoot = env.FOLIO_DATA_ROOT || path.join(projectRoot, 'data')
  const bundleRoot = path.join(dataRoot, 'bundle')
  const ollamaUrl = env.OLLAMA_URL || 'http://127.0.0.1:11434'
  const classifierModel = env.OLLAMA_CLASSIFIER_MODEL || 'llama3.2:3b'
  const answerModel = env.OLLAMA_ANSWER_MODEL || 'llama3.2:3b'
  const answerModels = Array.from(new Set([
    answerModel,
    ...(env.OLLAMA_ANSWER_MODELS || 'llama3.2:3b').split(',').map((model) => model.trim()).filter(Boolean),
  ]))
  const embedModel = env.OLLAMA_EMBED_MODEL || 'embeddinggemma'
  const configuredAskContextLength = Number(env.OLLAMA_ASK_CONTEXT_LENGTH || 8192)
  const parsedOllamaUrl = new URL(ollamaUrl)

  return {
    projectRoot,
    dataRoot,
    bundleRoot,
    rawRoot: path.join(bundleRoot, 'references', 'inbox'),
    draftsRoot: path.join(dataRoot, 'drafts'),
    indexPath: path.join(dataRoot, 'search-index.json'),
    distRoot: env.FOLIO_DIST_ROOT || path.join(projectRoot, 'dist'),
    ollamaUrl,
    parsedOllamaUrl,
    classifierModel,
    answerModel,
    answerModels,
    embedModel,
    configuredModels: Array.from(new Set([classifierModel, embedModel, ...answerModels])),
    warmKeepAlive: env.OLLAMA_WARM_KEEP_ALIVE || '1h',
    embeddingSchemaVersion: 2,
    generatedRelatedStart: '<!-- folio:generated-related:start -->',
    generatedRelatedEnd: '<!-- folio:generated-related:end -->',
    askContextLength: Number.isFinite(configuredAskContextLength)
      ? Math.max(4096, Math.floor(configuredAskContextLength))
      : 8192,
    updateRepo: env.FOLIO_UPDATE_REPO || 'MagnusOlstad/folio',
    updateCheckTtl: 6 * 60 * 60 * 1000,
    appVersion: env.FOLIO_VERSION || readPackageVersion(projectRoot),
    port: Number(env.PORT || 8787),
    canLaunchOllama: parsedOllamaUrl.protocol === 'http:'
      && ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(parsedOllamaUrl.hostname),
  }
}
