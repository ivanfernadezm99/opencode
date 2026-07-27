import { describe, expect, test } from "bun:test"
import { CronJobs } from "../../src/cron/jobs"
import { CronScheduler } from "../../src/cron/scheduler"

describe("partitionByWorkdir", () => {
  test("returns serial for jobs with same workdir and parallel for null workdir", () => {
    const jobs = [
      { id: "1", workdir: "/project/a" },
      { id: "2", workdir: "/project/a" },
      { id: "3", workdir: null },
      { id: "4", workdir: null },
    ]
    const result = CronScheduler.partitionByWorkdir(jobs as Array<{ id: string; workdir: string | null }>)
    expect(result.serial).toHaveLength(2)
    expect(result.serial[0].id).toBe("1")
    expect(result.serial[1].id).toBe("2")
    expect(result.parallel).toHaveLength(2)
    expect(result.parallel[0].id).toBe("3")
    expect(result.parallel[1].id).toBe("4")
  })

  test("no workdir jobs only returns empty serial", () => {
    const jobs = [
      { id: "1", workdir: null },
      { id: "2", workdir: null },
    ]
    const result = CronScheduler.partitionByWorkdir(jobs as Array<{ id: string; workdir: string | null }>)
    expect(result.serial).toHaveLength(0)
    expect(result.parallel).toHaveLength(2)
  })

  test("all workdir jobs returns empty parallel", () => {
    const jobs = [
      { id: "1", workdir: "/project/a" },
      { id: "2", workdir: "/project/b" },
    ]
    const result = CronScheduler.partitionByWorkdir(jobs as Array<{ id: string; workdir: string | null }>)
    expect(result.serial).toHaveLength(2)
    expect(result.parallel).toHaveLength(0)
  })

  test("empty input returns both empty", () => {
    const result = CronScheduler.partitionByWorkdir([])
    expect(result.serial).toHaveLength(0)
    expect(result.parallel).toHaveLength(0)
  })
})

describe("concurrencyCap", () => {
  test("returns all jobs when under cap", () => {
    const result = CronScheduler.concurrencyCap([1, 2, 3], 5)
    expect(result).toEqual([1, 2, 3])
  })

  test("returns only first N when over cap", () => {
    const result = CronScheduler.concurrencyCap([1, 2, 3, 4, 5], 3)
    expect(result).toEqual([1, 2, 3])
  })

  test("returns empty for empty input", () => {
    const result = CronScheduler.concurrencyCap([], 5)
    expect(result).toHaveLength(0)
  })

  test("uses default cap of 5", () => {
    const result = CronScheduler.concurrencyCap([1, 2, 3, 4, 5, 6, 7])
    expect(result).toHaveLength(5)
  })
})

describe("computeGraceMs integration", () => {
  test("once kind always falls within grace", () => {
    // once = 120s grace window
    const now = Date.now()
    const dueTime = now - 60_000 // 1 minute ago — within 120s grace
    const graceMs = CronJobs.computeGraceMs("once", "2026-12-01T00:00:00.000Z")
    expect(now - dueTime).toBeLessThanOrEqual(graceMs)
  })

  test("cron job 4h outside grace window is skipped", () => {
    const now = Date.now()
    const dueTime = now - 4 * 3600_000 // 4 hours ago
    const graceMs = CronJobs.computeGraceMs("interval", "3600") // hourly interval
    // 4 hours = 14,400,000ms > grace (7,200,000ms cap)
    expect(now - dueTime).toBeGreaterThan(graceMs)
  })

  test("cron job 1min outside is within grace", () => {
    const now = Date.now()
    const dueTime = now - 60_000 // 1 minute ago
    const graceMs = CronJobs.computeGraceMs("interval", "3600") // hourly = 1,800,000ms grace
    expect(now - dueTime).toBeLessThanOrEqual(graceMs)
  })
})
