import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { performance } from 'node:perf_hooks'

import { createHistoryService } from '../server/history/service.js'

const fileCount = Math.max(1, Number(process.env.FOLIO_HISTORY_BENCH_FILES || 10_000))
const commitCount = Math.max(0, Number(process.env.FOLIO_HISTORY_BENCH_COMMITS || 5_000))

function percentile(values, ratio) {
  if (!values.length) return 0
  const ordered = [...values].sort((left, right) => left - right)
  return ordered[Math.min(ordered.length - 1, Math.ceil(ordered.length * ratio) - 1)]
}
let root = null
try {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'folio-history-bench-'))
  const bundleRoot = path.join(root, 'bundle')
  await fs.mkdir(bundleRoot)
  const files = []
  for (let index = 0; index < fileCount; index += 1) {
    const filepath = path.join(bundleRoot, `note-${String(index).padStart(5, '0')}.md`)
    files.push(filepath)
  }
  await Promise.all(files.map((filepath, index) => fs.writeFile(filepath, `---\ntitle: Note ${index}\nstatus: stable\n---\nBody ${index}\n`)))
  await fs.mkdir(path.join(bundleRoot, '.git', 'objects'), { recursive: true })
  await fs.writeFile(path.join(bundleRoot, '.git', 'objects', 'benchmark.md'), '# User Git metadata\n')
  await fs.writeFile(path.join(bundleRoot, '.gitignore'), 'note-*.md\n')
  const runtime = {
    bundleRoot,
    historyGitDir: path.join(bundleRoot, '.folio', 'history.git'),
    legacyHistoryGitDir: path.join(root, 'state', 'history.git'),
    listBundleMarkdownFiles: async () => files,
    parseMarkdownFile: (markdown) => ({ title: '', description: '', tags: [], status: '', staleAfter: null, content: markdown, frontmatter: {} }),
  }
  const history = createHistoryService(runtime)
  const started = performance.now()
  await history.reconcile('Baseline')
  const baselineMs = performance.now() - started
  const checkpoints = []
  for (let index = 0; index < commitCount; index += 1) {
    const id = `/note-${String(index % fileCount).padStart(5, '0')}.md`
    await fs.appendFile(path.join(bundleRoot, id.slice(1)), `Update ${index}\n`)
    const checkpointStarted = performance.now()
    await history.reconcile(`Update ${index}`, [id])
    checkpoints.push(performance.now() - checkpointStarted)
  }
  const targetId = '/note-00000.md'
  const pageStarted = performance.now()
  const page = await history.entries(targetId)
  const historyPageMs = performance.now() - pageStarted
  const versionStarted = performance.now()
  if (page.entries[0]) await history.version(targetId, page.entries[0].revision)
  const versionDiffMs = performance.now() - versionStarted
  const checkpointP95Ms = percentile(checkpoints, 0.95)
  console.log(JSON.stringify({
    fileCount,
    commitCount,
    baselineMs: Math.round(baselineMs),
    checkpointP95Ms: Math.round(checkpointP95Ms),
    historyPageMs: Math.round(historyPageMs),
    versionDiffMs: Math.round(versionDiffMs),
    checkpointP95Under500ms: checkpointP95Ms < 500,
    historyPageAndVersionDiffUnder750ms: historyPageMs < 750 && versionDiffMs < 750,
  }, null, 2))
} finally {
  if (root) await fs.rm(root, { recursive: true, force: true })
}
