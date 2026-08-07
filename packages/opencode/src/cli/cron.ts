import type { Argv } from "yargs"
import { Effect, Layer } from "effect"
import { effectCmd, fail as cliFail, CliError } from "./effect-cmd"
import { CronJobs } from "../cron/jobs"
import { CronExecutor } from "../cron/executor"
import { UI } from "./ui"
import { EOL } from "os"

// ─── Helpers ──────────────────────────────────────────────────────────────

/**
 * Auto-detect schedule kind from expression format.
 * - All digits → "interval" (seconds)
 * - ISO 8601 date → "once"
 * - Everything else → "cron"
 */
export function detectScheduleKind(schedule: string): string {
  if (/^\d+$/.test(schedule)) return "interval"
  if (/^\d{4}-\d{2}-\d{2}/.test(schedule)) return "once"
  return "cron"
}

/**
 * Format a list of cron jobs as a table, sorted by `next_run_at` ascending
 * (nulls last). Returns "No cron jobs found" for an empty list.
 */
export function formatJobTable(jobs: CronJobs.CronJob[]): string {
  if (jobs.length === 0) return "No cron jobs found"

  const lines: string[] = []
  const header =
    `ID${" ".repeat(38)} NAME              SCHEDULE           NEXT RUN                    STATE`
  lines.push(header)
  lines.push("─".repeat(header.length))

  const sorted = [...jobs].sort((a, b) => {
    if (a.next_run_at == null && b.next_run_at == null) return 0
    if (a.next_run_at == null) return 1
    if (b.next_run_at == null) return -1
    return a.next_run_at - b.next_run_at
  })

  for (const job of sorted) {
    const shortId = job.id.slice(0, 8)
    const name = job.name ?? "(unnamed)"
    const schedule =
      job.schedule_kind === "interval"
        ? `every ${job.schedule_expr}s`
        : job.schedule_expr
    const nextRun = job.next_run_at
      ? new Date(job.next_run_at).toISOString().replace("T", " ").slice(0, 16)
      : "-"
    const state = job.state
    const line =
      `${shortId.padEnd(40)} ${name.padEnd(18)} ${schedule.padEnd(18)} ${nextRun.padEnd(26)} ${state}`
    lines.push(line)
  }

  return lines.join(EOL)
}

/**
 * Format a single job's full status for display.
 */
export function formatJobStatus(job: CronJobs.CronJob): string {
  const lines: string[] = []
  lines.push(`ID:          ${job.id}`)
  lines.push(`Name:        ${job.name ?? "-"}`)
  lines.push(`Prompt:      ${job.prompt}`)
  lines.push(`Schedule:    ${job.schedule_kind} ${job.schedule_expr}`)
  lines.push(`Enabled:     ${job.enabled ? "yes" : "no"}`)
  lines.push(`State:       ${job.state}`)
  lines.push(
    `Next run:    ${job.next_run_at ? new Date(job.next_run_at).toISOString().replace("T", " ").slice(0, 16) : "-"}`,
  )
  lines.push(
    `Last run:    ${job.last_run_at ? new Date(job.last_run_at).toISOString().replace("T", " ").slice(0, 16) : "-"}`,
  )
  lines.push(`Last status: ${job.last_status ?? "-"}`)
  lines.push(`Last error:  ${job.last_error ?? "-"}`)
  if (job.repeat_times != null) {
    lines.push(`Repeat:      ${job.repeat_done}/${job.repeat_times}`)
  }
  lines.push(`Model:       ${job.model ?? "(default)"}`)
  lines.push(`Skills:      ${job.skills ?? "(none)"}`)
  lines.push(`Workdir:     ${job.workdir ?? "(default)"}`)
  lines.push(
    `Created:     ${new Date(job.time_created).toISOString().replace("T", " ").slice(0, 16)}`,
  )
  lines.push(
    `Updated:     ${new Date(job.time_updated).toISOString().replace("T", " ").slice(0, 16)}`,
  )
  return lines.join(EOL)
}

// Shared layer: CronJobs service provided on top of AppRuntime's Database
const cronLayer = CronJobs.layer

export interface DedupeResult {
  removed: number
  kept: number
  skippedNull: number
}

/**
 * Collapse duplicate cron jobs by exact full name (case-insensitive).
 * Jobs with a NULL name are never grouped — they are skipped entirely (C3).
 * Within each name group the earliest `time_created` is kept and every other
 * id is removed (D6).
 */
export const dedupe = Effect.fn("Cli.cron.dedupe")(() =>
  Effect.gen(function* () {
    const svc = yield* CronJobs.Service
    const jobs = yield* svc.list()

    const byName = new Map<string, CronJobs.CronJob[]>()
    let skippedNull = 0
    for (const job of jobs) {
      if (job.name == null) {
        skippedNull += 1
        continue
      }
      const key = job.name.trim().toLowerCase()
      const group = byName.get(key)
      if (group) group.push(job)
      else byName.set(key, [job])
    }

    const removeIds: string[] = []
    let kept = 0
    for (const group of byName.values()) {
      let earliest = group[0]
      for (const job of group) {
        if (job.time_created < earliest.time_created) earliest = job
      }
      kept += 1
      for (const job of group) {
        if (job.id !== earliest.id) removeIds.push(job.id)
      }
    }

    for (const id of removeIds) {
      yield* svc.remove(id)
    }

    const result: DedupeResult = { removed: removeIds.length, kept, skippedNull }
    yield* Effect.logInfo("DedupeResult", result)
    return result
  }),
)

// ─── Subcommands ───────────────────────────────────────────────────────────

const AddCommand = effectCmd({
  command: "add <schedule> <prompt>",
  describe: "Create a cron job",
  builder: (yargs: Argv) =>
    yargs
      .positional("schedule", {
        describe: "Schedule expression (cron, interval in seconds, or ISO date)",
        type: "string",
      })
      .positional("prompt", {
        describe: "Prompt to execute",
        type: "string",
      })
      .option("name", {
        describe: "Job name",
        type: "string",
      })
      .option("model", {
        describe: "Model to use (e.g. anthropic/claude-sonnet-4)",
        type: "string",
      })
      .option("skills", {
        describe: "Comma-separated skills",
        type: "string",
      })
      .option("workdir", {
        describe: "Working directory for the cron job",
        type: "string",
      })
      .option("repeat", {
        describe: "Number of times to repeat the job",
        type: "number",
      })
      .option("schedule-kind", {
        describe: "Schedule kind (auto-detected from expression if omitted)",
        type: "string",
        choices: ["cron", "interval", "once"] as const,
      })
      .option("notify", {
        describe: "Show a native OS notification before executing the job",
        type: "boolean",
        default: false,
      }),
  handler: (args) =>
    Effect.gen(function* () {
      const scheduleKind = args["schedule-kind"] ?? detectScheduleKind(args.schedule!)
      const svc = yield* CronJobs.Service
      const job = yield* svc.create({
        prompt: args.prompt!,
        schedule_kind: scheduleKind,
        schedule_expr: args.schedule!,
        name: args.name,
        model: args.model,
        skills: args.skills,
        workdir: args.workdir,
        repeat_times: args.repeat !== undefined ? Number(args.repeat) : undefined,
        notify: args.notify === true ? 1 : undefined,
      })
      console.log(job.id)
    }).pipe(
      Effect.provide(cronLayer),
      Effect.catchTag("CronJobServiceError", (e) => cliFail(e.message)),
    ),
})

const ListCommand = effectCmd({
  command: "list",
  describe: "List all cron jobs",
  handler: () =>
    Effect.gen(function* () {
      const svc = yield* CronJobs.Service
      const jobs = yield* svc.list()
      console.log(formatJobTable(jobs))
    }).pipe(
      Effect.provide(cronLayer),
      Effect.catchTag("CronJobServiceError", (e) => cliFail(e.message)),
    ),
})

const RemoveCommand = effectCmd({
  command: "remove <id>",
  describe: "Remove a cron job",
  builder: (yargs: Argv) =>
    yargs
      .positional("id", { describe: "Job ID", type: "string" })
      .option("force", {
        describe: "Skip confirmation prompt",
        type: "boolean",
        alias: "f",
      }),
  handler: (args) =>
    Effect.gen(function* () {
      const svc = yield* CronJobs.Service
      const job = yield* svc.get(args.id!)

      if (!job) return yield* cliFail(`Job not found: ${args.id}`)

      if (!args.force) {
        const name = job.name ?? job.id
        const answer = yield* Effect.promise(() => UI.input(`Remove job '${name}'? [y/N] `))
        if (answer.toLowerCase() !== "y") return
      }

      yield* svc.remove(args.id!)

      UI.println(UI.Style.TEXT_SUCCESS_BOLD + `Removed job '${job.name ?? job.id}'` + UI.Style.TEXT_NORMAL)
    }).pipe(
      Effect.provide(cronLayer),
      Effect.catchTag("CronJobServiceError", (e) => cliFail(e.message)),
    ),
})

const PauseCommand = effectCmd({
  command: "pause <id>",
  describe: "Pause a cron job",
  builder: (yargs: Argv) =>
    yargs.positional("id", { describe: "Job ID", type: "string" }),
  handler: (args) =>
    Effect.gen(function* () {
      const svc = yield* CronJobs.Service
      const job = yield* svc.get(args.id!)

      if (!job) return yield* cliFail(`Job not found: ${args.id}`)

      yield* svc.update(args.id!, { enabled: 0 })

      UI.println(`Paused '${job.name ?? job.id}'`)
    }).pipe(
      Effect.provide(cronLayer),
      Effect.catchTag("CronJobServiceError", (e) => cliFail(e.message)),
    ),
})

const ResumeCommand = effectCmd({
  command: "resume <id>",
  describe: "Resume a paused cron job",
  builder: (yargs: Argv) =>
    yargs.positional("id", { describe: "Job ID", type: "string" }),
  handler: (args) =>
    Effect.gen(function* () {
      const svc = yield* CronJobs.Service
      const job = yield* svc.get(args.id!)

      if (!job) return yield* cliFail(`Job not found: ${args.id}`)

      const now = new Date()
      const nextDate = CronJobs.computeNextRun(
        { schedule_kind: job.schedule_kind, schedule_expr: job.schedule_expr },
        now,
      )
      const nextRunAt = nextDate ? nextDate.getTime() : null

      yield* svc.update(args.id!, { enabled: 1, next_run_at: nextRunAt })

      UI.println(`Resumed '${job.name ?? job.id}'`)
    }).pipe(
      Effect.provide(cronLayer),
      Effect.catchTag("CronJobServiceError", (e) => cliFail(e.message)),
    ),
})

const StatusCommand = effectCmd({
  command: "status [id]",
  describe: "Show cron job status",
  builder: (yargs: Argv) =>
    yargs.positional("id", { describe: "Job ID", type: "string" }),
  handler: (args) =>
    Effect.gen(function* () {
      if (!args.id) return yield* cliFail("Job ID is required")

      const svc = yield* CronJobs.Service
      const job = yield* svc.get(args.id!)

      if (!job) return yield* cliFail(`Job not found: ${args.id}`)

      console.log(formatJobStatus(job))
    }).pipe(
      Effect.provide(cronLayer),
      Effect.catchTag("CronJobServiceError", (e) => cliFail(e.message)),
    ),
})

const DedupeCommand = effectCmd({
  command: "dedupe",
  describe: "Remove duplicate cron jobs by name, keeping the earliest",
  handler: () =>
    Effect.gen(function* () {
      const result = yield* dedupe()
      UI.println(`Dedupe complete: ${result.removed} removed, ${result.kept} kept, ${result.skippedNull} skipped (unnamed)`)
    }).pipe(
      Effect.provide(cronLayer),
      Effect.catchTag("CronJobServiceError", (e) => cliFail(e.message)),
    ),
})

const TriggerCommand = effectCmd({
  command: "trigger <id>",
  describe: "Trigger a cron job immediately",
  builder: (yargs: Argv) =>
    yargs.positional("id", { describe: "Job ID", type: "string" }),
  handler: (args) =>
    Effect.gen(function* () {
      const svc = yield* CronJobs.Service
      const job = yield* svc.get(args.id!)

      if (!job) return yield* cliFail(`Job not found: ${args.id}`)

      UI.println(`Triggered '${job.name ?? job.id}' — running now`)

      const executor = yield* CronExecutor.Service
      yield* executor.execute(job)
    }).pipe(
      Effect.provide(CronExecutor.layer),
      Effect.provide(cronLayer),
      Effect.catchTag("CronJobServiceError", (e) => cliFail(e.message)),
    ) as Effect.Effect<void, CliError>,
})

// ─── Parent Command ────────────────────────────────────────────────────────

export const CronCommand = effectCmd({
  command: "cron",
  describe: "Manage cron jobs",
  builder: (yargs: Argv) =>
    yargs
      .command(AddCommand)
      .command(ListCommand)
      .command(RemoveCommand)
      .command(PauseCommand)
      .command(ResumeCommand)
      .command(StatusCommand)
      .command(TriggerCommand)
      .command(DedupeCommand)
      .demandCommand(1, "Specify an action: add, list, remove, pause, resume, status, trigger, dedupe"),
  handler: Effect.fn("Cli.cron")(function* () {}),
})
