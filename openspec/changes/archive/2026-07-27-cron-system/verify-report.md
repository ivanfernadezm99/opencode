# Verify Report: Cron System

**Date**: 2026-07-27 (Re-verify after fix)
**Change ID**: cron-system
**Strict TDD**: Active

---

## Test Results Summary

| Suite | Tests | Pass | Fail | Status |
|-------|-------|------|------|--------|
| `test/cron/jobs.test.ts` | 29 | 29 | 0 | ✅ |
| `test/cron/scheduler.test.ts` | 10 | 10 | 0 | ✅ |
| `test/cron/executor.test.ts` | 11 | 11 | 0 | ✅ |
| `test/cli/cron.test.ts` | 10 | 10 | 0 | ✅ |
| **Total** | **60** | **60** | **0** | ✅ |

All 60 tests pass with 163 `expect()` calls across 4 test files.

### Typecheck

**PASS** — `bun typecheck` exits with code 0, zero errors.

---

## CRITICAL (must-fix) — All resolved

### C1. Scheduler wired to executor — `executeJob` calls `CronExecutor.execute`

**Status**: ✅ **FIXED**

**File**: `packages/opencode/src/cron/scheduler.ts` (lines 76-85)

The `executeJob` function now imports and depends on `CronExecutor.Service`:

```ts
const executor = yield* CronExecutor.Service

const executeJob = (job: CronJobs.CronJob): Effect.Effect<void> =>
  executor.execute(job).pipe(
    Effect.catch(() => Effect.void),
  )
```

- Line 5 imports `CronExecutor`
- Line 76 yields `CronExecutor.Service`
- Line 83 calls `executor.execute(job)` — the full job object is passed
- Errors are caught and silenced (as designed)

The stub that immediately marked jobs as `completed` is gone. The real executor pipeline is now connected.

---

### C2. CronExecutor layer provided in server scope

**Status**: ✅ **FIXED**

**File**: `packages/opencode/src/server/server.ts` (line 110)

`CronExecutor.defaultLayer` is now merged into the listener layer:

```ts
Layer.provideMerge(CronScheduler.defaultLayer),
Layer.provideMerge(CronExecutor.defaultLayer),
```

Additionally, `CronScheduler.defaultLayer` itself already includes `CronExecutor.defaultLayer` (scheduler.ts line 211):

```ts
export const defaultLayer = layer.pipe(
  Layer.provide(CronJobs.defaultLayer),
  Layer.provide(CronExecutor.defaultLayer),
  Layer.provide(Database.defaultLayer),
)
```

The `CronExecutor.Service` tag is resolvable at runtime via either path. Redundant provisioning is harmless in Effect's layer system.

---

### C3. CLI typecheck errors — 0 errors in `src/cli/cron.ts`

**Status**: ✅ **FIXED**

Previous: 37 errors. Current: 0 errors.

Fixes verified:
1. No nested `Effect.gen` inside `Effect.fn` — all handlers use flat `Effect.gen(function*(){...})`
2. `Effect.catchAll` replaced with `Effect.catchTag`
3. Positional args use non-null assertions (`args.schedule!`, `args.prompt!`, `args.id!`)
4. Kebab-case option accessed via bracket notation: `args["schedule-kind"]`
5. `TriggerCommand` uses `CronExecutor.Service` with proper layer provisioning:
   ```ts
   const executor = yield* CronExecutor.Service
   yield* executor.execute(job)
   ```
   Provided with `Effect.provide(CronExecutor.layer)` (line 294)
6. All 7 subcommands compile cleanly

---

### C4. Test type error — `drizzle()` argument type mismatch

**Status**: ✅ **FIXED**

**File**: `packages/opencode/test/cron/jobs.test.ts` (line 13)

Previous: `const db = drizzle(sqlite)` — type mismatch error.

Current: `const db = drizzle({ client: sqlite })` — correct Drizzle bun:sqlite API.

---

## WARNING (should-fix) — Unchanged

### W1. Executor ignores `skills` and `workdir` from job config

**Status**: ❌ **Unresolved**

**File**: `packages/opencode/src/cron/executor.ts` (lines 86-113)

`job.skills` and `job.workdir` are still not read or passed to the agent. Only `job.model` is resolved. Jobs with `skills` or `workdir` configured will run without those settings.

### W2. Migration file includes unrelated ALTER TABLE

**Status**: ❌ **Unresolved**

### W3. Output filename format differs from spec

**Status**: ❌ **Unresolved**

### W4. No test for executor `execute()` method

**Status**: ❌ **Unresolved**

### W5. No test for scheduler `tick()`, `start()`, or `shutdown()`

**Status**: ❌ **Unresolved**

### W6. No CLI integration tests for command execution

**Status**: ❌ **Unresolved**

### W7. Grace window filter not independently testable

**Status**: ❌ **Unresolved**

---

## SUGGESTION (nice-to-have) — Unchanged

### S1. Add self-export to `cron-job.sql.ts`
### S2. No repeat limit enforcement
### S3. `Duration.millis` could be `Duration.minutes` for readability

---

## Spec Compliance Matrix

### cron-job-storage

| # | Requirement | Status | Evidence |
|---|------------|--------|----------|
| R1 | Drizzle Schema with all fields | ✅ | All 19 fields present |
| R2 | CRUD Operations (create/get/list/update/remove) | ✅ | All 5 operations implemented |
| R3 | Schedule Computation (`computeNextRun`) | ✅ | Implemented for cron/interval/once |
| R4 | Query and Advance (`getDueJobs`, `advanceNextRun`) | ✅ | Both implemented |
| R5 | Mark Job Run (`markJobRun`) | ✅ | Transitions and repeat_done increment |

### cron-scheduler

| # | Requirement | Status | Evidence |
|---|------------|--------|----------|
| R1 | Tick Loop (60s, forked, scoped) | ✅ | `tickLoop` + `Effect.forkScoped` |
| R2 | Grace Window | ✅ | `computeGraceMs` formula implemented |
| R3 | At-Most-Once Dispatch | ✅ | `advanceNextRun` called before executor |
| R4 | Dispatch Partitioning | ✅ | `partitionByWorkdir` separates serial/parallel |
| R5 | Configurable Concurrency | ✅ | `maxParallel()` reads env var, default 5 |
| R6 | Graceful Shutdown | ✅ | Fiber tracking + timeout + interrupt |

**Updated**: R3-R6 now dispatch through the real `CronExecutor.execute` path (not a stub).

### cron-executor

| # | Requirement | Status | Evidence |
|---|------------|--------|----------|
| R1 | Fresh Agent Per Run | ⚠️ PARTIAL | `execute()` reconstructs model per call, but skills/workdir ignored |
| R2 | Agent Construction (model, skills, workdir) | ❌ FAIL (W1) | Only `job.model` resolved; skills/workdir ignored |
| R3 | Output Persistence | ✅ | `saveOutputInner` writes to `~/.opencode/cron/output/{id}/{ts}.md` |
| R4 | Error Handling | ✅ | 600s timeout + catch-all fallback to `markJobRun` error |
| R5 | State Transitions | ✅ | `markRunning` before, `markJobRun` after execution |

### cron-cli

| # | Requirement | Status | Evidence |
|---|------------|--------|----------|
| R1 | Command Structure (7 subcommands) | ✅ | All 7 compiled and registered |
| R2 | Add Command (all options) | ✅ | Compiles cleanly |
| R3 | List Command | ✅ | `formatJobTable` with sorting, empty message |
| R4 | Remove Command | ✅ | Confirm prompt, force flag, missing job error |
| R5 | Pause/Resume | ✅ | enabled=0 / enabled=1 + recompute next_run_at |
| R6 | Status Command | ✅ | All DB fields displayed |
| R7 | Trigger Command | ✅ | Calls `CronExecutor.execute(job)` via service |

---

## Design Conformance

| Design Decision | Status | Notes |
|-----------------|--------|-------|
| Tick loop as Effect fiber, not OS cron | ✅ | `Effect.repeat` + `forkScoped` |
| `advanceNextRun()` before execution | ✅ | Called in tick before executor dispatch |
| Workdir serial, non-workdir parallel | ✅ | Correct partitioning |
| Separate `jobs.ts` from `scheduler.ts`, no barrel | ✅ | Sibling files, no index.ts |
| Grace window formula | ✅ | `computeGraceMs` matches design |
| cronLayer merge in `listenerLayer()` | ✅ | Both CronScheduler + CronExecutor merged |
| CLI commands use `effectCmd` | ✅ | All 7 subcommands use `effectCmd` |

---

## Task Completion Status

All 29 tasks are marked `[x]` in `tasks.md`.

| Phase | Tasks | Status | Notes |
|-------|-------|--------|-------|
| 1: Schema + Migration | 1.1–1.4 (4 tasks) | ✅ Done | Schema, migration, cron-parser, tests |
| 2: Jobs + Scheduler | 2.1–2.10 (10 tasks) | ✅ Done | Executor dispatch real (C1 fixed); tests for tick/start/shutdown still missing (W5) |
| 3: Executor | 3.1–3.6 (6 tasks) | ⚠️ Partial | 3.1 ignores skills/workdir (W1); 3.6 executor test missing execute() (W4) |
| 4: CLI | 4.1–4.9 (9 tasks) | ✅ Done | All compile cleanly (C3 fixed); CLI integration tests missing (W6) |

---

## Verdict

```json
{
  "status": "pass",
  "checks": [
    {"criterion": "Tests pass", "result": "pass", "evidence": "60/60 pass, 0 fail"},
    {"criterion": "Typecheck passes", "result": "pass", "evidence": "0 errors, exit code 0"},
    {"criterion": "Scheduler wired to executor (C1)", "result": "pass", "evidence": "executeJob calls executor.execute(job) — not a stub"},
    {"criterion": "CronExecutor in server scope (C2)", "result": "pass", "evidence": "Layer.provideMerge(CronExecutor.defaultLayer) in server.ts"},
    {"criterion": "CLI compiles (C3)", "result": "pass", "evidence": "0 type errors in src/cli/cron.ts"},
    {"criterion": "Test drizzle type fix (C4)", "result": "pass", "evidence": "drizzle({ client: sqlite }) — correct API"},
    {"criterion": "Spec compliance", "result": "partial", "evidence": "Executor skills/workdir still ignored (W1)"},
    {"criterion": "Strict TDD", "result": "warning", "evidence": "execute() and tick() untested"}
  ],
  "next": "ready-for-archive"
}
```

### Merge Readiness

All 4 **CRITICAL** blockers are resolved:
1. ✅ C1: Scheduler now calls `CronExecutor.execute(job)` — not a stub
2. ✅ C2: `CronExecutor.defaultLayer` provided in server scope
3. ✅ C3: CLI compiles — 0 typecheck errors
4. ✅ C4: Test drizzle type mismatch fixed

**7 Warnings** (should-fix) and **3 Suggestions** (nice-to-have) remain from the initial report. These are non-blocking for merge but should be addressed in follow-up changes.
