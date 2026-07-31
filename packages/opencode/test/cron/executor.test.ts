import { describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { drizzle } from "drizzle-orm/bun-sqlite"
import { sql } from "drizzle-orm"
import { CronJobTable } from "@opencode-ai/core/cron/cron-job.sql"
import { Effect, Layer } from "effect"
import * as path from "path"
import * as fs from "fs/promises"
import { testEffect } from "../lib/effect"
import { Database as CoreDatabase } from "@opencode-ai/core/database/database"
import { CronJobs } from "../../src/cron/jobs"
import { CronExecutor } from "../../src/cron/executor"

describe("CronJobs.markRunning", () => {
  const providerLayer = Layer.mergeAll(CoreDatabase.layerFromPath(":memory:"))
  const testLayer = CronJobs.defaultLayer.pipe(Layer.provide(providerLayer)) as Layer.Layer<CronJobs.Service>
  const it = testEffect(testLayer)

  it.live("transitions state from scheduled to running", () =>
    Effect.gen(function* () {
      const svc = yield* CronJobs.Service
      const created = yield* svc.create({
        prompt: "markRunning test",
        schedule_kind: "interval",
        schedule_expr: "3600",
        next_run_at: Date.now() - 1000,
      })
      expect(created.state).toBe("scheduled")

      yield* svc.markRunning(created.id)

      const job = yield* svc.get(created.id)
      expect(job).not.toBeNull()
      expect(job!.state).toBe("running")
    }),
  )

  it.live("markRunning does not affect other fields", () =>
    Effect.gen(function* () {
      const svc = yield* CronJobs.Service
      const created = yield* svc.create({
        prompt: "field preservation",
        schedule_kind: "once",
        schedule_expr: "2026-12-01T00:00:00.000Z",
        name: "preserve-test",
        next_run_at: Date.now() - 1000,
      })

      yield* svc.markRunning(created.id)

      const job = yield* svc.get(created.id)
      expect(job!.name).toBe("preserve-test")
      expect(job!.prompt).toBe("field preservation")
      expect(job!.next_run_at).not.toBeNull()
    }),
  )

  it.live("markRunning on nonexistent id is a no-op", () =>
    Effect.gen(function* () {
      const svc = yield* CronJobs.Service
      // Should not throw
      yield* svc.markRunning("nonexistent-id")
    }),
  )
})

describe("output path formatting", () => {
  test("formatTimestamp produces correct format", () => {
    const date = new Date("2026-07-27T14:30:00.000Z")
    const formatted = CronExecutor.formatTimestamp(date)
    // YYYY-MM-DD_HH-MM-SS format
    expect(formatted).toMatch(/^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}$/)
    expect(formatted).toBe("2026-07-27_14-30-00")
  })

  test("buildOutputPath joins base dir, job id, and timestamp", () => {
    const baseDir = "/home/user/.local/share/opencode/cron/output"
    const jobId = "abc-123"
    const timestamp = "2026-07-27_14-30-00"
    const result = CronExecutor.buildOutputPath(baseDir, jobId, timestamp)
    expect(result).toBe("/home/user/.local/share/opencode/cron/output/abc-123/2026-07-27_14-30-00.md")
  })
})

describe("CronExecutor error recording", () => {
  const providerLayer = Layer.mergeAll(CoreDatabase.layerFromPath(":memory:"))
  const testLayer = CronJobs.defaultLayer.pipe(Layer.provide(providerLayer)) as Layer.Layer<CronJobs.Service>
  const it = testEffect(testLayer)

  it.live("markJobRun with error status and message records correctly", () =>
    Effect.gen(function* () {
      const svc = yield* CronJobs.Service
      const created = yield* svc.create({
        prompt: "error test",
        schedule_kind: "interval",
        schedule_expr: "3600",
        next_run_at: Date.now() - 1000,
      })

      yield* svc.markJobRun(created.id, "error", "test failure message")

      const job = yield* svc.get(created.id)
      expect(job).not.toBeNull()
      expect(job!.last_status).toBe("error")
      expect(job!.last_error).toBe("test failure message")
      expect(job!.state).toBe("error")
    }),
  )

  it.live("markJobRun with completed status transitions from running", () =>
    Effect.gen(function* () {
      const svc = yield* CronJobs.Service
      const created = yield* svc.create({
        prompt: "complete from running",
        schedule_kind: "interval",
        schedule_expr: "3600",
        next_run_at: Date.now() - 1000,
      })

      yield* svc.markRunning(created.id)
      yield* svc.markJobRun(created.id, "completed")

      const job = yield* svc.get(created.id)
      expect(job!.state).toBe("scheduled")
      expect(job!.last_status).toBe("completed")
    }),
  )
})

describe("user data directory for cron output", () => {
  test("buildOutputPath uses data dir convention", () => {
    // The output path should follow: {dataDir}/cron/output/{job_id}/{timestamp}.md
    const dataDir = "/home/user/.local/share/opencode"
    const jobId = crypto.randomUUID()
    const timestamp = "2026-07-27_14-30-00"

    const outputPath = CronExecutor.buildOutputPath(
      path.join(dataDir, "cron", "output"),
      jobId,
      timestamp,
    )

    expect(outputPath).toContain("cron")
    expect(outputPath).toContain("output")
    expect(outputPath).toContain(jobId)
    expect(outputPath).toContain(`${timestamp}.md`)
  })
})

describe("content formatting", () => {
  test("buildOutputContent formats conversation correctly", () => {
    const jobName = "my-cron-job"
    const jobId = "abc-123"
    const prompt = "What is the meaning of life?"
    const response = "42"

    const content = CronExecutor.buildOutputContent(jobName, jobId, prompt, response)

    expect(content).toContain("# Cron Job Output: my-cron-job")
    expect(content).toContain("## Prompt")
    expect(content).toContain("What is the meaning of life?")
    expect(content).toContain("## Response")
    expect(content).toContain("42")
  })

  test("buildOutputContent uses job id when name is null", () => {
    const content = CronExecutor.buildOutputContent(null, "abc-123", "prompt", "response")

    expect(content).toContain("# Cron Job Output: abc-123")
  })
})
