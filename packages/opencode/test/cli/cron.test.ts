import { describe, expect, test } from "bun:test"
import { CronJobs } from "../../src/cron/jobs"
import { detectScheduleKind, formatJobStatus, formatJobTable } from "../../src/cli/cron"

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
