import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import DESCRIPTION from "./cron.txt"
import { execSync } from "child_process"

export const Parameters = Schema.Struct({
  action: Schema.optional(Schema.Literal("list", "status")).annotate({
    description: "What to do: list all cron jobs (default)",
    default: "list",
  }),
})

function findOpenCode(): string {
  const candidates = [
    process.env.LOCALAPPDATA
      ? `${process.env.LOCALAPPDATA}/opencode/bin/opencode.exe`
      : null,
    process.env.HOME ? `${process.env.HOME}/.local/share/opencode/bin/opencode` : null,
    "opencode",
  ].filter(Boolean) as string[]

  for (const c of candidates) {
    try {
      execSync(`"${c}" --version`, { stdio: "ignore", timeout: 3000 })
      return c
    } catch {}
  }
  return "opencode"
}

export const CronTool = Tool.define(
  "cron",
  Effect.gen(function* () {
    const binary = findOpenCode()

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, _ctx: Tool.Context) =>
        Effect.gen(function* () {
          const action = params.action ?? "list"

          try {
            const output = execSync(`"${binary}" cron ${action}`, {
              encoding: "utf-8",
              timeout: 10000,
              stdio: ["ignore", "pipe", "pipe"],
            })

            const title = action === "status"
              ? "Cron job status"
              : "Cron jobs"

            return {
              title,
              output: output.trim() || "No cron jobs found",
              metadata: {},
            }
          } catch (err: any) {
            const msg = err?.stderr?.toString() || err?.message || String(err)
            return {
              title: "Cron query failed",
              output: msg.trim() || "Failed to query cron jobs",
              metadata: {},
            }
          }
        }).pipe(Effect.orDie),
    }
  }),
)
