import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import DESCRIPTION from "./cron.txt"
import { execSync } from "child_process"

export const Parameters = Schema.Struct({
  action: Schema.optional(Schema.Literal("list")).annotate({
    description: "What to do: list cron jobs",
    default: "list",
  }),
})

function findOpenCode(): string | null {
  if (process.platform === "win32" && process.env.LOCALAPPDATA) {
    const exe = `${process.env.LOCALAPPDATA}\\opencode\\bin\\opencode.exe`
    try {
      execSync(`"${exe}" --version`, { stdio: "ignore", timeout: 5000 })
      return exe
    } catch {}
  }
  try {
    execSync("opencode --version", { stdio: "ignore", timeout: 5000 })
    return "opencode"
  } catch {}
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
              title: "Cron — binary missing",
              output: "opencode CLI not found at %LOCALAPPDATA%\\opencode\\bin\\opencode.exe",
              metadata: {},
            }
          }

          const dataDir = getDesktopDataDir()
          const env = dataDir
            ? { ...process.env, XDG_DATA_HOME: dataDir }
            : process.env

          try {
            const output = execSync(`"${binary}" cron list`, {
              encoding: "utf-8",
              timeout: 10000,
              env: env as any,
              stdio: ["ignore", "pipe", "pipe"],
            })
            return {
              title: "Cron jobs",
              output: output.trim() || "No cron jobs found",
              metadata: {},
            }
          } catch (err: any) {
            return {
              title: "Cron query error",
              output: err?.stderr?.toString() || err?.message || "Unknown error",
              metadata: {},
            }
          }
        }).pipe(Effect.orDie),
    }
  }),
)
