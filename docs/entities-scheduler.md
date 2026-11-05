# MLX activity scheduler contract

`createMlxActivityScheduler({ backgroundCooldownMs = 30_000, maxPendingBackground = 1 })` returns `run(operation, { priority, signal })`, `snapshot()`, and `close()`.

All exclusive non-embedding model operations should enter through `run`; `interactive` is the default priority. A background operation represents one bounded unit, such as one extraction chunk. Interactive operations are admitted FIFO before waiting background work, and a running background unit yields when it completes. The scheduler does not preempt active native inference; callers use bounded chunks and the external activity's abort signal for active cancellation.

At most `maxPendingBackground` background operations may wait. Additional work rejects with `MLX_BACKGROUND_QUEUE_FULL`; callers should coalesce note requests and retry after progress. The 30-second default cooldown begins after each interactive operation completes. A waiting background operation stays queued during this interval, with one timer and no polling, so short interactive bursts do not repeatedly switch the resident model.

`createMlxService` uses the scheduler for every non-embedding MLX activity, including generation, OCR, Whisper, and entity-model work. `extractEntities` and `planEntityChunks` forward `background: true` and their abort signal into admission; other callers receive interactive priority. Embeddings retain their existing concurrent path. `activitySnapshot()` exposes queue and cooldown state. Service shutdown rejects queued activities, terminates active helper workers and closes external adapters, then waits for the active exclusive operation to settle. Activity counters cover admission through completion, including queued cancellation and capacity rejection.

An abort signal cancels a queued operation with `MLX_ACTIVITY_CANCELLED`. Once admitted, cancellation remains the operation owner's responsibility. `close()` rejects queued work with `MLX_SCHEDULER_CLOSED`, clears cooldown timers, and resolves after any active operation drains. `snapshot()` reports active priority, queue counts, closure, and the remaining background cooldown.
