import { describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { drizzle } from "drizzle-orm/bun-sqlite"
import { sql } from "drizzle-orm"
import { CronJobTable } from "@opencode-ai/core/cron/cron-job.sql"
import { Effect, Layer } from "effect"
import { testEffect } from "../lib/effect"
import { Database as CoreDatabase } from "@opencode-ai/core/database/database"
import { CronJobs } from "../../src/cron/jobs"

function createTestDb() {
  const sqlite = new Database(":memory:")
  const db = drizzle({ client: sqlite })

  db.run(sql`
    CREATE TABLE cron_job (
      id text PRIMARY KEY,
      name text,
      prompt text NOT NULL,
      schedule_kind text NOT NULL,
      schedule_expr text NOT NULL,
      enabled integer NOT NULL DEFAULT 1,
      state text NOT NULL DEFAULT 'scheduled',
      next_run_at integer,
      last_run_at integer,
      last_status text,
      last_error text,
      model text,
      skills text,
      workdir text,
      repeat_times integer,
      repeat_done integer NOT NULL DEFAULT 0,
      notify integer NOT NULL DEFAULT 0,
      time_created integer NOT NULL,
      time_updated integer NOT NULL
    )
  `)

  return db
}

describe("cron_job schema", () => {
  test("inserts and reads a row with all fields", () => {
    const db = createTestDb()
    const id = crypto.randomUUID()
    const now = Date.now()

    db.insert(CronJobTable)
      .values({
        id,
        prompt: "test prompt",
        schedule_kind: "cron",
        schedule_expr: "0 9 * * 1-5",
        time_created: now,
        time_updated: now,
      })
      .run()

    const row = db.select().from(CronJobTable).where(sql`id = ${id}`).get()
    expect(row).not.toBeUndefined()
    expect(row!.prompt).toBe("test prompt")
    expect(row!.schedule_kind).toBe("cron")
    expect(row!.schedule_expr).toBe("0 9 * * 1-5")
    expect(row!.enabled).toBe(1)
    expect(row!.state).toBe("scheduled")
    expect(row!.repeat_done).toBe(0)
  })

  test("applies default values when not explicitly set", () => {
    const db = createTestDb()
    const id = crypto.randomUUID()
    const now = Date.now()

    db.insert(CronJobTable)
      .values({
        id,
        prompt: "defaults test",
        schedule_kind: "interval",
        schedule_expr: "30m",
        time_created: now,
        time_updated: now,
      })
      .run()

    const row = db.select().from(CronJobTable).where(sql`id = ${id}`).get()
    expect(row).not.toBeUndefined()
    expect(row!.enabled).toBe(1)
    expect(row!.state).toBe("scheduled")
    expect(row!.repeat_done).toBe(0)
    expect(row!.name).toBeNull()
    expect(row!.next_run_at).toBeNull()
    expect(row!.last_status).toBeNull()
    expect(row!.model).toBeNull()
    expect(row!.workdir).toBeNull()
  })

  test("updates a row", () => {
    const db = createTestDb()
    const id = crypto.randomUUID()
    const now = Date.now()

    db.insert(CronJobTable)
      .values({
        id,
        prompt: "update test",
        schedule_kind: "once",
        schedule_expr: "2026-12-01T00:00:00.000Z",
        time_created: now,
        time_updated: now,
      })
      .run()

    const updatedNow = Date.now()
    db.update(CronJobTable)
      .set({ name: "updated name", enabled: 0, state: "error", last_status: "error", last_error: "timeout" })
      .where(sql`id = ${id}`)
      .run()

    const row = db.select().from(CronJobTable).where(sql`id = ${id}`).get()
    expect(row).not.toBeUndefined()
    expect(row!.name).toBe("updated name")
    expect(row!.enabled).toBe(0)
    expect(row!.state).toBe("error")
    expect(row!.last_status).toBe("error")
    expect(row!.last_error).toBe("timeout")
  })

  test("deletes a row", () => {
    const db = createTestDb()
    const id = crypto.randomUUID()
    const now = Date.now()

    db.insert(CronJobTable)
      .values({
        id,
        prompt: "delete test",
        schedule_kind: "interval",
        schedule_expr: "10m",
        time_created: now,
        time_updated: now,
      })
      .run()

    db.delete(CronJobTable).where(sql`id = ${id}`).run()

    const row = db.select().from(CronJobTable).where(sql`id = ${id}`).get()
    expect(row).toBeUndefined()
  })

  test("inserts row with optional fields populated", () => {
    const db = createTestDb()
    const id = crypto.randomUUID()
    const now = Date.now()

    db.insert(CronJobTable)
      .values({
        id,
        name: "my-job",
        prompt: "full row test",
        schedule_kind: "cron",
        schedule_expr: "0 9 * * 1-5",
        enabled: 1,
        state: "scheduled",
        next_run_at: now + 3600000,
        last_run_at: now - 3600000,
        last_status: "completed",
        model: "gpt-4",
        skills: '["python","bash"]',
        workdir: "/home/project",
        repeat_times: 5,
        repeat_done: 2,
        time_created: now,
        time_updated: now,
      })
      .run()

    const row = db.select().from(CronJobTable).where(sql`id = ${id}`).get()
    expect(row).not.toBeUndefined()
    expect(row!.name).toBe("my-job")
    expect(row!.enabled).toBe(1)
    expect(row!.state).toBe("scheduled")
    expect(row!.next_run_at).toBe(now + 3600000)
    expect(row!.last_run_at).toBe(now - 3600000)
    expect(row!.last_status).toBe("completed")
    expect(row!.model).toBe("gpt-4")
    expect(row!.skills).toBe('["python","bash"]')
    expect(row!.workdir).toBe("/home/project")
    expect(row!.repeat_times).toBe(5)
    expect(row!.repeat_done).toBe(2)
  })
})

describe("computeNextRun", () => {
  test("cron expression returns next valid weekday at 9am", () => {
    // July 27, 2026 is a Monday
    const base = new Date("2026-07-27T08:00:00Z")
    const result = CronJobs.computeNextRun({
      schedule_kind: "cron",
      schedule_expr: "0 9 * * 1-5",
    }, base, "America/New_York")
    expect(result).not.toBeNull()
    // 9am ET on the same Monday = 13:00 UTC (EDT = UTC-4)
    expect(result!.getFullYear()).toBe(2026)
    expect(result!.getMonth()).toBe(6) // July = 6
    expect(result!.getDate()).toBe(27)
    expect(result!.getUTCHours()).toBe(13)
    expect(result!.getUTCMinutes()).toBe(0)
  })

  test("interval expression adds seconds to base", () => {
    const base = new Date("2026-07-27T08:00:00Z")
    const result = CronJobs.computeNextRun({
      schedule_kind: "interval",
      schedule_expr: "3600",
    }, base)
    expect(result).not.toBeNull()
    expect(result!.getTime()).toBe(base.getTime() + 3600_000)
  })

  test("once expression parses ISO date", () => {
    const result = CronJobs.computeNextRun({
      schedule_kind: "once",
      schedule_expr: "2026-12-01T00:00:00.000Z",
    })
    expect(result).not.toBeNull()
    expect(result!.toISOString()).toBe("2026-12-01T00:00:00.000Z")
  })

  test("invalid cron expression returns null", () => {
    const result = CronJobs.computeNextRun({
      schedule_kind: "cron",
      schedule_expr: "invalid",
    })
    expect(result).toBeNull()
  })

  test("invalid interval expression returns null", () => {
    const result = CronJobs.computeNextRun({
      schedule_kind: "interval",
      schedule_expr: "not-a-number",
    })
    expect(result).toBeNull()
  })

  test("invalid once date returns null", () => {
    const result = CronJobs.computeNextRun({
      schedule_kind: "once",
      schedule_expr: "not-a-date",
    })
    expect(result).toBeNull()
  })

  test("cron expression with timezone uses provided tz", () => {
    const base = new Date("2026-07-27T00:00:00Z") // Monday midnight UTC
    const result = CronJobs.computeNextRun({
      schedule_kind: "cron",
      schedule_expr: "0 0 * * 0",
    }, base, "America/New_York")
    // Next Sunday at midnight ET = 2026-08-02T04:00:00Z (EDT = UTC-4)
    expect(result).not.toBeNull()
    expect(result!.getUTCHours()).toBe(4)
    expect(result!.getUTCDate()).toBe(2)
    expect(result!.getUTCMonth()).toBe(7) // August = 7
  })
})

describe("computeGraceMs", () => {
  test("once kind returns 120_000", () => {
    const result = CronJobs.computeGraceMs("once", "2026-12-01T00:00:00.000Z")
    expect(result).toBe(120_000)
  })

  test("interval with short period uses period/2 if > 120s", () => {
    // 300s interval = 300_000ms period / 2 = 150_000ms > 120_000, so 150_000
    const result = CronJobs.computeGraceMs("interval", "300")
    expect(result).toBe(150_000)
  })

  test("interval with very short period falls back to 120_000", () => {
    // 60s interval = 60_000ms period / 2 = 30_000ms < 120_000
    const result = CronJobs.computeGraceMs("interval", "60")
    expect(result).toBe(120_000)
  })

  test("interval with long period capped at 7_200_000", () => {
    // 36000s interval = 36000_000ms period / 2 = 18_000_000 > 7_200_000
    const result = CronJobs.computeGraceMs("interval", "36000")
    expect(result).toBe(7_200_000)
  })

  test("cron with daily period", () => {
    // daily cron at 9am = 86400_000ms period / 2 = 43_200_000 > 7_200_000
    const result = CronJobs.computeGraceMs("cron", "0 9 * * *")
    expect(result).toBe(7_200_000)
  })

  test("cron with hourly period (every 2h)", () => {
    // every 2 hours = 7200_000ms period / 2 = 3_600_000 < 7_200_000 > 120_000
    const result = CronJobs.computeGraceMs("cron", "0 */2 * * *")
    expect(result).toBe(3_600_000)
  })
})

describe("CronJobs service", () => {
  const providerLayer = CoreDatabase.layerFromPath(":memory:")
  const testLayer = Layer.provideMerge(CronJobs.layer, providerLayer) as Layer.Layer<CronJobs.Service>
  const it = testEffect(testLayer)

  it.live("create inserts a job and returns it", () =>
    Effect.gen(function* () {
      const svc = yield* CronJobs.Service
      const job = yield* svc.create({
        prompt: "test prompt",
        schedule_kind: "cron",
        schedule_expr: "0 9 * * 1-5",
      })
      expect(job.id).toBeString()
      expect(job.prompt).toBe("test prompt")
      expect(job.schedule_kind).toBe("cron")
      expect(job.schedule_expr).toBe("0 9 * * 1-5")
      expect(job.enabled).toBe(1)
      expect(job.state).toBe("scheduled")
      expect(job.repeat_done).toBe(0)
    }),
  )

  it.live("create without next_run_at computes a future non-NULL value for an enabled job", () =>
    Effect.gen(function* () {
      const svc = yield* CronJobs.Service
      const before = Date.now()
      const job = yield* svc.create({
        prompt: "future compute",
        schedule_kind: "interval",
        schedule_expr: "3600",
      })
      expect(job.next_run_at).not.toBeNull()
      // computeNextRun(interval "3600") = base + 3600s, strictly in the future
      expect(job.next_run_at!).toBeGreaterThan(before)
    }),
  )

  it.live("create with a past computed value stores NULL", () =>
    Effect.gen(function* () {
      const svc = yield* CronJobs.Service
      // once schedule already passed → computeNextRun returns a past Date
      const job = yield* svc.create({
        prompt: "past once",
        schedule_kind: "once",
        schedule_expr: "2020-01-01T00:00:00.000Z",
      })
      expect(job.next_run_at).toBeNull()
    }),
  )

  it.live("create with invalid expression stores NULL", () =>
    Effect.gen(function* () {
      const svc = yield* CronJobs.Service
      const job = yield* svc.create({
        prompt: "invalid expr",
        schedule_kind: "cron",
        schedule_expr: "not-a-cron",
      })
      expect(job.next_run_at).toBeNull()
    }),
  )

  it.live("create respects an explicit next_run_at", () =>
    Effect.gen(function* () {
      const svc = yield* CronJobs.Service
      const job = yield* svc.create({
        prompt: "explicit",
        schedule_kind: "interval",
        schedule_expr: "3600",
        next_run_at: 1700000000000,
      })
      expect(job.next_run_at).toBe(1700000000000)
    }),
  )

  it.live("create with enabled=0 stores NULL (no computation)", () =>
    Effect.gen(function* () {
      const svc = yield* CronJobs.Service
      const job = yield* svc.create({
        prompt: "disabled",
        schedule_kind: "interval",
        schedule_expr: "3600",
        enabled: 0,
      })
      expect(job.next_run_at).toBeNull()
    }),
  )

  it.live("get returns a job by id", () =>
    Effect.gen(function* () {
      const svc = yield* CronJobs.Service
      const created = yield* svc.create({
        prompt: "get test",
        schedule_kind: "once",
        schedule_expr: "2026-12-01T00:00:00.000Z",
      })
      const found = yield* svc.get(created.id)
      expect(found).not.toBeNull()
      expect(found!.id).toBe(created.id)
      expect(found!.prompt).toBe("get test")
    }),
  )

  it.live("get returns null for nonexistent id", () =>
    Effect.gen(function* () {
      const svc = yield* CronJobs.Service
      const found = yield* svc.get("nonexistent")
      expect(found).toBeNull()
    }),
  )

  it.live("list returns all jobs ordered by time_created", () =>
    Effect.gen(function* () {
      const svc = yield* CronJobs.Service
      yield* svc.create({
        prompt: "first",
        schedule_kind: "cron",
        schedule_expr: "0 9 * * *",
      })
      yield* svc.create({
        prompt: "second",
        schedule_kind: "interval",
        schedule_expr: "3600",
      })
      const jobs = yield* svc.list()
      expect(jobs).toHaveLength(2)
      expect(jobs[0].prompt).toBe("first")
      expect(jobs[1].prompt).toBe("second")
    }),
  )

  it.live("update modifies job fields", () =>
    Effect.gen(function* () {
      const svc = yield* CronJobs.Service
      const created = yield* svc.create({
        prompt: "update test",
        schedule_kind: "cron",
        schedule_expr: "0 9 * * *",
      })
      const updated = yield* svc.update(created.id, { name: "new name", enabled: 0 })
      expect(updated.name).toBe("new name")
      expect(updated.enabled).toBe(0)
    }),
  )

  it.live("remove deletes a job", () =>
    Effect.gen(function* () {
      const svc = yield* CronJobs.Service
      const created = yield* svc.create({
        prompt: "remove test",
        schedule_kind: "once",
        schedule_expr: "2026-12-01T00:00:00.000Z",
      })
      yield* svc.remove(created.id)
      const found = yield* svc.get(created.id)
      expect(found).toBeNull()
    }),
  )

  it.live("getDueJobs returns only enabled jobs with past next_run_at", () =>
    Effect.gen(function* () {
      const svc = yield* CronJobs.Service
      const now = Date.now()
      // Past — due
      yield* svc.create({
        prompt: "due",
        schedule_kind: "once",
        schedule_expr: "2026-07-27T00:00:00.000Z",
        next_run_at: now - 3600_000,
      })
      // Future — not due
      yield* svc.create({
        prompt: "future",
        schedule_kind: "once",
        schedule_expr: "2027-01-01T00:00:00.000Z",
        next_run_at: now + 3600_000,
      })
      // Disabled with past — not due
      yield* svc.create({
        prompt: "disabled",
        schedule_kind: "once",
        schedule_expr: "2026-07-27T00:00:00.000Z",
        next_run_at: now - 3600_000,
        enabled: 0,
      })
      const due = yield* svc.getDueJobs()
      expect(due).toHaveLength(1)
      expect(due[0].prompt).toBe("due")
    }),
  )

  it.live("advanceNextRun pre-advances next_run_at", () =>
    Effect.gen(function* () {
      const svc = yield* CronJobs.Service
      const created = yield* svc.create({
        prompt: "advance test",
        schedule_kind: "interval",
        schedule_expr: "3600",
        next_run_at: 1000,
      })
      const advanced = yield* svc.advanceNextRun(created.id)
      // next_run_at should now be in the near future (base time + 3600s)
      expect(advanced.next_run_at).not.toBeNull()
      expect(advanced.next_run_at!).toBeGreaterThan(1000)
    }),
  )

  it.live("markJobRun records completion", () =>
    Effect.gen(function* () {
      const svc = yield* CronJobs.Service
      const created = yield* svc.create({
        prompt: "mark test",
        schedule_kind: "interval",
        schedule_expr: "3600",
        next_run_at: Date.now() - 1000,
      })
      yield* svc.markJobRun(created.id, "completed")
      const job = yield* svc.get(created.id)
      expect(job).not.toBeNull()
      expect(job!.last_status).toBe("completed")
      expect(job!.state).toBe("scheduled") // recurring stays scheduled
      expect(job!.last_run_at).not.toBeNull()
      expect(job!.repeat_done).toBe(1)
    }),
  )

  it.live("markJobRun with once kind disables job", () =>
    Effect.gen(function* () {
      const svc = yield* CronJobs.Service
      const created = yield* svc.create({
        prompt: "once test",
        schedule_kind: "once",
        schedule_expr: "2026-07-27T00:00:00.000Z",
        next_run_at: Date.now() - 1000,
      })
      yield* svc.markJobRun(created.id, "completed")
      const job = yield* svc.get(created.id)
      expect(job).not.toBeNull()
      expect(job!.last_status).toBe("completed")
      expect(job!.state).toBe("completed")
      expect(job!.enabled).toBe(0)
    }),
  )

  it.live("markJobRun with error status", () =>
    Effect.gen(function* () {
      const svc = yield* CronJobs.Service
      const created = yield* svc.create({
        prompt: "error test",
        schedule_kind: "interval",
        schedule_expr: "3600",
        next_run_at: Date.now() - 1000,
      })
      yield* svc.markJobRun(created.id, "error", "timeout")
      const job = yield* svc.get(created.id)
      expect(job).not.toBeNull()
      expect(job!.last_status).toBe("error")
      expect(job!.last_error).toBe("timeout")
      expect(job!.state).toBe("error")
    }),
  )

  it.live("backfill heals an enabled job with NULL next_run_at", () =>
    Effect.gen(function* () {
      const svc = yield* CronJobs.Service
      const db = yield* CoreDatabase.Service
      const id = crypto.randomUUID()
      const time = Date.now()
      yield* db.db
        .insert(CronJobTable)
        .values({
          id,
          prompt: "backfill me",
          schedule_kind: "interval",
          schedule_expr: "3600",
          enabled: 1,
          state: "scheduled",
          time_created: time,
          time_updated: time,
        })
        .run()
        .pipe(Effect.orDie)
      const healed = yield* svc.backfillNextRuns()
      expect(healed).toBe(1)
      const job = yield* svc.get(id)
      expect(job).not.toBeNull()
      expect(job!.next_run_at).not.toBeNull()
      expect(job!.next_run_at!).toBeGreaterThan(time)
    }),
  )

  it.live("backfill is idempotent and never changes an already-healed value", () =>
    Effect.gen(function* () {
      const svc = yield* CronJobs.Service
      const db = yield* CoreDatabase.Service
      const id = crypto.randomUUID()
      const time = Date.now()
      yield* db.db
        .insert(CronJobTable)
        .values({
          id,
          prompt: "idempotent",
          schedule_kind: "interval",
          schedule_expr: "3600",
          enabled: 1,
          state: "scheduled",
          time_created: time,
          time_updated: time,
        })
        .run()
        .pipe(Effect.orDie)
      expect(yield* svc.backfillNextRuns()).toBe(1)
      const firstHealed = (yield* svc.get(id))!.next_run_at
      // Second run heals nothing
      expect(yield* svc.backfillNextRuns()).toBe(0)
      const secondHealed = (yield* svc.get(id))!.next_run_at
      expect(secondHealed).toBe(firstHealed)
    }),
  )

  it.live("backfill leaves disabled, invalid, and once-expired jobs NULL and heals a valid sibling", () =>
    Effect.gen(function* () {
      const svc = yield* CronJobs.Service
      const db = yield* CoreDatabase.Service
      const time = Date.now()
      const seed = (id: string, overrides: Partial<typeof CronJobTable.$inferInsert>) =>
        db.db
          .insert(CronJobTable)
          .values({
            id,
            prompt: `job ${id}`,
            schedule_kind: "interval",
            schedule_expr: "3600",
            enabled: 1,
            state: "scheduled",
            time_created: time,
            time_updated: time,
            ...overrides,
          })
          .run()
          .pipe(Effect.orDie)
      // disabled
      yield* seed("disabled", { enabled: 0 })
      // enabled but invalid expression
      yield* seed("invalid", { schedule_kind: "cron", schedule_expr: "not-a-cron" })
      // enabled once-expired
      yield* seed("expired", { schedule_kind: "once", schedule_expr: "2020-01-01T00:00:00.000Z" })
      // valid enabled sibling that SHOULD heal
      yield* seed("valid", {})
      const healed = yield* svc.backfillNextRuns()
      expect(healed).toBe(1)
      for (const bad of ["disabled", "invalid", "expired"]) {
        const job = yield* svc.get(bad)
        expect(job!.next_run_at).toBeNull()
      }
      const valid = yield* svc.get("valid")
      expect(valid!.next_run_at).not.toBeNull()
    }),
  )

  it.live("advanceNextRun marks an expired once job done so it never double-fires", () =>
    Effect.gen(function* () {
      const svc = yield* CronJobs.Service
      const now = Date.now()
      const created = yield* svc.create({
        prompt: "once double-fire",
        schedule_kind: "once",
        schedule_expr: "2020-01-01T00:00:00.000Z",
        next_run_at: now - 1000, // already due
      })
      // First tick: advanceNextRun should mark done (not persist a past value)
      const advanced = yield* svc.advanceNextRun(created.id)
      expect(advanced.enabled).toBe(0)
      expect(advanced.state).toBe("completed")
      // Second tick: job must not be due again
      const due = yield* svc.getDueJobs()
      expect(due.some((j) => j.id === created.id)).toBe(false)
    }),
  )

  it.live("advanceNextRun persists only a strictly-future value for a recurring job", () =>
    Effect.gen(function* () {
      const svc = yield* CronJobs.Service
      const created = yield* svc.create({
        prompt: "recurring future",
        schedule_kind: "interval",
        schedule_expr: "3600",
        next_run_at: Date.now() - 1000, // due
      })
      const before = Date.now()
      const advanced = yield* svc.advanceNextRun(created.id)
      expect(advanced.next_run_at).not.toBeNull()
      expect(advanced.next_run_at!).toBeGreaterThan(before) // strictly future, never past
      expect(advanced.enabled).toBe(1)
    }),
  )

  it.live("advanceNextRun failure on a removed job is caught by catchCause and loop continues", () =>
    Effect.gen(function* () {
      const svc = yield* CronJobs.Service
      const db = yield* CoreDatabase.Service
      const time = Date.now()
      const seed = (id: string) =>
        db.db
          .insert(CronJobTable)
          .values({
            id,
            prompt: `job ${id}`,
            schedule_kind: "interval",
            schedule_expr: "3600",
            enabled: 1,
            state: "scheduled",
            next_run_at: time - 1000,
            time_created: time,
            time_updated: time,
          })
          .run()
          .pipe(Effect.orDie)
      // Two due jobs; one will be removed mid-loop (simulating concurrent deletion)
      yield* seed("removed")
      yield* seed("survivor")

      // Production loop: getDueJobs → advanceNextRun (catchCause) → execute
      const due = yield* svc.getDueJobs()
      expect(due.map((j) => j.id).sort()).toEqual(["removed", "survivor"])
      for (const job of due) {
        if (job.id === "removed") {
          yield* svc.remove("removed")
        }
        // Wrapped in catchCause so the sync-throw DEFECT never kills the loop/fiber
        yield* svc.advanceNextRun(job.id).pipe(
          Effect.catchCause((cause) => Effect.logError("Cron advanceNextRun failed", cause)),
        )
      }
      // Survivor was advanced (real work ran) — proof the loop continued past the failure
      const survivor = yield* svc.get("survivor")
      expect(survivor).not.toBeNull()
      expect(survivor!.next_run_at).not.toBeNull()
    }),
  )
})
