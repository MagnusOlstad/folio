import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'

export function createMlxWorker({ id, definition, executable, cacheRoot, modelDirectory, onExit }) {
  const args = ['--task', definition.task, '--model', definition.repository, '--revision', definition.revision]
  if (definition.task === 'transcription') args.push('--operation', 'transcribe')
  if (modelDirectory) args.push('--model-directory', modelDirectory)
  const child = spawn(executable, args, {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, HF_HUB_CACHE: cacheRoot },
  })
  let resolveClosed
  const closedProcess = new Promise((resolve) => { resolveClosed = resolve })
  let stdout = ''
  let stderr = ''
  let readyResolve
  let readyReject
  const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject })
  let readySettled = false
  const readyTimer = setTimeout(() => {
    if (readySettled) return
    readySettled = true
    readyReject(new Error('The MLX model did not finish loading or downloading in time.'))
    child.kill()
  }, 30 * 60_000)
  const pending = new Map()
  const worker = {
    child,
    closedProcess,
    id,
    ready,
    memory: null,
    downloadProgress: null,
    closed: false,
    request(operation, payload = {}, timeoutMs = 120_000) {
      if (worker.closed || !child.stdin.writable) return Promise.reject(new Error('The MLX worker is not running.'))
      const requestId = randomUUID()
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(requestId)
          reject(new Error('The MLX model request timed out.'))
          child.kill()
        }, timeoutMs)
        pending.set(requestId, { resolve, reject, timer })
        child.stdin.write(`${JSON.stringify({ id: requestId, operation, ...payload })}\n`, (error) => {
          if (!error) return
          clearTimeout(timer)
          pending.delete(requestId)
          reject(error)
        })
      })
    },
    finish() {
      if (worker.closed) return
      worker.closed = true
      for (const { reject, timer } of pending.values()) {
        clearTimeout(timer)
        reject(new Error('The MLX worker stopped before replying.'))
      }
      pending.clear()
    },
  }
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk) => {
    stdout += chunk
    for (;;) {
      const newline = stdout.indexOf('\n')
      if (newline < 0) break
      const line = stdout.slice(0, newline)
      stdout = stdout.slice(newline + 1)
      let message
      try { message = JSON.parse(line) } catch {
        readyReject(new Error('The MLX helper returned invalid JSON.'))
        continue
      }
      if (message.event === 'ready') {
        readySettled = true
        clearTimeout(readyTimer)
        worker.memory = message.memory || null
        readyResolve(message)
        continue
      }
      if (message.event === 'download-progress') {
        if (Number.isFinite(message.downloadedBytes) && Number.isFinite(message.totalBytes)
          && message.downloadedBytes >= 0 && message.totalBytes > 0) {
          worker.downloadProgress = {
            downloadedBytes: Math.max(worker.downloadProgress?.downloadedBytes || 0, message.downloadedBytes),
            totalBytes: message.totalBytes,
          }
        }
        continue
      }
      const pendingRequest = pending.get(message.id)
      if (!pendingRequest) continue
      clearTimeout(pendingRequest.timer)
      pending.delete(message.id)
      if (message.memory) worker.memory = message.memory
      if (message.error) pendingRequest.reject(new Error(message.error))
      else pendingRequest.resolve(message)
    }
  })
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk) => { stderr = `${stderr}${chunk}`.slice(-8_000) })
  child.once('error', (error) => {
    readySettled = true
    clearTimeout(readyTimer)
    readyReject(error)
    worker.finish()
  })
  child.once('close', (code, signal) => {
    resolveClosed()
    worker.finish()
    onExit(worker)
    if (!readySettled) {
      readySettled = true
      clearTimeout(readyTimer)
      readyReject(new Error(stderr.trim() || `The MLX helper exited (${code ?? signal}).`))
    }
  })
  return worker
}

export async function terminateMlxWorker(worker, graceMs = 1_000) {
  if (worker.child.exitCode === null && worker.child.signalCode === null) {
    worker.child.kill('SIGTERM')
    let timer
    const exited = await Promise.race([worker.closedProcess.then(() => true), new Promise((resolve) => {
      timer = setTimeout(() => resolve(false), graceMs)
    })])
    clearTimeout(timer)
    if (!exited) worker.child.kill('SIGKILL')
  }
  await worker.closedProcess
}
