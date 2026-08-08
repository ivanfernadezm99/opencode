import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { CronJobs } from "../../src/cron/jobs"
import { detectScheduleKind, formatJobStatus, formatJobTable, dedupe } from "../../src/cli/cron"
import { Database as CoreDatabase } from "@opencode-ai/core/database/database"
import { CronJobTable } from "@opencode-ai/core/cron/cron-job.sql"
import { testEffect } from "../lib/effect"

function makeJob(overrides: Partial<CronJobs.CronJob> = {}): CronJobs.CronJob {
  const now = Date.now()
  return new CronJobs.CronJob({
    id: "abc12345-6789-4def-abc1-234567890abc",
    name: "Morning summary",
    prompt: "Summarize yesterday's work",
    schedule_kind: "cron",
    schedule_expr: "0 9 * * 1-5",
    enabled: 1,
    state: "scheduled",
    next_run_at: now + 3600_000,
    last_run_at: null,
    last_status: null,
    last_error: null,
    model: null,
    skills: null,
    workdir: null,
    repeat_times: null,
    notify: 0,
    repeat_done: 0,
    time_created: now,
    time_updated: now,
    ...overrides,
  })
}

describe("detectScheduleKind", () => {
  test("detects cron expression from spaced tokens", () => {
    expect(detectScheduleKind("0 9 * * 1-5")).toBe("cron")
    expect(detectScheduleKind("*/5 * * * *")).toBe("cron")
    expect(detectScheduleKind("@daily")).toBe("cron")
  })

  test("detects interval from all-digit string", () => {
    expect(detectScheduleKind("3600")).toBe("interval")
    expect(detectScheduleKind("30")).toBe("interval")
    expect(detectScheduleKind("900")).toBe("interval")
  })

  test("detects once from ISO date", () => {
    expect(detectScheduleKind("2026-08-01T12:00:00Z")).toBe("once")
    expect(detectScheduleKind("2026-12-25")).toBe("once")
    expect(detectScheduleKind("2026-08-01T00:00:00.000Z")).toBe("once")
  })
})

describe("formatJobTable", () => {
  test('returns "No cron jobs found" for empty list', () => {
    expect(formatJobTable([])).toBe("No cron jobs found")
  })

  test("formats a single job row", () => {
    const job = makeJob()
    const result = formatJobTable([job])
    expect(result).toContain("abc12345")
    expect(result).toContain("Morning summary")
    expect(result).toContain("0 9 * * 1-5")
    expect(result).toContain("scheduled")
  })

  test("sorts by next_run_at ascending, nulls last", () => {
    const now = Date.now()
    // Use unique short IDs (8+ chars so slice(0,8) is unambiguous)
    const early = makeJob({ id: "aaaaaaa1-0000-0000-0000-000000000000", next_run_at: now })
    const late = makeJob({ id: "bbbbbbb2-0000-0000-0000-000000000000", next_run_at: now + 7200_000 })
    const noRun = makeJob({ id: "ccccccc3-0000-0000-0000-000000000000", next_run_at: null })

    const result = formatJobTable([late, noRun, early])
    const aIdx = result.indexOf("aaaaaaa1")
    const bIdx = result.indexOf("bbbbbbb2")
    const cIdx = result.indexOf("ccccccc3")
    expect(aIdx).toBeLessThan(bIdx)
    expect(bIdx).toBeLessThan(cIdx)
  })

  test("shows interval schedule with every prefix", () => {
    const job = makeJob({ schedule_kind: "interval", schedule_expr: "1800" })
    const result = formatJobTable([job])
    expect(result).toContain("every 1800s")
  })
})

describe("formatJobStatus", () => {
  test("shows all fields for a basic job", () => {
    const job = makeJob()
    const result = formatJobStatus(job)
    expect(result).toContain("abc12345-6789-4def-abc1-234567890abc")
    expect(result).toContain("Morning summary")
    expect(result).toContain("Summarize yesterday's work")
    expect(result).toContain("cron 0 9 * * 1-5")
    expect(result).toContain("yes")
    expect(result).toContain("scheduled")
  })

  test("shows default values for null fields", () => {
    const job = makeJob({
      name: null,
      model: null,
      skills: null,
      workdir: null,
      last_status: null,
      last_error: null,
      repeat_times: null,
    })
    const result = formatJobStatus(job)
    expect(result).toContain("-") // name
    expect(result).toContain("(default)") // model
    expect(result).toContain("(none)") // skills
  })

  test("shows repeat progress when repeat_times is set", () => {
    const job = makeJob({ repeat_times: 5, repeat_done: 2 })
    const result = formatJobStatus(job)
    expect(result).toContain("2/5")
  })
})

describe("dedupe", () => {
  const providerLayer = CoreDatabase.layerFromPath(":memory:")
  const testLayer = Layer.provideMerge(CronJobs.layer, providerLayer) as Layer.Layer<CronJobs.Service>
  const it = testEffect(testLayer)

  const seed = (db: CoreDatabase.Database, id: string, name: string | null, time_created: number) =>
    db.db
      .insert(CronJobTable)
      .values({
        id,
        name,
        prompt: "test prompt",
        schedule_kind: "interval",
        schedule_expr: "3600",
        enabled: 1,
        state: "scheduled",
        time_created,
        time_updated: time_created,
      })
      .run()
      .pipe(Effect.orDie)

  it.live("keeps the earliest time_created and removes later same-name duplicates", () =>
    Effect.gen(function* () {
      const db = yield* CoreDatabase.Service
      const svc = yield* CronJobs.Service
      const now = Date.now()
      yield* seed(db, "earliest", "Recordatorio cargar horas Redmine", now - 10_000)
      yield* seed(db, "later", "Recordatorio cargar horas Redmine", now - 5_000)

      const result = yield* dedupe()

      expect(result.removed).toBe(1)
      expect(result.kept).toBe(1)
      expect(result.skippedNull).toBe(0)
      const kept = yield* svc.get("earliest")
      expect(kept).not.toBeNull()
      const removed = yield* svc.get("later")
      expect(removed).toBeNull()
    }),
  )

  it.live("removes later same-name duplicates case-insensitively", () =>
    Effect.gen(function* () {
      const db = yield* CoreDatabase.Service
      const svc = yield* CronJobs.Service
      const now = Date.now()
      yield* seed(db, "first", "Recordatorio cargar horas Redmine", now - 10_000)
      yield* seed(db, "second", "recordatorio CARGAR HORAS redmine", now - 5_000)
      yield* seed(db, "third", "RECORDATORIO Cargar Horas Redmine", now - 1_000)

      const result = yield* dedupe()

      expect(result.removed).toBe(2)
      expect(result.kept).toBe(1)
      expect(result.skippedNull).toBe(0)
      const kept = yield* svc.get("first")
      expect(kept).not.toBeNull()
      expect((yield* svc.get("second"))).toBeNull()
      expect((yield* svc.get("third"))).toBeNull()
    }),
  )

  it.live("skips NULL-named jobs entirely and never groups them", () =>
    Effect.gen(function* () {
      const db = yield* CoreDatabase.Service
      const svc = yield* CronJobs.Service
      const now = Date.now()
      // Two NULL-named jobs must be skipped (never grouped/removed)
      yield* seed(db, "null1", null, now - 10_000)
      yield* seed(db, "null2", null, now - 5_000)
      // A named duplicate pair that SHOULD collapse
      yield* seed(db, "named-earliest", "My Job", now - 10_000)
      yield* seed(db, "named-later", "my job", now - 5_000)

      const result = yield* dedupe()

      // Only the named pair collapsed; the two NULL-named jobs are untouched
      expect(result.removed).toBe(1)
      expect(result.kept).toBe(1)
      expect(result.skippedNull).toBe(2)
      expect((yield* svc.get("null1"))).not.toBeNull()
      expect((yield* svc.get("null2"))).not.toBeNull()
      expect((yield* svc.get("named-earliest"))).not.toBeNull()
      expect((yield* svc.get("named-later"))).toBeNull()
    }),
  )

  it.live("fresh DB with no duplicates removes nothing", () =>
    Effect.gen(function* () {
      const db = yield* CoreDatabase.Service
      const svc = yield* CronJobs.Service
      const now = Date.now()
      yield* seed(db, "a", "Job A", now - 10_000)
      yield* seed(db, "b", "Job B", now - 5_000)

      const result = yield* dedupe()

      expect(result.removed).toBe(0)
      expect(result.kept).toBe(2)
      expect(result.skippedNull).toBe(0)
      expect((yield* svc.get("a"))).not.toBeNull()
      expect((yield* svc.get("b"))).not.toBeNull()
    }),
  )
})
