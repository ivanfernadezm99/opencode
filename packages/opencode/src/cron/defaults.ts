import { Effect } from "effect"
import path from "path"
import { CronJobs } from "./jobs"
import { Global } from "@opencode-ai/core/global"
import { FSUtil } from "@opencode-ai/core/fs-util"

// ─── Default Cron Jobs ──────────────────────────────────────────────────────

const defaultJobs = [
  {
    name: "Recordatorio cargar horas Redmine",
    schedule: "30 17 * * 1-5",
    prompt:
      "Revisá las horas cargadas esta semana en Redmine usando el skill redmine-time-entries. " +
      "Mostrame un resumen de qué días ya están completos y cuáles faltan cargar. " +
      "Preguntame si quiero cargar las horas faltantes ahora. " +
      "Si ya está todo completo para la semana, solo confirmalo.",
    skills: "redmine-time-entries",
    notify: 1,
  },
]

// ─── Seed Logic ─────────────────────────────────────────────────────────────

/**
 * Create default cron jobs if they don't already exist.
 * Idempotent: uses a version stamp file to skip re-creation.
 */
export function seedDefaultCrons(version: string) {
  return Effect.gen(function* () {
    const cronJobs = yield* CronJobs.Service
    const global = yield* Global.Service
    const fs = yield* FSUtil.Service

    const stampFile = path.join(global.data, ".default-crons-version")

    // Check stamp file
    const stamped = yield* fs.readFileStringSafe(stampFile).pipe(
      Effect.map((content) => content?.trim() ?? ""),
    )
    if (stamped === version) return

    // Get existing jobs to avoid duplicates
    const existing = yield* cronJobs.list().pipe(
      Effect.catch(() => Effect.succeed([] as never)),
    )
    const existingNames = new Set(existing.map((j) => j.name))

    for (const def of defaultJobs) {
      if (existingNames.has(def.name)) continue

      yield* cronJobs
        .create({
          prompt: def.prompt,
          schedule_kind: "cron",
          schedule_expr: def.schedule,
          name: def.name,
          skills: def.skills,
          notify: def.notify,
        })
        .pipe(
          Effect.catch((e) =>
            Effect.logWarning(`Failed to create default cron "${def.name}"`, e),
          ),
        )
    }

    // Write stamp
    yield* fs.writeWithDirs(stampFile, version).pipe(
      Effect.catch(() => Effect.void),
    )
  })
}

export * as CronDefaults from "./defaults"
