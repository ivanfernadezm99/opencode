import { Database } from "@opencode-ai/core/database/database"
import { CronJobTable } from "@opencode-ai/core/cron/cron-job.sql"
import { and, eq, lte, sql } from "drizzle-orm"
import { Context, Effect, Layer, Schema } from "effect"
import * as CronParser from "cron-parser"

// ─── Schema Types ───────────────────────────────────────────────────────────

export class CronJob extends Schema.Class<CronJob>("CronJob")({
  id: Schema.String,
  name: Schema.NullOr(Schema.String),
  prompt: Schema.String,
  schedule_kind: Schema.String,
  schedule_expr: Schema.String,
  enabled: Schema.Number,
  state: Schema.String,
  next_run_at: Schema.NullOr(Schema.Number),
  last_run_at: Schema.NullOr(Schema.Number),
  last_status: Schema.NullOr(Schema.String),
  last_error: Schema.NullOr(Schema.String),
  model: Schema.NullOr(Schema.String),
  skills: Schema.NullOr(Schema.String),
  workdir: Schema.NullOr(Schema.String),
  repeat_times: Schema.NullOr(Schema.Number),
  repeat_done: Schema.Number,
  notify: Schema.Number,
  time_created: Schema.Number,
  time_updated: Schema.Number,
}) {}

export class CreateInput extends Schema.Class<CreateInput>("CronJob.CreateInput")({
  prompt: Schema.String,
  schedule_kind: Schema.String,
  schedule_expr: Schema.String,
  name: Schema.optional(Schema.String),
  model: Schema.optional(Schema.String),
  skills: Schema.optional(Schema.String),
  workdir: Schema.optional(Schema.String),
  repeat_times: Schema.optional(Schema.Number),
  next_run_at: Schema.optional(Schema.Number),
  enabled: Schema.optional(Schema.Number),
  notify: Schema.optional(Schema.Number),
}) {}

export class CronJobServiceError extends Schema.TaggedErrorClass<CronJobServiceError>()(
  "CronJobServiceError",
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

// ─── Pure Functions ─────────────────────────────────────────────────────────

/**
 * Compute the next run time for a cron job.
 * Returns `null` when the expression is invalid or cannot be parsed.
 *
 * @param job - The job schedule definition
 * @param baseTime - Optional base time (defaults to Date.now())
 * @param tz - Optional timezone (defaults to system timezone)
 */
export function computeNextRun(
  job: { schedule_kind: string; schedule_expr: string },
  baseTime?: Date,
  tz?: string,
): Date | null {
  const now = baseTime ?? new Date()
  try {
    switch (job.schedule_kind) {
      case "cron": {
        const resolvedTz = tz ?? Intl.DateTimeFormat().resolvedOptions().timeZone
        const interval = CronParser.parseExpression(job.schedule_expr, {
          currentDate: now,
          tz: resolvedTz,
        })
        return interval.next().toDate()
      }
      case "interval": {
        const seconds = Number(job.schedule_expr)
        if (Number.isNaN(seconds) || seconds <= 0) return null
        return new Date(now.getTime() + seconds * 1000)
      }
      case "once": {
        const date = new Date(job.schedule_expr)
        if (Number.isNaN(date.getTime())) return null
        return date
      }
      default:
        return null
    }
  } catch {
    return null
  }
}

/**
 * Compute the grace period in milliseconds for a job schedule.
 *
 * For `once`-kind jobs: returns 120_000ms (2 minutes).
 * For recurring jobs: returns `max(120_000, min(period / 2, 7_200_000))`.
 */
export function computeGraceMs(scheduleKind: string, scheduleExpr: string): number {
  if (scheduleKind === "once") return 120_000

  let periodMs: number
  if (scheduleKind === "interval") {
    periodMs = Number(scheduleExpr) * 1000
  } else {
    // cron — compute period as time between two consecutive fires
    periodMs = cronPeriodMs(scheduleExpr)
  }

  if (Number.isNaN(periodMs) || periodMs <= 0) return 120_000
  return Math.max(120_000, Math.min(periodMs / 2, 7_200_000))
}

/**
 * Compute the period (in ms) between two consecutive fire times of a cron expression.
 */
export function cronPeriodMs(expr: string): number {
  try {
    const interval = CronParser.parseExpression(expr, { currentDate: new Date() })
    const a = interval.next().toDate().getTime()
    const b = interval.next().toDate().getTime()
    return b - a
  } catch {
    return 120_000 // fallback
  }
}

// ─── Service ────────────────────────────────────────────────────────────────

export interface Interface {
  readonly create: (input: CreateInput) => Effect.Effect<CronJob, CronJobServiceError>
  readonly get: (id: string) => Effect.Effect<CronJob | null, CronJobServiceError>
  readonly list: () => Effect.Effect<CronJob[], CronJobServiceError>
  readonly update: (id: string, data: Partial<{
    name: string
    prompt: string
    schedule_kind: string
    schedule_expr: string
    enabled: number
    state: string
    next_run_at: number | null
    model: string | null
    skills: string | null
    workdir: string | null
  }>) => Effect.Effect<CronJob, CronJobServiceError>
  readonly remove: (id: string) => Effect.Effect<void, CronJobServiceError>
  readonly getDueJobs: () => Effect.Effect<CronJob[], CronJobServiceError>
  readonly advanceNextRun: (id: string) => Effect.Effect<CronJob, CronJobServiceError>
  readonly markJobRun: (id: string, status: string, error?: string) => Effect.Effect<void, CronJobServiceError>
  readonly markRunning: (id: string) => Effect.Effect<void, CronJobServiceError>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/CronJobs") {}

function rowToJob(row: typeof CronJobTable.$inferSelect): CronJob {
  return new CronJob({
    id: row.id,
    name: row.name ?? null,
    prompt: row.prompt,
    schedule_kind: row.schedule_kind,
    schedule_expr: row.schedule_expr,
    enabled: row.enabled,
    state: row.state,
    next_run_at: row.next_run_at ?? null,
    last_run_at: row.last_run_at ?? null,
    last_status: row.last_status ?? null,
    last_error: row.last_error ?? null,
    model: row.model ?? null,
    skills: row.skills ?? null,
    workdir: row.workdir ?? null,
    repeat_times: row.repeat_times ?? null,
    repeat_done: row.repeat_done,
    notify: row.notify,
    time_created: row.time_created,
    time_updated: row.time_updated,
  })
}

const mapError = <A>(effect: Effect.Effect<A, unknown>) =>
  effect.pipe(
    Effect.mapError((cause) => new CronJobServiceError({ message: "Database operation failed", cause })),
  )

function now() {
  return Date.now()
}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const { db } = yield* Database.Service

    const create = Effect.fn("CronJobs.create")((input: CreateInput) =>
      mapError(
        Effect.gen(function* () {
          const id = crypto.randomUUID()
          const time = now()
          const values: typeof CronJobTable.$inferInsert = {
            id,
            prompt: input.prompt,
            schedule_kind: input.schedule_kind,
            schedule_expr: input.schedule_expr,
            name: input.name ?? undefined,
            enabled: input.enabled ?? 1,
            model: input.model ?? undefined,
            skills: input.skills ?? undefined,
            workdir: input.workdir ?? undefined,
            repeat_times: input.repeat_times ?? undefined,
            next_run_at: input.next_run_at ?? undefined,
            notify: input.notify ?? 0,
            time_created: time,
            time_updated: time,
          }
          yield* db.insert(CronJobTable).values(values).run().pipe(Effect.orDie)
          const row = yield* db.select().from(CronJobTable).where(eq(CronJobTable.id, id)).get().pipe(
            Effect.orDie,
            Effect.map((r) => r!),
          )
          return rowToJob(row)
        }),
      ),
    )

    const get = Effect.fn("CronJobs.get")((id: string) =>
      mapError(
        db.select().from(CronJobTable).where(eq(CronJobTable.id, id)).get().pipe(
          Effect.orDie,
          Effect.map((row) => (row ? rowToJob(row) : null)),
        ),
      ),
    )

    const list = Effect.fn("CronJobs.list")(() =>
      mapError(
        db.select().from(CronJobTable).orderBy(sql`time_created ASC`).all().pipe(
          Effect.orDie,
          Effect.map((rows) => rows.map(rowToJob)),
        ),
      ),
    )

    const update = Effect.fn("CronJobs.update")(
      (id: string, data: Record<string, unknown>) =>
        mapError(
          Effect.gen(function* () {
            const updateData: Record<string, unknown> = {}
            if (data.name !== undefined) updateData.name = data.name
            if (data.prompt !== undefined) updateData.prompt = data.prompt
            if (data.schedule_kind !== undefined) updateData.schedule_kind = data.schedule_kind
            if (data.schedule_expr !== undefined) updateData.schedule_expr = data.schedule_expr
            if (data.enabled !== undefined) updateData.enabled = data.enabled
            if (data.state !== undefined) updateData.state = data.state
            if (data.next_run_at !== undefined) updateData.next_run_at = data.next_run_at
            if (data.model !== undefined) updateData.model = data.model
            if (data.skills !== undefined) updateData.skills = data.skills
            if (data.workdir !== undefined) updateData.workdir = data.workdir
            updateData.time_updated = now()
            yield* db.update(CronJobTable).set(updateData as typeof CronJobTable.$inferInsert).where(
              eq(CronJobTable.id, id),
            ).run().pipe(Effect.orDie)
            const row = yield* db.select().from(CronJobTable).where(eq(CronJobTable.id, id)).get().pipe(
              Effect.orDie,
              Effect.map((r) => r!),
            )
            return rowToJob(row)
          }),
        ),
    )

    const remove = Effect.fn("CronJobs.remove")((id: string) =>
      mapError(
        db.delete(CronJobTable).where(eq(CronJobTable.id, id)).run().pipe(Effect.orDie, Effect.asVoid),
      ),
    )

    const getDueJobs = Effect.fn("CronJobs.getDueJobs")(() =>
      mapError(
        db
          .select()
          .from(CronJobTable)
          .where(and(eq(CronJobTable.enabled, 1), lte(CronJobTable.next_run_at, now())))
          .all()
          .pipe(Effect.orDie, Effect.map((rows) => rows.map(rowToJob))),
      ),
    )

    const advanceNextRun = Effect.fn("CronJobs.advanceNextRun")((id: string) =>
      mapError(
        Effect.gen(function* () {
          const row = yield* db.select().from(CronJobTable).where(eq(CronJobTable.id, id)).get().pipe(
            Effect.orDie,
            Effect.map((r) => {
              if (!r) throw new CronJobServiceError({ message: `Job not found: ${id}` })
              return r
            }),
          )
          const nextDate = computeNextRun(row, new Date())
          const nextRun = nextDate ? nextDate.getTime() : null
          yield* db.update(CronJobTable).set({ next_run_at: nextRun, time_updated: now() }).where(
            eq(CronJobTable.id, id),
          ).run().pipe(Effect.orDie)
          const updated = yield* db.select().from(CronJobTable).where(eq(CronJobTable.id, id)).get().pipe(
            Effect.orDie,
            Effect.map((r) => r!),
          )
          return rowToJob(updated)
        }),
      ),
    )

    const markJobRun = Effect.fn("CronJobs.markJobRun")(
      (id: string, status: string, error?: string) =>
        mapError(
          Effect.gen(function* () {
            const row = yield* db.select().from(CronJobTable).where(eq(CronJobTable.id, id)).get().pipe(
              Effect.orDie,
              Effect.map((r) => {
                if (!r) throw new CronJobServiceError({ message: `Job not found: ${id}` })
                return r
              }),
            )
            const isOnce = row.schedule_kind === "once"
            const updateData: Partial<typeof CronJobTable.$inferInsert> = {
              last_run_at: now(),
              last_status: status,
              last_error: error ?? null,
              repeat_done: (row.repeat_done ?? 0) + 1,
              time_updated: now(),
            }
            if (isOnce) {
              updateData.enabled = 0
              updateData.state = "completed"
            } else if (status === "error") {
              updateData.state = "error"
            } else {
              updateData.state = "scheduled"
            }
            yield* db.update(CronJobTable).set(updateData).where(eq(CronJobTable.id, id)).run().pipe(Effect.orDie)
          }),
        ),
    )

    const markRunning = Effect.fn("CronJobs.markRunning")((id: string) =>
      mapError(
        db.update(CronJobTable).set({ state: "running", time_updated: now() }).where(eq(CronJobTable.id, id)).run().pipe(
          Effect.orDie,
          Effect.asVoid,
        ),
      ),
    )

    return Service.of({
      create,
      get,
      list,
      update,
      remove,
      getDueJobs,
      advanceNextRun,
      markJobRun,
      markRunning,
    })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(Database.defaultLayer))

export * as CronJobs from "./jobs"
