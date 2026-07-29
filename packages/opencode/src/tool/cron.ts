import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import DESCRIPTION from "./cron.txt"
import { execSync } from "child_process"

export const Parameters = Schema.Struct({
  action: Schema.optional(Schema.Literal("list")).annotate({
    description: "What to do: list cron jobs (only 'list' supported)",
    default: "list",
  }),
})

function findOpenCode(): string | null {
  if (process.platform === "win32" && process.env.LOCALAPPDATA) {
    const exe = `${process.env.LOCALAPPDATA}\\opencode\\bin\\opencode.exe`
    try {
      execSync(`"${exe}" --version`, { stdio: "ignore", timeout: 5000 })
      return exe
    } catch { /* fall through */ }
  }
  try {
    execSync("opencode --version", { stdio: "ignore", timeout: 5000 })
    return "opencode"
  } catch { /* fall through */ }
  return null
}

function getDesktopDataDir(): string | null {
  if (process.platform === "win32" && process.env.APPDATA) {
    return `${process.env.APPDATA}\\ai.opencode.desktop.dev`
  }
  return null
}

export const CronTool = Tool.define(
  "cron",
  Effect.gen(function* () {
    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (_params: Schema.Schema.Type<typeof Parameters>, _ctx: Tool.Context) =>
        Effect.gen(function* () {
          const binary = findOpenCode()
          if (!binary) {
            return {
              title: "Cron — not available",
              output: "opencode CLI not found. Install it first or run from terminal: opencode cron list",
              metadata: {},
            }
          }

          try {
            const dataDir = getDesktopDataDir()
            let envVars = ""
            if (dataDir && process.platform === "win32") {
              envVars = `set "XDG_DATA_HOME=${dataDir}" && `
            } else if (dataDir) {
              envVars = `XDG_DATA_HOME="${dataDir}" `
            }

            const cmd = `${envVars}"${binary}" cron list`
            const output = execSync(cmd, {
              encoding: "utf-8",
              timeout: 10000,
              stdio: ["ignore", "pipe", "pipe"],
            })

            return {
              title: "Cron jobs",
              output: output.trim() || "No cron jobs found",
              metadata: {},
            }
          } catch (err: any) {
            const stderr = err?.stderr?.toString() || ""
            const message = err?.message || String(err)
            return {
              title: "Cron query failed",
              output: (stderr || message).trim() || "Failed to query cron jobs",
              metadata: {},
            }
          }
        }).pipe(Effect.orDie),
    }
  }),
)
