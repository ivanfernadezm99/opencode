import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import DESCRIPTION from "./cron.txt"
import { CronJobs } from "../cron/jobs"

export const Parameters = Schema.Struct({
  action: Schema.optional(Schema.Literal("list")).annotate({
    description: "What to do: list cron jobs (only 'list' supported)",
    default: "list",
  }),
})

function formatTable(jobs: any[]): string {
  if (!jobs || jobs.length === 0) return "No cron jobs found"
  const lines: string[] = ["NAME | SCHEDULE | NEXT RUN | STATE"]
  for (const job of jobs) {
    const name = job.name ?? "(unnamed)"
    const schedule = job.schedule_expr ?? job.schedule ?? "?"
    const nextRun = job.next_run_at
      ? new Date(job.next_run_at).toISOString().replace("T", " ").slice(0, 16)
      : "pending"
    lines.push(`${name} | ${schedule} | ${nextRun} | ${job.state ?? "?"}`)
  }
  return lines.join("\n")
}

export const CronTool = Tool.define(
  "cron",
  Effect.gen(function* () {
    const cronJobs = yield* CronJobs.Service

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (_params: Schema.Schema.Type<typeof Parameters>, _ctx: Tool.Context) =>
        Effect.gen(function* () {
          const jobs = yield* cronJobs.list().pipe(Effect.orDie)
          const output = formatTable(jobs)
          return {
            title: `Cron jobs (${jobs.length})`,
            output,
            metadata: { count: jobs.length },
          }
        }).pipe(Effect.orDie),
    }
  }),
)
