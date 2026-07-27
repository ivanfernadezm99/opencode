# Proposal: Cron System

## Intent

Add background job scheduling to opencode — cron expressions, intervals, and one-shot jobs executed while the server runs. Users schedule AI prompts on a timer without keeping a session open.

## Scope

### In Scope
- Drizzle `cron_job` table + CRUD operations
- Effect fiber ticker evaluating schedules via `cron-parser`
- Parallel execution (no workdir) / serial execution (with workdir, mutates TERMINAL_CWD)
- Grace window catch-up at server restart: `max(120s, min(period/2, 7200s))`; one-shot = 120s
- Output persistence to `~/.opencode/cron/output/{job_id}/`
- CLI: `opencode cron add|list|remove|pause|resume|status|trigger`
- Failure logging: SQLite (`last_status`, `last_error`), filesystem trace, `Effect.logError`
- New dep: `cron-parser` (~15KB, zero native deps)
- Hook ticker into server scope (TUI, headless, desktop sidecar)

### Out of Scope
- `no_agent` script execution mode
- Job chaining (`context_from`)
- External delivery (Telegram, email, webhook)
- Dashboard / monitoring UI
- Skill auto-loading for cron jobs

## Capabilities

### New Capabilities
- `cron-job-storage`: Drizzle schema, CRUD, `computeNextRun`, `getDueJobs`, `advanceNextRun`, `markJobRun`
- `cron-scheduler`: `Effect.repeat` ticker every 60s, grace window, at-most-once semantics, configurable concurrency via `OPENCODE_CRON_MAX_PARALLEL`
- `cron-executor`: AIAgent construction per job, output persistence, failure recording
- `cron-cli`: CLI surface for job lifecycle management

### Modified Capabilities
None — entirely new subsystem.

## Approach

3-layer architecture:

1. **Storage** — `packages/core/src/cron/cron-job.sql.ts` (Drizzle schema + queries), `packages/opencode/src/cron/jobs.ts` (CRUD + schedule math). `advanceNextRun()` runs BEFORE execution → at-most-once semantics.

2. **Scheduler** — `packages/opencode/src/cron/scheduler.ts`. `tick()` evaluates due jobs, partitions by workdir, dispatches. Workdir jobs serial (TERMINAL_CWD mutation), others parallel via `Effect.forkIn`.

3. **Execution** — `packages/opencode/src/cron/executor.ts`. Fresh AIAgent per job run, conversation output saved to filesystem, `markJobRun()` persists result.

4. **Server hook** — `cronLayer` attached in `packages/opencode/src/server/server.ts` `listenEffect()`. Scoped fiber runs until shutdown. Graceful shutdown awaits in-flight jobs.

## Affected Areas

| Area | Impact | Description |
|------|--------|-------------|
| `packages/core/src/cron/cron-job.sql.ts` | New | Drizzle schema + queries |
| `packages/opencode/src/cron/jobs.ts` | New | CRUD ops, schedule math |
| `packages/opencode/src/cron/scheduler.ts` | New | Tick loop, dispatch |
| `packages/opencode/src/cron/executor.ts` | New | Job runner |
| `packages/opencode/src/server/server.ts` | Modified | Attach cronLayer |
| `packages/opencode/src/cron/cli.ts` | New | CLI commands |
| `packages/opencode/package.json` | Modified | Add cron-parser dep |

## Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| `cron-parser` timezone mismatch | Low | Use `Intl.DateTimeFormat` for system TZ |
| Server stop kills cron | Medium | Documented limitation (matches Hermes design) |
| AIAgent API rate limits | Low | `OPENCODE_CRON_MAX_PARALLEL` env var |
| Double-fire on crash | Low | at-most-once via pre-advance; grace window prevents duplicates |

## Rollback Plan

1. Remove `cronLayer` from `server.ts`
2. Drop `cron_job` table via Drizzle migration rollback
3. Remove `cron-parser` from `package.json`
4. Delete `packages/opencode/src/cron/` directory

## Dependencies

- `cron-parser` npm package (~15KB, zero native deps)
- Drizzle migration support (existing)

## Success Criteria

- [ ] `opencode cron add --schedule "0 9 * * 1-5" --prompt "..."` creates a persistent job
- [ ] Ticker fires the job at the correct time while server is running
- [ ] Output file written to `~/.opencode/cron/output/{job_id}/`
- [ ] Failed job shows `last_status='error'` and `last_error` in database
- [ ] `opencode cron status <id>` returns current state
- [ ] Graceful shutdown awaits in-flight jobs before exit
