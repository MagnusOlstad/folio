import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { createApp, createRuntime } from './app.js'

export const reuseExistingClassificationPath = (...args) => createRuntime().reuseExistingClassificationPath(...args)
export const existingClassificationGuide = (...args) => createRuntime().existingClassificationGuide(...args)
export const existingTagGuide = (...args) => createRuntime().existingTagGuide(...args)

export function startServer(requestedPort) {
  const runtime = createRuntime()
  const serverPort = requestedPort ?? runtime.port
  return createApp(runtime).then((app) => new Promise((resolve, reject) => {
    const server = app.listen(serverPort, '127.0.0.1', () => {
      const address = server.address()
      const listeningPort = typeof address === 'object' && address ? address.port : serverPort
      console.log(`OKF Notetaker API listening on http://127.0.0.1:${listeningPort}`)
      resolve(server)
    })
    server.once('error', reject)
  }))
}

const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isDirectRun) await startServer()
