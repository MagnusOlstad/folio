function schedulerError(code, message) {
  return Object.assign(new Error(message), { code })
}

function cancellationError() {
  return schedulerError('MLX_ACTIVITY_CANCELLED', 'The queued MLX activity was cancelled.')
}

/**
 * Admit exclusive non-embedding MLX activities with interactive priority.
 * Each background operation must be one bounded unit (for example, one entity
 * extraction chunk); completion yields admission to any waiting interactive
 * operation before another background unit can start.
 */
export function createMlxActivityScheduler({
  backgroundCooldownMs = 30_000,
  maxPendingBackground = 1,
  now = Date.now,
  scheduleTimer = setTimeout,
  cancelTimer = clearTimeout,
} = {}) {
  if (!Number.isFinite(backgroundCooldownMs) || backgroundCooldownMs < 0) {
    throw new RangeError('backgroundCooldownMs must be a non-negative number.')
  }
  if (!Number.isInteger(maxPendingBackground) || maxPendingBackground < 1) {
    throw new RangeError('maxPendingBackground must be a positive integer.')
  }

  const interactiveQueue = []
  const backgroundQueue = []
  let active = null
  let lastInteractiveFinishedAt = null
  let cooldownTimer = null
  let closed = false
  let closePromise = null

  function removeAbortListener(task) {
    if (task.signal && task.abortListener) task.signal.removeEventListener('abort', task.abortListener)
    task.abortListener = null
  }

  function clearCooldownTimer() {
    if (cooldownTimer !== null) cancelTimer(cooldownTimer)
    cooldownTimer = null
  }

  function rejectQueued(task, error) {
    removeAbortListener(task)
    task.reject(error)
  }

  function queuedTaskCount() {
    return interactiveQueue.length + backgroundQueue.length
  }

  function rejectAllQueued(error) {
    clearCooldownTimer()
    for (const task of interactiveQueue.splice(0)) rejectQueued(task, error)
    for (const task of backgroundQueue.splice(0)) rejectQueued(task, error)
  }

  function enqueue(task) {
    if (task.priority === 'interactive') interactiveQueue.push(task)
    else backgroundQueue.push(task)
    if (task.signal) {
      task.abortListener = () => {
        const queue = task.priority === 'interactive' ? interactiveQueue : backgroundQueue
        const index = queue.indexOf(task)
        if (index < 0) return
        queue.splice(index, 1)
        rejectQueued(task, cancellationError())
        if (!backgroundQueue.length) clearCooldownTimer()
        pump()
      }
      task.signal.addEventListener('abort', task.abortListener, { once: true })
      // The signal can be aborted between the initial validation and listener registration.
      if (task.signal.aborted) task.abortListener()
    }
    pump()
  }

  function nextBackgroundDelay() {
    if (lastInteractiveFinishedAt === null || backgroundCooldownMs === 0) return 0
    return Math.max(0, lastInteractiveFinishedAt + backgroundCooldownMs - now())
  }

  function pump() {
    if (closed || active) return
    if (interactiveQueue.length) {
      const task = interactiveQueue.shift()
      start(task)
      return
    }
    if (!backgroundQueue.length) {
      clearCooldownTimer()
      return
    }
    const delay = nextBackgroundDelay()
    if (delay > 0) {
      if (cooldownTimer === null) {
        cooldownTimer = scheduleTimer(() => {
          cooldownTimer = null
          pump()
        }, delay)
        cooldownTimer?.unref?.()
      }
      return
    }
    clearCooldownTimer()
    start(backgroundQueue.shift())
  }

  function start(task) {
    removeAbortListener(task)
    let finishActive
    const done = new Promise((resolve) => { finishActive = resolve })
    active = { priority: task.priority, done }
    void (async () => {
      let result
      let operationError
      let failed = false
      try { result = await task.operation() } catch (error) { failed = true; operationError = error }
      if (task.priority === 'interactive') lastInteractiveFinishedAt = now()
      active = null
      finishActive()
      pump()
      if (failed) task.reject(operationError)
      else task.resolve(result)
    })()
  }

  function run(operation, { priority = 'interactive', signal = null } = {}) {
    if (typeof operation !== 'function') return Promise.reject(new TypeError('An MLX activity operation is required.'))
    if (!['interactive', 'background'].includes(priority)) return Promise.reject(new TypeError('MLX activity priority must be interactive or background.'))
    if (closed) return Promise.reject(schedulerError('MLX_SCHEDULER_CLOSED', 'The MLX activity scheduler is shutting down.'))
    if (signal?.aborted) return Promise.reject(cancellationError())
    if (priority === 'background' && backgroundQueue.length >= maxPendingBackground) {
      return Promise.reject(schedulerError('MLX_BACKGROUND_QUEUE_FULL', 'Background MLX work is at capacity. Retry after current work completes.'))
    }

    return new Promise((resolve, reject) => enqueue({ operation, priority, signal, resolve, reject, abortListener: null }))
  }

  function close() {
    if (closePromise) return closePromise
    closed = true
    rejectAllQueued(schedulerError('MLX_SCHEDULER_CLOSED', 'Queued MLX activity was cancelled because the scheduler is shutting down.'))
    closePromise = active ? active.done : Promise.resolve()
    return closePromise
  }

  function snapshot() {
    const delay = backgroundQueue.length ? nextBackgroundDelay() : 0
    return {
      closed,
      activePriority: active?.priority || null,
      pendingInteractive: interactiveQueue.length,
      pendingBackground: backgroundQueue.length,
      backgroundCooldown: backgroundQueue.length > 0 && delay > 0,
      backgroundCooldownRemainingMs: delay,
      pending: queuedTaskCount(),
    }
  }

  return { run, snapshot, close }
}
