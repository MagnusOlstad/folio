import { spawn } from 'node:child_process'

function helperError(value, fallback) {
  if (value && typeof value.error === 'string') return new Error(value.error)
  if (value && typeof value.message === 'string') return new Error(value.message)
  return new Error(fallback)
}

export function runHelper({ executable, args, cacheRoot, request, signal, onEvent, timeoutMs = 30 * 60_000 }) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, HF_HUB_CACHE: cacheRoot },
    })
    const closed = new Promise((resolve) => child.once('close', resolve))
    let stdout = ''
    let stderr = ''
    let ready = false
    let responseMessage = null
    let settled = false
    let timer = setTimeout(() => finish(new Error('The local MLX transcription operation timed out.')), timeoutMs)
    const finish = (error, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      if (error) {
        child.kill('SIGTERM')
        const shutdownTimer = setTimeout(() => child.kill('SIGKILL'), 2_000)
        void closed.then(() => { clearTimeout(shutdownTimer); reject(error) })
      } else {
        child.stdin.end()
        resolve(value)
      }
    }
    const abort = () => finish(Object.assign(new Error('Transcription was cancelled. Your audio file is saved and can be retried.'), { code: 'TRANSCRIPTION_CANCELLED' }))
    if (signal?.aborted) { abort(); return }
    signal?.addEventListener('abort', abort, { once: true })
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk) => { stderr = `${stderr}${chunk}`.slice(-8_000) })
    child.stdout.on('data', (chunk) => {
      stdout += chunk
      for (;;) {
        const newline = stdout.indexOf('\n')
        if (newline < 0) break
        const line = stdout.slice(0, newline)
        stdout = stdout.slice(newline + 1)
        let message
        try { message = JSON.parse(line) } catch { continue }
        if (message.event === 'download-progress') { onEvent?.(message); continue }
        if (message.event === 'transcription-progress') {
          if (request && message.id === request.id && Number.isInteger(message.percent)
            && message.percent >= 0 && message.percent <= 99) onEvent?.(message)
          continue
        }
        if (message.event === 'ready') {
          ready = true
          onEvent?.(message)
          if (request) child.stdin.write(`${JSON.stringify(request)}\n`)
          else child.stdin.end()
          continue
        }
        if (message.error) finish(helperError(message, 'The MLX transcription helper failed.'))
        else if (request && message.id === request.id) {
          responseMessage = message
          child.stdin.end()
          clearTimeout(timer)
          timer = setTimeout(() => {
            child.kill('SIGTERM')
            timer = setTimeout(() => child.kill('SIGKILL'), 2_000)
          }, 5_000)
        }
      }
    })
    child.once('error', (error) => finish(error))
    child.once('close', (code, closeSignal) => {
      if (settled) return
      if (responseMessage) {
        finish(code === 0 ? null : new Error(stderr.trim() || `The MLX helper exited unsuccessfully after transcription (${code ?? closeSignal}).`), responseMessage)
        return
      }
      finish(code === 0 && ready && !request
        ? null
        : new Error(stderr.trim() || `The MLX helper exited before completing (${code ?? closeSignal}).`), code === 0 && ready && !request ? { event: 'ready' } : undefined)
    })
  })
}
