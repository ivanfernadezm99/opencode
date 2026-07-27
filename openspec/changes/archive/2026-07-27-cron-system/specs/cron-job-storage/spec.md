# Cron Job Storage Specification

## Purpose

Persist cron job definitions and execution state in SQLite via Drizzle. Expose CRUD operations and schedule-computation helpers consumed by the scheduler and CLI layers.

## Requirements

### Requirement: Drizzle Schema

The `cron_job` table MUST use snake_case field names and include: `id` (text PK, UUIDv7), `name` (text, nullable), `prompt` (text, not null), `schedule_kind` (text enum: `cron|interval|once`), `schedule_expr` (text, not null), `enabled` (integer boolean, default 1), `state` (text enum: `scheduled|running|completed|error`, default `scheduled`), `next_run_at` (integer, nullable), `last_run_at` (integer, nullable), `last_status` (text, nullable), `last_error` (text, nullable), `model` (text, nullable), `skills` (text JSON array, nullable), `workdir` (text, nullable), `repeat_times` (integer, nullable), `repeat_done` (integer, default 0), plus `time_created` and `time_updated` from the standard `Timestamps` mixin.

#### Scenario: Schema creates table

- GIVEN Drizzle migration runs
- WHEN the migration applies the `cron_job` table
- THEN a `cron_job` row with all fields can be inserted into SQLite

#### Scenario: Nullable defaults behave correctly

- GIVEN a new cron job with `enabled: true` and `state: "scheduled"`
- WHEN the row is inserted without explicit `enabled` or `state`
- THEN Drizzle defaults set `enabled=1` and `state="scheduled"`

### Requirement: CRUD Operations

The `CronJobs` service MUST expose `create`, `get`, `list`, `update`, and `remove` effects accepting and returning `Schema.Class`-typed records.

#### Scenario: Create and retrieve a job

- GIVEN valid job fields (prompt, schedule_kind, schedule_expr)
- WHEN `CronJobs.create(data)` is called
- THEN a row is inserted and returns the created job with a generated UUIDv7 id

#### Scenario: List returns all jobs

- GIVEN 3 cron jobs exist in the database
- WHEN `CronJobs.list()` is called
- THEN an array of 3 job records is returned, ordered by `time_created`

#### Scenario: Remove deletes by id

- GIVEN a job with id `abc-123` exists
- WHEN `CronJobs.remove("abc-123")` is called
- THEN the row is deleted and subsequent `get("abc-123")` returns `None`

### Requirement: Schedule Computation

`computeNextRun(job)` MUST parse `schedule_expr` using `cron-parser` and return the next `Date` as epoch ms. For `interval` kind, add `schedule_expr` (parsed as seconds) to `Date.now()`. For `once` kind, parse `schedule_expr` as an ISO date. Returns `null` when no valid next run exists.

#### Scenario: Cron expression evaluates correctly

- GIVEN a job with `schedule_kind: "cron"` and `schedule_expr: "0 9 * * 1-5"`
- WHEN `computeNextRun(job)` is called
- THEN the result is the next Monday-to-Friday at 09:00 local time, in epoch ms

#### Scenario: Invalid expression returns null

- GIVEN a job with `schedule_kind: "cron"` and `schedule_expr: "invalid"`
- WHEN `computeNextRun(job)` is called
- THEN the result is `null` and an error is logged via `Effect.logError`

### Requirement: Query and Advance

`getDueJobs()` MUST return enabled jobs where `next_run_at <= Date.now()`. `advanceNextRun(job)` MUST atomically set `next_run_at` to the next computed fire time and return the updated row — called BEFORE execution for at-most-once semantics.

#### Scenario: getDueJobs returns only due jobs

- GIVEN 3 jobs: one with `next_run_at` in the past, one in the future, one disabled
- WHEN `getDueJobs()` is called
- THEN only the enabled job with past `next_run_at` is returned

#### Scenario: advanceNextRun updates before execution

- GIVEN a due job with `next_run_at=1000`
- WHEN `advanceNextRun(job)` is called
- THEN the job's `next_run_at` is updated to the next computed time, and the old value is never executed

### Requirement: Mark Job Run

`markJobRun(job, status, error?)` MUST set `last_run_at`, `last_status`, `last_error`, update `state`, increment `repeat_done`, and optionally `next_run_at`. For `once` kind, set `enabled=false` after run.

#### Scenario: Mark successful completion

- GIVEN a job that just ran successfully
- WHEN `markJobRun(job, "completed")` is called
- THEN `last_run_at` is set, `last_status="completed"`, `state="scheduled"`, `repeat_done` increments

#### Scenario: Mark one-shot as completed

- GIVEN a `once`-kind job that just ran
- WHEN `markJobRun(job, "completed")` is called
- THEN `enabled` is set to `false` and `state="completed"`

#### Scenario: Mark failure with error

- GIVEN a job that failed
- WHEN `markJobRun(job, "error", "timeout")` is called
- THEN `last_status="error"`, `last_error="timeout"`, `state="error"`
