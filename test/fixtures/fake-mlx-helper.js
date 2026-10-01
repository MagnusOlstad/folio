#!/usr/bin/env node
import fs from 'node:fs/promises'
import path from 'node:path'
import readline from 'node:readline'

const args = process.argv.slice(2)
function argument(name) {
  const index = args.indexOf(name)
  return index < 0 ? null : args[index + 1] || null
}

const task = argument('--task')
const model = argument('--model')
const revision = argument('--revision')
const modelDirectory = argument('--model-directory')
let memory = { activeBytes: 128_000_000, cacheBytes: 32_000_000, peakResidentBytes: 256_000_000 }
const cacheRoot = process.env.HF_HUB_CACHE

async function appendLog(entry) {
  const logPath = process.env.FOLIO_MLX_FIXTURE_LOG
  if (!logPath) return
  await fs.mkdir(path.dirname(logPath), { recursive: true })
  await fs.appendFile(logPath, `${JSON.stringify(entry)}\n`)
}

async function readControl() {
  const file = process.env.FOLIO_MLX_FIXTURE_CONTROL
  if (!file) return {}
  try { return JSON.parse(await fs.readFile(file, 'utf8')) } catch { return {} }
}

async function ensureSnapshot() {
  if (modelDirectory || !cacheRoot) return
  const directory = path.join(cacheRoot, `models--${model.replaceAll('/', '--')}`, 'snapshots', revision)
  await fs.mkdir(directory, { recursive: true })
  await Promise.all([
    fs.writeFile(path.join(directory, 'config.json'), JSON.stringify({ model_type: task === 'generation' ? 'gemma4' : 'embeddinggemma' })),
    fs.writeFile(path.join(directory, 'tokenizer.json'), '{}'),
    fs.writeFile(path.join(directory, 'tokenizer_config.json'), '{}'),
    fs.writeFile(path.join(directory, 'model.safetensors'), 'fake model weights'),
  ])
}

function classify(content) {
  if (content.includes('Path override todo')) return { kind: 'todo', path: ['wrong'], title: 'Path Override Todo', type: 'Task', description: 'A deliberately misclassified task.', tags: ['task'] }
  if (content.includes('Aurora extension evidence')) return { kind: 'note', path: ['projects'], title: 'Aurora Budget Update', type: 'Update', description: 'The note adds an update to Project Aurora.', tags: ['project-plans'] }
  if (content.includes('Project Aurora details')) return { kind: 'note', path: ['projects'], title: 'Project Aurora', type: 'Project', description: 'Details about Project Aurora.', tags: ['prosjekt', 'nordisk'] }
  if (content.includes('Planning note')) return { kind: 'note', path: ['planning'], title: 'Planning Note', type: 'Plan', description: 'Planning details that reference a future project.', tags: ['planlegging', 'økonomi'] }
  if (content.includes('Long archive')) return { kind: 'note', path: ['research'], title: 'Long Archive', type: 'Research', description: 'A long note used to verify complete chunk retrieval.', tags: ['arkiv', 'langtekst'] }
  if (content.includes('Semantic neighbor')) return { kind: 'note', path: ['ideas'], title: 'Semantic Neighbor', type: 'Idea', description: 'A separate concept with similar meaning.', tags: ['idé', 'søk'] }
  if (content.includes('Attribution description')) return { kind: 'note', path: ['attribution'], title: 'Attribution Description', type: 'Note', description: 'Agent description.', tags: ['agent'] }
  if (content.includes('Attribution title')) return { kind: 'note', path: ['attribution'], title: 'Attribution Title', type: 'Note', description: 'Agent title.', tags: ['agent'] }
  if (content.includes('Attribution path')) return { kind: 'note', path: ['attribution'], title: 'Attribution Path', type: 'Note', description: 'Agent path.', tags: ['agent'] }
  if (content.includes('Marker collision capture')) return { kind: 'note', path: ['marker-tests'], title: 'Captured note', type: 'Note', description: 'Marker placement regression.', tags: [] }
  return { kind: 'note', path: ['meeting-notes', 'morning-meeting'], title: 'Morning<br>launch meeting', type: 'Meeting Note', description: 'The morning meeting covered the launch<br />and its follow-up.', tags: ['launch', 'morning'] }
}

function noteFromPrompt(messages) {
  const content = messages?.at(-1)?.content || ''
  const match = content.match(/<new-note>\n([\s\S]*?)\n<\/new-note>/)
  return match?.[1] || content
}

async function generate(messages) {
  const content = messages?.map((message) => message.content || '').join('\n') || ''
  const control = await readControl()
  if (control.classificationOffline && !content.includes('grounded research assistant')) throw new Error('fixture generation unavailable')
  const note = noteFromPrompt(messages)
  const steering = content.match(/<filing-steering>\n([\s\S]*?)\n<\/filing-steering>/)?.[1] || ''
  const text = control.emptyAnswer
    ? ''
    : content.includes('grounded research assistant')
      ? 'The launch is planned for Friday.'
      : JSON.stringify({ concept: classify(`${steering}\n${note}`) })
  await appendLog({ operation: 'generate', task, model, messages, text })
  return text
}

async function embed(input) {
  const values = Array.isArray(input) ? input : [input]
  const control = await readControl()
  const embeddings = control.invalidEmbeddingResponse
    ? []
    : values.map((value) => String(value).includes('hidden constellation') ? [0, 1, 0] : [1, 0, 0])
  await appendLog({ operation: 'embed', task, model, input: values, embeddings })
  return embeddings
}

await ensureSnapshot()
await appendLog({ event: 'ready', task, model, revision, modelDirectory, memory })
const startupControl = await readControl()
if (startupControl.exitBeforeReady) {
  process.stderr.write('fixture exited before readiness\n')
  process.exit(Number(startupControl.exitBeforeReady) || 23)
}
if (startupControl.readyDelayMs) await new Promise((resolve) => setTimeout(resolve, startupControl.readyDelayMs))
if (process.env.FOLIO_MLX_FIXTURE_INVALID_JSON === '1') process.stdout.write('not-json\n')
process.stdout.write(`${JSON.stringify({ event: 'ready', model, task, memory })}\n`)

const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity })
for await (const line of lines) {
  if (!line.trim()) continue
  let request
  try { request = JSON.parse(line) } catch {
    process.stdout.write(`${JSON.stringify({ id: null, error: 'invalid request JSON', memory })}\n`)
    continue
  }
  const control = await readControl()
  if (control.exitOnOperation === request.operation) process.exit(Number(control.exitCode) || 19)
  if (request.operation === 'shutdown' && control.hangShutdown) continue
  if (control.operationDelayMs) await new Promise((resolve) => setTimeout(resolve, control.operationDelayMs))
  try {
    let response
    if (request.operation === 'status') response = { id: request.id, status: 'ready', memory }
    else if (request.operation === 'shutdown') {
      memory = { ...memory, cacheBytes: 0 }
      response = control.shutdownError
        ? { id: request.id, error: control.shutdownError, memory }
        : { id: request.id, status: 'shutdown', memory }
    }
    else if (request.operation === 'generate' && control.failGenerate) response = { id: request.id, error: 'fixture generation error', memory }
    else if (request.operation === 'generate') response = { id: request.id, text: await generate(request.messages), memory }
    else if (request.operation === 'embed') response = { id: request.id, embeddings: await embed(request.input), memory }
    else response = { id: request.id, error: `unknown operation: ${request.operation}`, memory }
    await appendLog({ event: 'request', operation: request.operation, id: request.id })
    await appendLog({ event: 'response', operation: request.operation, error: response.error, memory: response.memory })
    process.stdout.write(`${JSON.stringify(response)}\n`)
    if (request.operation === 'shutdown') process.exit(0)
  } catch (error) {
    await appendLog({ event: 'response', operation: request.operation, error: error.message, memory })
    process.stdout.write(`${JSON.stringify({ id: request.id, error: error.message, memory })}\n`)
  }
}
