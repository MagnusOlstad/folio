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
  const bundleRoot = env.FOLIO_BUNDLE_ROOT || path.join(dataRoot, 'bundle')
  const historyBundleId = env.FOLIO_HISTORY_BUNDLE_ID || 'legacy-bundle'
  const classifierModel = 'mlx-community/gemma-4-e4b-it-4bit'
  const answerModel = classifierModel
  const answerModels = [classifierModel]
  const embedModel = 'mlx-community/embeddinggemma-300m-4bit'
  const configuredAskContextLength = Number(env.FOLIO_ASK_CONTEXT_LENGTH || 8192)

  return {
    projectRoot,
    dataRoot,
    bundleRoot,
    historyBundleId,
    historyGitDir: path.join(bundleRoot, '.folio', 'history.git'),
    legacyHistoryGitDir: env.FOLIO_LEGACY_HISTORY_GIT_DIR || env.FOLIO_HISTORY_GIT_DIR || path.join(dataRoot, 'state', 'bundles', historyBundleId, 'history.git'),
    rawRoot: env.FOLIO_RAW_ROOT || path.join(bundleRoot, 'references', 'inbox'),
    draftsRoot: env.FOLIO_DRAFTS_ROOT || path.join(dataRoot, 'drafts'),
    importsRoot: env.FOLIO_IMPORTS_ROOT || path.join(dataRoot, 'imports'),
    indexPath: env.FOLIO_INDEX_PATH || path.join(dataRoot, 'search-index.json'),
    modelRoot: env.FOLIO_MODEL_ROOT || path.join(dataRoot, 'models'),
    transcriptionsRoot: env.FOLIO_TRANSCRIPTIONS_ROOT || path.join(dataRoot, 'transcriptions'),
    mlxHelperPath: env.FOLIO_MLX_HELPER || null,
    distRoot: env.FOLIO_DIST_ROOT || path.join(projectRoot, 'dist'),
    classifierModel,
    answerModel,
    answerModels,
    embedModel,
    configuredModels: Array.from(new Set([classifierModel, embedModel, ...answerModels])),
    warmKeepAliveMs: 60 * 60 * 1000,
    embeddingSchemaVersion: 3,
    generatedRelatedStart: '<!-- folio:generated-related:start -->',
    generatedRelatedEnd: '<!-- folio:generated-related:end -->',
    askContextLength: Number.isFinite(configuredAskContextLength)
      ? Math.max(4096, Math.floor(configuredAskContextLength))
      : 8192,
    updateRepo: env.FOLIO_UPDATE_REPO || 'MagnusOlstad/folio',
    updateCheckTtl: 6 * 60 * 60 * 1000,
    appVersion: env.FOLIO_VERSION || readPackageVersion(projectRoot),
    port: Number(env.PORT || 8787),
  }
}
