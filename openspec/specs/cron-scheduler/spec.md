# Cron Scheduler Specification

## Purpose

Run a background tick loop that evaluates due cron jobs and dispatches them for execution. Provide at-most-once semantics, grace-window catch-up on server start, and configurable concurrency.

## Requirements

### Requirement: Tick Loop

The scheduler MUST run a `tick()` effect every 60 seconds via `Effect.repeat` + `Effect.delay(60000)`. The loop MUST be forked into server scope via `Effect.forkScoped` so it lives for the server's lifetime and terminates on server shutdown. The scheduler MUST run the backfill before the first due scan on start.

(Previously: the loop ran on schedule but never healed NULL `next_run_at` rows.)

#### Scenario: Ticker runs on schedule

- GIVEN the server starts with the cron layer
- WHEN server time advances 60 seconds
- THEN `tick()` is called exactly once

#### Scenario: Ticker stops on server shutdown

- GIVEN the cron ticker is running in server scope
- WHEN the server is shut down
- THEN the ticker fiber is interrupted and no further ticks execute

### Requirement: Grace Window

On server start, the grace window MUST use the formula `max(120_000, min(period / 2, 7_200_000))` ms for recurring jobs. For `once`-kind jobs, use a fixed `120_000` ms window. Jobs whose `next_run_at` falls within the grace window are considered due.

#### Scenario: Grace window catches missed cron

- GIVEN a cron job was due 5 minutes ago and the server just started
- WHEN the first `tick()` runs
- THEN the job is included in `getDueJobs()` and executed

#### Scenario: Outside grace window is skipped

- GIVEN a cron job was due 4 hours ago
- WHEN the first `tick()` runs after server restart
- THEN the job is NOT returned by `getDueJobs()` — it is considered missed beyond recovery

### Requirement: At-Most-Once Dispatch

`advanceNextRun()` MUST be called BEFORE job execution. If `advanceNextRun` succeeds while the job is being dispatched, a concurrent scheduler tick on the same job SHALL see the already-advanced `next_run_at` and skip it. A job that is due-but-not-yet-advanced (including one just backfilled) MUST NOT be fired twice within or across ticks. `advanceNextRun` MUST persist `next_run_at` ONLY when the computed value is strictly in the future (`computed.getTime() > now()`); it MUST NOT persist a past value. When the computed value is not in the future for a `once` job, `advanceNextRun` MUST mark the job done (`enabled = 0`, `state = "completed"`) instead of persisting a past `next_run_at`, so an expired `once` job does not remain due. For a recurring job that cannot be advanced (invalid expression), `advanceNextRun` MUST disable it and log instead of leaving it perpetually due.

(Previously: at-most-once applied only to already-due jobs; a NULL `next_run_at` job was never advanced and never fired, and an expired `once` job was persisted with a past `next_run_at`, staying due forever.)

#### Scenario: Advance prevents double-fire

- GIVEN a due job with `next_run_at=1000`
- WHEN `advanceNextRun(job)` advances it to `2000` before execution starts
- THEN the same tick does not pick up the job again — `getDueJobs` uses the new `next_run_at`

#### Scenario: Backfilled job fires once

- GIVEN a job backfilled to a due `next_run_at`
- WHEN the first tick dispatches and advances it
- THEN the job executes exactly once and a concurrent tick skips it because `next_run_at` is now in the future

### Requirement: Dispatch Partitioning

Workdir jobs (jobs with a non-null `workdir`) MUST execute serially per workdir because TERMINAL_CWD mutation is not concurrency-safe. Jobs without a workdir MAY execute in parallel via `Effect.forkIn`. The partition is computed per tick.

#### Scenario: Workdir jobs serialize per directory

- GIVEN 2 jobs with the same `workdir` are both due
- WHEN `tick()` dispatches them
- THEN they run one after the other, not concurrently

#### Scenario: Non-workdir jobs run in parallel

- GIVEN 2 jobs without `workdir` are both due
- WHEN `tick()` dispatches them
- THEN they run concurrently via separate forked fibers

### Requirement: Configurable Concurrency

The scheduler MUST read `OPENCODE_CRON_MAX_PARALLEL` (env var, default 5) to cap concurrent job dispatches across all partitions. When the limit is reached, remaining due jobs SHALL wait for the next tick.

#### Scenario: Concurrency cap throttles dispatch

- GIVEN 10 due non-workdir jobs and `OPENCODE_CRON_MAX_PARALLEL=3`
- WHEN `tick()` dispatches them
- THEN only 3 jobs are forked for execution; 7 are deferred to the next tick

### Requirement: Graceful Shutdown

The cron layer MUST track in-flight job fibers and await their completion on shutdown, with a configurable timeout (default 30s) before force-interrupting remaining fibers.

#### Scenario: In-flight jobs complete on shutdown

- GIVEN 2 jobs are currently running
- WHEN the server receives a shutdown signal
- THEN the server waits for completion (up to 30s) before exiting

### Requirement: Backfill on start

On start (and/or before the first due scan), the scheduler MUST run the cron-job-storage backfill to heal `next_run_at = NULL` for enabled jobs with parseable schedules, so jobs born dead in existing client DBs become due-able. The backfill MUST be idempotent and MUST NOT abort startup if an individual job cannot be scheduled. Enabled jobs with invalid or `once`-expired schedules MUST remain NULL and MUST NOT be scheduled.

#### Scenario: Start heals previously-dead jobs

- GIVEN an existing client DB where an enabled cron job has `next_run_at = NULL`
- WHEN the scheduler starts
- THEN the job's `next_run_at` is backfilled via `computeNextRun`
- AND the job is due and dispatched on the first tick once its computed time arrives

#### Scenario: Unschedulable job does not block startup

- GIVEN an enabled job with an invalid `schedule_expr` and NULL `next_run_at`
- WHEN the scheduler starts
- THEN startup completes, the job keeps `next_run_at = NULL`, and other jobs are unaffected

#### Scenario: Repeat runs do not heal again

- GIVEN all enabled jobs already have non-NULL `next_run_at`
- WHEN the scheduler starts again
- THEN no rows are modified