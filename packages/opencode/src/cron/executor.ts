import { Cause, Context, Effect, Exit, Layer, Schema } from "effect"
import { execSync } from "child_process"
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

/**
 * Build the OS-specific command to show a native notification dialog.
 *
 * Returns an array `[command, ...args]` suitable for `child_process.execSync`.
 * On Windows: PowerShell MessageBox (Yes/No, Question icon, system-modal).
 * On Linux: zenity --question.
 * On macOS: osascript display dialog.
 *
 * Returns `null` when no notification mechanism is available (headless/unknown OS).
 */
export function buildNotifyCommand(jobName: string): string[] | null {
  const displayName = jobName.replace(/"/g, '\\"')
  const title = "OpenCode Cron"
  const message = `¿Ejecutar "${displayName}" ahora?`

  if (process.platform === "win32") {
    const ps = [
      "powershell",
      "-NoProfile",
      "-Command",
      `Add-Type -AssemblyName System.Windows.Forms; ` +
        `$r = [System.Windows.Forms.MessageBox]::Show('${message}', '${title}', 'YesNo', 'Question', 'Button1', 'SystemModal'); ` +
        `if ($r -eq 'Yes') { exit 0 } else { exit 1 }`,
    ]
    return ps
  }

  if (process.platform === "linux") {
    return ["zenity", "--question", "--title", title, "--text", message, "--width", "400"]
  }

  if (process.platform === "darwin") {
    return [
      "osascript",
      "-e",
      `display dialog "${message}" with title "${title}" buttons {"No", "Sí"} default button "Sí" with icon note`,
    ]
  }

  return null
}

/**
 * Show a native notification and return whether the user accepted.
 *
 * Returns `true` when the user clicked Yes/Aceptar/Sí.
 * Returns `false` when the user clicked No/Cancelar, or the command failed,
 * or no notification mechanism is available (headless environment).
 */
export function showNotification(jobName: string): boolean {
  const cmd = buildNotifyCommand(jobName)
  if (!cmd) return false

  try {
    const [command, ...args] = cmd
    execSync([command, ...args].join(" "), { timeout: 120_000, stdio: "ignore" })
    return true
  } catch {
    return false
  }
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
      // 0. If notify is enabled, show native notification and wait for user response
      if (job.notify) {
        const accepted = yield* Effect.promise(() => Promise.resolve(showNotification(job.name ?? "Cron Job")))

        if (!accepted) {
          yield* cronJobs.markJobRun(job.id, "skipped", "User dismissed notification").pipe(Effect.ignore)
          return
        }
      }

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
  Layer.provide(Provider.defaultLayer),
  Layer.provide(Global.layer),
  Layer.provide(FSUtil.defaultLayer),
)

export * as CronExecutor from "./executor"
