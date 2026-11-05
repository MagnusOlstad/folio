import assert from 'node:assert/strict'
import test from 'node:test'
import { createMlxActivityScheduler } from '../server/mlx/scheduler.js'

function deferred() {
  let resolve
  const promise = new Promise((done) => { resolve = done })
  return { promise, resolve }
}

function fakeClock() {
  let time = 0
  let nextId = 0
  const timers = new Map()
  return {
    now: () => time,
    scheduleTimer(callback, delay) {
      const id = ++nextId
      timers.set(id, { callback, dueAt: time + delay })
      return id
    },
    cancelTimer(id) { timers.delete(id) },
    async advance(milliseconds) {
      time += milliseconds
      while (true) {
        const due = [...timers.entries()].filter(([, timer]) => timer.dueAt <= time).sort((a, b) => a[1].dueAt - b[1].dueAt)[0]
        if (!due) break
        timers.delete(due[0])
        due[1].callback()
        await Promise.resolve()
      }
    },
  }
}

test('interactive activities overtake queued background chunks between units', async () => {
  const scheduler = createMlxActivityScheduler({ backgroundCooldownMs: 0 })
  const firstChunkGate = deferred()
  const firstStarted = deferred()
  const order = []
  const first = scheduler.run(async () => { order.push('background-1'); firstStarted.resolve(); await firstChunkGate.promise }, { priority: 'background' })
  await firstStarted.promise
  const second = scheduler.run(() => { order.push('background-2') }, { priority: 'background' })
  const interactive1 = scheduler.run(() => { order.push('interactive-1') })
  const interactive2 = scheduler.run(() => { order.push('interactive-2') })
  firstChunkGate.resolve()
  await Promise.all([first, second, interactive1, interactive2])
  assert.deepEqual(order, ['background-1', 'interactive-1', 'interactive-2', 'background-2'])
  await scheduler.close()
})

test('background work observes the warm-model cooldown after interactive activity', async () => {
  const clock = fakeClock()
  const scheduler = createMlxActivityScheduler({ backgroundCooldownMs: 30_000, ...clock })
  await scheduler.run(() => {})
  let started = false
  const background = scheduler.run(() => { started = true }, { priority: 'background' })
  assert.equal(scheduler.snapshot().backgroundCooldown, true)
  assert.equal(scheduler.snapshot().backgroundCooldownRemainingMs, 30_000)
  await clock.advance(29_999)
  assert.equal(started, false)
  await clock.advance(1)
  await background
  assert.equal(started, true)
  await scheduler.close()
})

test('background waiting is bounded with actionable backpressure', async () => {
  const scheduler = createMlxActivityScheduler({ backgroundCooldownMs: 0, maxPendingBackground: 1 })
  const interactiveGate = deferred()
  const interactiveStarted = deferred()
  const active = scheduler.run(async () => { interactiveStarted.resolve(); await interactiveGate.promise })
  await interactiveStarted.promise
  const pending = scheduler.run(() => {}, { priority: 'background' })
  await assert.rejects(scheduler.run(() => {}, { priority: 'background' }), { code: 'MLX_BACKGROUND_QUEUE_FULL' })
  assert.equal(scheduler.snapshot().pendingBackground, 1)
  interactiveGate.resolve()
  await Promise.all([active, pending])
  await scheduler.close()
})

test('aborting a queued activity removes it from admission queues', async () => {
  const scheduler = createMlxActivityScheduler({ backgroundCooldownMs: 0 })
  const gate = deferred()
  const started = deferred()
  const active = scheduler.run(async () => { started.resolve(); await gate.promise })
  await started.promise
  const controller = new AbortController()
  const pending = scheduler.run(() => assert.fail('cancelled queued work must not run'), { priority: 'background', signal: controller.signal })
  controller.abort()
  await assert.rejects(pending, { code: 'MLX_ACTIVITY_CANCELLED' })
  assert.equal(scheduler.snapshot().pendingBackground, 0)
  gate.resolve()
  await active
  await scheduler.close()
})

test('close rejects pending work and waits for the active operation to drain', async () => {
  const scheduler = createMlxActivityScheduler({ backgroundCooldownMs: 0 })
  const gate = deferred()
  const started = deferred()
  const active = scheduler.run(async () => { started.resolve(); await gate.promise })
  await started.promise
  const pendingInteractive = scheduler.run(() => {})
  const pendingBackground = scheduler.run(() => {}, { priority: 'background' })
  const closing = scheduler.close()
  await assert.rejects(pendingInteractive, { code: 'MLX_SCHEDULER_CLOSED' })
  await assert.rejects(pendingBackground, { code: 'MLX_SCHEDULER_CLOSED' })
  assert.equal(scheduler.snapshot().closed, true)
  gate.resolve()
  await Promise.all([active, closing])
  await assert.rejects(scheduler.run(() => {}), { code: 'MLX_SCHEDULER_CLOSED' })
})
