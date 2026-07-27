# Design: Cron System

## Technical Approach

3-layer architecture: **Storage** (Drizzle schema + queries in `packages/core`), **Scheduler** (Effect service tick loop in `packages/opencode`), and **Execution** (AIAgent runner per job). The scheduler forks a scoped fiber from the server's `listenEffect()` — it lives alongside the HTTP listener and terminates on shutdown.

---

## Architecture Decisions

### Decision: Tick loop as Effect fiber, not OS cron

| Option | Tradeoff | Decision |
|--------|----------|----------|
| Effect `repeat` + `forkScoped` | Lifecycle tied to server; no external process | ✅ Chosen — matches Hermes design |
| OS cron / systemd timer | Survives server crashes; harder lifecycle mgmt | ❌ Rejected — jobs are server-scoped |

**Rationale**: Cron jobs are server-scoped work. When the server stops, cron stops. This avoids pidfile/lock daemon overhead.

### Decision: `advanceNextRun()` BEFORE execution (at-most-once)

| Option | Tradeoff | Decision |
|--------|----------|----------|
| Pre-advance | Double-fire only if DB write succeeds but execution crashes; next tick skips due to future next_run_at | ✅ Chosen |
| Post-advance | Crash after execution leaves job due for re-dispatch = double-fire | ❌ Rejected |

**Rationale**: Pre-advance trades guaranteed execution for guaranteed at-most-once. The grace window (120s–7200s) provides missed-job recovery without duplicates.

### Decision: Workdir jobs serialize; non-workdir jobs parallel

| Option | Tradeoff | Decision |
|--------|----------|----------|
| Partitioned dispatch | TERMINAL_CWD is not concurrency-safe; serial per workdir | ✅ Chosen |
| All parallel | Workdir mutation races | ❌ Rejected |

**Rationale**: Jobs without a fixed directory are stateless agents — safe to run concurrently. Workdir jobs mutate CWD state and must serialize.

### Decision: Separate `jobs.ts` from `scheduler.ts` (multi-sibling dir, no barrel)

Follows `AGENTS.md` rule: multi-sibling directories keep each sibling as its own file with self-export. No `index.ts` barrel. Consumers import specifically: `import { CronJobs } from "@/cron/jobs"`.

---

## Data Flow

```
CLI add ──→ CronJobs.create() ──→ Drizzle INSERT cron_job ──→ SQLite

Server start ──→ listenEffect()
                     │
                     └── cronLayer ──→ forkScoped tick fiber
                                           │
tick() every 60s:                           │
  1. getDueJobs() ──→ SQL: next_run_at <= now              │
  2. computeGraceWindow() ──→ filter missed-beyond-recovery │
  3. advanceNextRun(job) ──→ UPDATE next_run_at (pre-advance)
  4. ╔═ partition by workdir ═══════════╗
     ║  workdir=null  → parallel (fork) ║
     ║  workdir!=null → serial (seq)    ║
     ╚═══════════════════════════════════╝
  5. CronExecutor.run(job) ──→ new AIAgent → execute prompt
  6. Save output → ~/.opencode/cron/output/{id}/{ts}.md
  7. markJobRun(job, status) ──→ UPDATE cron_job

Server shutdown ──→ Scope.close()
                       │
                       └── await in-flight fibers (30s timeout)
                       └── interrupt tick fiber
```

---

## File Changes

| File | Action | Description |
|------|--------|-------------|
| `packages/core/src/cron/cron-job.sql.ts` | Create | Drizzle `cron_job` table + `Timestamps` mixin + self-export |
| `packages/opencode/src/cron/jobs.ts` | Create | `CronJobs` service: CRUD, `getDueJobs`, `advanceNextRun`, `markJobRun`, `computeNextRun` |
| `packages/opencode/src/cron/scheduler.ts` | Create | `CronScheduler` service: tick loop, grace window, dispatch partitioning, fiber lifecycle |
| `packages/opencode/src/cron/executor.ts` | Create | `CronExecutor`: AIAgent construction, prompt execution, output persistence |
| `packages/opencode/src/server/server.ts` | Modify | Add `cronLayer` merge in `listenerLayer()` |
| `packages/opencode/src/cli/cron.ts` | Create | CLI subcommands: add, list, remove, pause, resume, status, trigger |
| `packages/opencode/src/index.ts` | Modify | Register `CronCommand` |
| `packages/opencode/package.json` | Modify | Add `cron-parser` dependency |

---

## Interfaces / Contracts

### Drizzle Table: `cron_job`

```ts
// packages/core/src/cron/cron-job.sql.ts
import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core"
import { Timestamps } from "../database/schema"

export const CronJobTable = sqliteTable("cron_job", {
  id: text().primaryKey(),
  name: text(),
  prompt: text().notNull(),
  schedule_kind: text().notNull(),       // "cron" | "interval" | "once"
  schedule_expr: text().notNull(),
  enabled: integer().notNull().default(1),
  state: text().notNull().default("scheduled"), // "scheduled" | "running" | "completed" | "error"
  next_run_at: integer(),
  last_run_at: integer(),
  last_status: text(),
  last_error: text(),
  model: text(),
  skills: text(),                        // JSON array stored as text
  workdir: text(),
  repeat_times: integer(),
  repeat_done: integer().notNull().default(0),
  ...Timestamps,
})
```

### Service: `CronJobs`

```ts
// packages/opencode/src/cron/jobs.ts
export interface Interface {
  create(input: CreateInput): Effect.Effect<CronJob>
  get(id: string): Effect.Effect<CronJob | null>
  list(): Effect.Effect<CronJob[]>
  update(id: string, data: Partial<CronJob>): Effect.Effect<CronJob>
  remove(id: string): Effect.Effect<void>
  getDueJobs(): Effect.Effect<CronJob[]>
  advanceNextRun(job: CronJob): Effect.Effect<CronJob>
  markJobRun(job: CronJob, status: string, error?: string): Effect.Effect<void>
  computeNextRun(job: CronJob): Effect.Effect<Date | null>
}
```

### Grace Window Formula

```ts
function computeGraceMs(schedule: CronJob): number {
  if (schedule.schedule_kind === "once") return 120_000
  const periodMs = schedule.schedule_kind === "interval"
    ? Number(schedule.schedule_expr) * 1000
    : cronPeriodMs(schedule.schedule_expr)
  return Math.max(120_000, Math.min(periodMs / 2, 7_200_000))
}
```

---

## Testing Strategy

| Layer | What to Test | Approach |
|-------|-------------|----------|
| Unit | `computeNextRun` for cron/interval/once, invalid expr | Pure function tests with `cron-parser` |
| Unit | `computeGraceMs` for all schedule kinds | Edge cases: sub-120s, super-7200s, once |
| Unit | `advanceNextRun` SQL update + at-most-once | Drizzle mock or in-memory SQLite |
| Unit | Dispatch partitioning (workdir vs non-workdir) | Test partition logic in isolation |
| Integration | Tick loop end-to-end (DB insert → tick → execution) | In-memory SQLite + mock executor |
| Integration | CLI subcommands parse correctly | yargs unit tests |
| E2E | Server start → cronLayer forked → tick fires | Full server bootstrap (slow, run manually) |

---

## Migration / Rollout

No data migration required — new table created on first Drizzle migration sync. The `cronLayer` is opt-in: it only activates when the server starts via `listenEffect()`. CLI commands work regardless of server state (direct DB access).

---

## Open Questions

- [ ] Confirm `AIAgent` construction API: does the executor need an existing `agent.make()` or a fresh `AIAgent` factory signature? Need to inspect `packages/opencode/src/agent/`.
- [ ] Confirm `~/.opencode/cron/output/` directory path — is `openCodeDir` accessible via existing `Global` service?
- [ ] Does the `INSTANCESTATE` pattern apply here, or is a plain `Layer.effect` sufficient? The scheduler is server-scoped, not per-project.
