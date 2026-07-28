import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260728161158_add-notify-to-cron",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`cron_job\` ADD \`notify\` integer DEFAULT 0 NOT NULL;`)
    })
  },
} satisfies DatabaseMigration.Migration
