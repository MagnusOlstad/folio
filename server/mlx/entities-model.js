import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import { modelSnapshotRoot } from './snapshots.js'

export const ENTITY_MODEL_ID = 'gliner25multi'
export const ENTITY_MODEL_REPOSITORY = 'fastino/gliner2.5-multi-v1'
export const ENTITY_MODEL_REVISION = '7b005274e82da37dcf1f5fd9d6a2ef413c6a004c'
export const ENTITY_MODEL_BYTES = 1_165_502_487

const files = Object.freeze({
  'config.json': { size: 4_104, sha256: '3e4a96bf01da1094180f2d8998411c1a9fd6e2ae4b5b3e4bc6950318cee95bb7' },
  'encoder_config/config.json': { size: 857, sha256: 'fa4f9ef2903b5369ab172333aae4574e6a476511d7465845cf59f8360ee18716' },
  'model.safetensors': { size: 1_149_461_028, sha256: 'c1ff4ec0bc00031c15530b8f3c33d3677f27949e6a0cb52e1247a6224b6c5395' },
  'tokenizer.json': { size: 16_035_853, sha256: 'c62446df87ae18ec98b133f8f84fc449a07cc89bbf8ef192a4cb5f9c53777a7a' },
  'tokenizer_config.json': { size: 645, sha256: '0bf3ea0873234bd9bfdd3853c440395009ac6365a925b91654daed5396d655e1' },
})

const validationCache = new Map()

async function sha256(filePath) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(filePath)) hash.update(chunk)
  return hash.digest('hex')
}

function isPinnedConfiguration(config, encoder) {
  const head = config?.boundary_head
  return config?.architecture === 'boundary'
    && config.architecture_version === 1
    && config.model_type === 'gliner2'
    && config.model_name === 'microsoft/mdeberta-v3-base'
    && config.max_len === 4096
    && config.token_pooling === 'first'
    && head?.candidate_pool === 'shared'
    && head?.candidate_attention_layers === 0
    && head?.query_attention_layers === 0
    && head?.overlap_policy === 'flat'
    && head?.enable_abstention === true
    && head?.boundary_attention_layers === 2
    && head?.boundary_refinement_layers === 1
    && head?.boundary_dim === 128
    && head?.pool_boundary_top_k === 32
    && head?.pool_size === 192
    && encoder?.model_type === 'deberta-v2'
    && encoder.vocab_size === 250_112
    && encoder.hidden_size === 768
    && encoder.num_hidden_layers === 12
    && encoder.num_attention_heads === 12
    && encoder.intermediate_size === 3_072
    && encoder.position_buckets === 256
    && encoder.relative_attention === true
    && encoder.share_att_key === true
    && Array.isArray(encoder.pos_att_type)
    && encoder.pos_att_type.length === 2
    && encoder.pos_att_type.includes('p2c')
    && encoder.pos_att_type.includes('c2p')
}

export async function findEntityModelSnapshot(cacheRoot, model) {
  const snapshot = path.join(modelSnapshotRoot(cacheRoot, model), model.revision)
  try {
    const signatureParts = []
    for (const [relativePath, expected] of Object.entries(files)) {
      const filePath = path.join(snapshot, relativePath)
      const stat = await fs.stat(filePath)
      if (!stat.isFile() || stat.size !== expected.size) return null
      signatureParts.push(`${relativePath}:${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`)
    }
    const signature = signatureParts.join('|')
    const cacheKey = `${snapshot}\0${signature}`
    if (validationCache.has(cacheKey)) return snapshot
    const [config, encoder] = await Promise.all([
      fs.readFile(path.join(snapshot, 'config.json'), 'utf8').then(JSON.parse),
      fs.readFile(path.join(snapshot, 'encoder_config/config.json'), 'utf8').then(JSON.parse),
    ])
    if (!isPinnedConfiguration(config, encoder)) return null
    for (const [relativePath, expected] of Object.entries(files)) {
      if (await sha256(path.join(snapshot, relativePath)) !== expected.sha256) return null
    }
    validationCache.clear()
    validationCache.set(cacheKey, true)
    return snapshot
  } catch {
    return null
  }
}
