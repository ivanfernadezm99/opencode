import { Cause, Context, Effect, Exit, Layer, Schema } from "effect"
import path from "path"
import { streamText } from "ai"
import { Provider } from "@/provider/provider"
import { Global } from "@opencode-ai/core/global"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { CronJobs } from "./jobs"

// ─── Error Type ──────────────────────────────────────────────────────────────

export class CronExecutorError extends Schema.TaggedErrorClass<CronExecutorError>()("CronExecutorError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

// ─── Service ─────────────────────────────────────────────────────────────────

export interface Interface {
  readonly execute: (job: CronJobs.CronJob) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/CronExecutor") {}

// ─── Pure Helpers ────────────────────────────────────────────────────────────

/**
 * Format a Date as `YYYY-MM-DD_HH-MM-SS` for use in filenames.
 */
export function formatTimestamp(date: Date): string {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, "0")
  const d = String(date.getDate()).padStart(2, "0")
  const hh = String(date.getHours()).padStart(2, "0")
  const mm = String(date.getMinutes()).padStart(2, "0")
  const ss = String(date.getSeconds()).padStart(2, "0")
  return `${y}-${m}-${d}_${hh}-${mm}-${ss}`
}

/**
 * Build the full output path for a job's output file.
 */
export function buildOutputPath(baseDir: string, jobId: string, timestamp: string): string {
  return path.join(baseDir, jobId, `${timestamp}.md`)
}

/**
 * Build the markdown content for the output file.
 */
export function buildOutputContent(
  jobName: string | null,
  jobId: string,
  prompt: string,
  response: string,
): string {
  const title = jobName ?? jobId
  return `# Cron Job Output: ${title}\n\n## Prompt\n\n${prompt}\n\n## Response\n\n${response}\n`
}

// ─── Layer ───────────────────────────────────────────────────────────────────

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const cronJobs = yield* CronJobs.Service
    const provider = yield* Provider.Service
    const global = yield* Global.Service
    const fs = yield* FSUtil.Service

    const execute = Effect.fn("CronExecutor.execute")(function* (job: CronJobs.CronJob) {
      // 1. Mark state = 'running'
      yield* cronJobs.markRunning(job.id).pipe(Effect.ignore)

      // 2. Execute prompt — handle timeout and errors
      const text = yield* executePromptInner(provider, job)

      if (text !== undefined) {
        // 3. Save output and mark completed
        yield* saveOutputInner(fs, global, cronJobs, job, text)
      }
    })

    return Service.of({ execute })
  }),
)

function executePromptInner(
  provider: Provider.Interface,
  job: CronJobs.CronJob,
): Effect.Effect<string | undefined> {
  return Effect.gen(function* () {
    const resolved = job.model
      ? Provider.parseModel(job.model)
      : yield* provider.defaultModel()

    const model = yield* provider.getModel(resolved.providerID, resolved.modelID)
    const language = yield* provider.getLanguage(model)

    const result = yield* Effect.promise(() =>
      Promise.resolve(
        streamText({
          model: language,
          messages: [{ role: "user", content: job.prompt }],
        }),
      ),
    )

    return yield* Effect.promise(() => result.text)
  }).pipe(
    Effect.timeout("600 seconds"),
    Effect.catch(
      () => Effect.succeed(undefined) as Effect.Effect<string | undefined>,
    ),
  )
}

function saveOutputInner(
  fs: FSUtil.Interface,
  global: Global.Interface,
  cronJobs: CronJobs.Interface,
  job: CronJobs.CronJob,
  text: string,
): Effect.Effect<void> {
  return Effect.gen(function* () {
    const baseOutputDir = path.join(global.data, "cron", "output")
    const outputDir = path.join(baseOutputDir, job.id)

    yield* fs.ensureDir(outputDir).pipe(Effect.ignore)

    const timestamp = formatTimestamp(new Date())
    const outputPath = buildOutputPath(baseOutputDir, job.id, timestamp)
    const content = buildOutputContent(job.name ?? null, job.id, job.prompt, text)

    yield* fs.writeWithDirs(outputPath, content).pipe(
      Effect.ignore,
    )

    yield* cronJobs.markJobRun(job.id, "completed").pipe(Effect.ignore)
  }).pipe(
    Effect.catch((e: unknown) => {
      const msg = e instanceof Error ? e.message : String(e)
      return cronJobs.markJobRun(job.id, "error", msg).pipe(Effect.ignore)
    }),
  )
}

export const defaultLayer = layer.pipe(
  Layer.provide(CronJobs.defaultLayer),
)

export * as CronExecutor from "./executor"
