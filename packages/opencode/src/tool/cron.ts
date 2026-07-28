import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import DESCRIPTION from "./cron.txt"
import { CronJobs } from "../cron/jobs"

export const Parameters = Schema.Struct({
  action: Schema.Literal("list", "status").annotate({
    description: "What to do: list all cron jobs or show status of one",
    default: "list",
  }),
  jobId: Schema.optional(Schema.String).annotate({
    description: "Job ID to check status for (only needed when action is 'status')",
  }),
})

function formatJobTable(jobs: CronJobs.CronJob[]): string {
  if (jobs.length === 0) return "No cron jobs found"

  const lines: string[] = ["NAME | SCHEDULE | NEXT RUN | STATE"]
  lines.push("─".repeat(60))
  for (const job of jobs) {
    const name = job.name ?? "(unnamed)"
    const schedule = job.schedule_kind === "interval"
      ? `every ${job.schedule_expr}s`
      : job.schedule_expr
    const nextRun = job.next_run_at
      ? new Date(job.next_run_at).toISOString().replace("T", " ").slice(0, 16)
      : "pending"
    lines.push(`${name} | ${schedule} | ${nextRun} | ${job.state}`)
  }
  return lines.join("\n")
}

function formatJobStatus(job: CronJobs.CronJob): string {
  return [
    `Name:        ${job.name ?? "-"}`,
    `Schedule:    ${job.schedule_kind} ${job.schedule_expr}`,
    `Enabled:     ${job.enabled ? "yes" : "no"}`,
    `State:       ${job.state}`,
    `Next run:    ${job.next_run_at ? new Date(job.next_run_at).toISOString().replace("T", " ").slice(0, 16) : "pending"}`,
    `Last run:    ${job.last_run_at ? new Date(job.last_run_at).toISOString().replace("T", " ").slice(0, 16) : "-"}`,
    `Last status: ${job.last_status ?? "-"}`,
    `Last error:  ${job.last_error ?? "-"}`,
    `Notify:      ${job.notify ? "yes" : "no"}`,
    `Model:       ${job.model ?? "(default)"}`,
    `Skills:      ${job.skills ?? "(none)"}`,
    `Created:     ${new Date(job.time_created).toISOString().replace("T", " ").slice(0, 16)}`,
  ].join("\n")
}

export const CronTool = Tool.define(
  "cron",
  Effect.gen(function* () {
    const cronJobs = yield* CronJobs.Service

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, _ctx: Tool.Context) =>
        Effect.gen(function* () {
          if (params.action === "status" && params.jobId) {
            const job = yield* cronJobs.get(params.jobId).pipe(Effect.orDie)
            if (!job) {
              return {
                title: "Cron job not found",
                output: `No job found with ID: ${params.jobId}`,
                metadata: {},
              }
            }
            return {
              title: `Cron: ${job.name ?? job.id}`,
              output: formatJobStatus(job),
              metadata: { job },
            }
          }

          const jobs = yield* cronJobs.list().pipe(Effect.orDie)
          return {
            title: `Cron jobs (${jobs.length})`,
            output: formatJobTable(jobs),
            metadata: { count: jobs.length, jobs },
          }
        }).pipe(Effect.orDie),
    }
  }),
)
