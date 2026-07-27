import { Database } from "@opencode-ai/core/database/database"
import { Context, Duration, Effect, Fiber, Layer, Scope, SynchronizedRef } from "effect"

import { CronJobs } from "./jobs"
import { CronExecutor } from "./executor"

// ─── Config ─────────────────────────────────────────────────────────────────

function maxParallel(): number {
  const env = process.env["OPENCODE_CRON_MAX_PARALLEL"]
  if (env) {
    const n = Number.parseInt(env, 10)
    if (!Number.isNaN(n) && n > 0) return n
  }
  return 5
}

function shutdownTimeoutMs(): number {
  const env = process.env["OPENCODE_CRON_SHUTDOWN_TIMEOUT_MS"]
  if (env) {
    const n = Number.parseInt(env, 10)
    if (!Number.isNaN(n) && n > 0) return n
  }
  return 30_000
}

// ─── Pure Functions ─────────────────────────────────────────────────────────

export interface WorkdirPartition<T extends { id: string; workdir: string | null } = { id: string; workdir: string | null }> {
  serial: T[]
  parallel: T[]
}

/**
 * Partition jobs by workdir.
 * Jobs with a workdir go into `serial` (must execute serially per workdir).
 * Jobs without a workdir go into `parallel` (may execute concurrently).
 */
export function partitionByWorkdir<T extends { id: string; workdir: string | null }>(
  jobs: T[],
): WorkdirPartition<T> {
  const serial: T[] = []
  const parallel: T[] = []
  for (const job of jobs) {
    if (job.workdir) {
      serial.push(job)
    } else {
      parallel.push(job)
    }
  }
  return { serial, parallel }
}

/**
 * Cap the number of parallel jobs to the concurrency limit.
 */
export function concurrencyCap<T>(items: T[], limit?: number): T[] {
  const cap = limit ?? maxParallel()
  return items.slice(0, cap)
}

// ─── Service ────────────────────────────────────────────────────────────────

export interface Interface {
  readonly tick: () => Effect.Effect<void, never, Scope.Scope>
  readonly start: () => Effect.Effect<void, never, Scope.Scope>
  readonly shutdown: () => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/CronScheduler") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const cronJobs = yield* CronJobs.Service
    const executor = yield* CronExecutor.Service

    // Track in-flight fibers for graceful shutdown
    const inFlight = yield* SynchronizedRef.make<Map<string, Fiber.Fiber<void>>>(new Map())

    // Execute a single job via the CronExecutor — silence any errors
    const executeJob = (job: CronJobs.CronJob): Effect.Effect<void> =>
      executor.execute(job).pipe(
        Effect.catch(() => Effect.void),
      )

    // Auto-start the tick loop when the service is created
    yield* Effect.logInfo("Cron ticker started")

    const tick: Interface["tick"] = () =>
      Effect.gen(function* () {
        const due = (yield* cronJobs.getDueJobs().pipe(
          Effect.catch(() => Effect.succeed([] as never)),
        )) as CronJobs.CronJob[]
        if (due.length === 0) return

        // Filter by grace window
        const now = Date.now()
        const withinGrace = due.filter((job) => {
          if (job.next_run_at === null) return false
          const graceMs = CronJobs.computeGraceMs(job.schedule_kind, job.schedule_expr)
          return now - job.next_run_at <= graceMs
        })

        if (withinGrace.length === 0) return

        // Advance next_run_at BEFORE execution (at-most-once)
        for (const job of withinGrace) {
          yield* cronJobs.advanceNextRun(job.id).pipe(Effect.ignore)
        }

        // Partition by workdir
        const partition = partitionByWorkdir(withinGrace)

        // Execute serial jobs (workdir) one at a time
        for (const job of partition.serial) {
          yield* executeJob(job)
        }

        // Execute parallel jobs (non-workdir) with concurrency cap
        const toFork = concurrencyCap(partition.parallel)
        const fiberScope = yield* Scope.Scope
        const fibers: Array<Fiber.Fiber<void>> = []
        for (const job of toFork) {
          const fiber: Fiber.Fiber<void> = yield* executeJob(job).pipe(Effect.forkIn(fiberScope))
          yield* SynchronizedRef.update(inFlight, (state) => {
            const next = new Map(state)
            next.set(job.id, fiber)
            return next
          })
          fibers.push(fiber)
        }

        // Await and clean up completed fibers
        for (const index of fibers.keys()) {
          yield* Fiber.await(fibers[index]!)
          const job = toFork[index]!
          yield* SynchronizedRef.update(inFlight, (state) => {
            const next = new Map(state)
            next.delete(job.id)
            return next
          })
        }
      })
    

    const shutdown = Effect.fn("CronScheduler.shutdown")(() =>
      Effect.gen(function* () {
        const fibers = yield* SynchronizedRef.get(inFlight)
        if (fibers.size === 0) return

        yield* Effect.logInfo(`Awaiting ${fibers.size} in-flight cron jobs (${shutdownTimeoutMs()}ms timeout)`)

        const deadline = Date.now() + shutdownTimeoutMs()
        for (const [id, fiber] of fibers) {
          const remaining = deadline - Date.now()
          if (remaining <= 0) {
            yield* Effect.logWarning(`Cron job ${id} timed out, interrupting`)
            yield* Fiber.interrupt(fiber)
          } else {
            yield* Fiber.await(fiber).pipe(
              Effect.timeoutOrElse({
                duration: Duration.millis(remaining),
                orElse: () => {
                  Effect.logWarning(`Cron job ${id} did not complete within timeout`)
                  return Fiber.interrupt(fiber)
                },
              }),
            )
          }
        }

        yield* SynchronizedRef.set(inFlight, new Map())
        yield* Effect.logInfo("All cron jobs completed or interrupted")
      }),
    )

    let started = false

    const start: Interface["start"] = () =>
      Effect.gen(function* () {
        if (started) return
        started = true
        yield* tickLoop(tick).pipe(Effect.forkScoped)
      })

    // Fork the tick loop into the layer's scope (auto-start with server lifecycle)
    yield* Effect.forkScoped(tickLoop(tick))
    started = true

    return {
      tick,
      start,
      shutdown,
    } as Interface
  }),
)

/**
 * The tick loop: runs `tick()` every 60 seconds, forever.
 * Must be forked into a scope for lifecycle management.
 */
function tickLoop(tick: () => Effect.Effect<void, never, Scope.Scope>): Effect.Effect<never, never, Scope.Scope> {
  return Effect.repeat(tick(), { while: () => true, times: Infinity }).pipe(
    Effect.delay(Duration.minutes(1)),
  ) as unknown as Effect.Effect<never>
}

export const defaultLayer = layer.pipe(
  Layer.provide(CronJobs.defaultLayer),
  Layer.provide(CronExecutor.defaultLayer),
  Layer.provide(Database.defaultLayer),
)

export * as CronScheduler from "./scheduler"
