const ollamaUrl = process.env.OLLAMA_URL || 'http://127.0.0.1:11434'
const requiredModels = [
  process.env.OLLAMA_CLASSIFIER_MODEL || 'llama3.2:3b',
  process.env.OLLAMA_EMBED_MODEL || 'embeddinggemma',
  process.env.OLLAMA_ANSWER_MODEL || 'llama3.2:3b',
]

function hasModel(installed, name) {
  return installed.some((model) => model === name || model.startsWith(`${name}:`))
}

export default async function globalSetup() {
  let installed
  try {
    const response = await fetch(new URL('/api/tags', ollamaUrl), { signal: AbortSignal.timeout(3_000) })
    if (!response.ok) throw new Error(`Ollama responded with ${response.status}`)
    installed = (await response.json()).models?.map((model) => model.name) || []
  } catch (error) {
    throw new Error(
      `The local e2e suite needs a running Ollama at ${ollamaUrl}, but it wasn't reachable (${error.message}).\n` +
      'Start it with `ollama serve` (or the desktop app), or skip this suite with SKIP_OLLAMA_E2E=1.',
    )
  }

  const missing = requiredModels.filter((name) => !hasModel(installed, name))
  if (missing.length) {
    throw new Error(
      `The local e2e suite needs these Ollama models installed: ${missing.join(', ')}.\n` +
      `Install them with: ${missing.map((name) => `ollama pull ${name}`).join(' && ')}`,
    )
  }
}
