import fs from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import path from 'node:path'

export function createGenerationSelection({ modelRoot, modelDefinitions, modelDefinition, withModelActivity, stopModel, status }) {
  const selectionPath = path.join(modelRoot, 'generation-model.json')

  async function selectedGenerationModel() {
    try {
      const saved = JSON.parse(await fs.readFile(selectionPath, 'utf8'))
      if (typeof saved.id === 'string' && modelDefinitions[saved.id]?.purpose === 'generation') return saved.id
    } catch { /* use the migrated default */ }
    return 'gemma4'
  }

  async function selectGenerationModel(id) {
    const definition = modelDefinition(id)
    if (definition.purpose !== 'generation') throw Object.assign(new Error('Choose a generation model.'), { statusCode: 400 })
    return withModelActivity(id, async () => {
      const previous = await selectedGenerationModel()
      if (previous !== id) await stopModel(previous)
      await fs.mkdir(modelRoot, { recursive: true })
      const temporaryPath = `${selectionPath}.${randomUUID()}.tmp`
      await fs.writeFile(temporaryPath, JSON.stringify({ id }), 'utf8')
      await fs.rename(temporaryPath, selectionPath)
      return status()
    }, { activate: false })
  }

  return { selectGenerationModel, selectedGenerationModel }
}
