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

The `CronJobs` service MUST expose `create`, `get`, `list`, `update`, and `remove` effects accepting and returning `Schema.Class`-typed records. When the caller omits `next_run_at` and the job is enabled (`enabled != 0`), `create()` MUST compute the value via `computeNextRun(job)` and **persist it only when the computed value is strictly in the future** (`computed.getTime() > now()`); when the computed value is past or invalid, `create()` MUST store NULL. When the caller explicitly provides `next_run_at`, `create()` MUST NOT overwrite it. A caller-provided NULL is treated as omitted and MUST also trigger computation.

(Previously: `create()` wrote `next_run_at: input.next_run_at ?? undefined`, persisting NULL whenever the caller omitted it, so every seeded/added job was born permanently dead.)

#### Scenario: Create and retrieve a job

- GIVEN valid job fields (prompt, schedule_kind, schedule_expr) and no `next_run_at`
- WHEN `CronJobs.create(data)` is called
- THEN a row is inserted with a generated UUIDv7 id
- AND `next_run_at` equals `computeNextRun(data)` (non-NULL for an enabled job whose computed value is strictly in the future)

#### Scenario: Create with past computed value stores NULL

- GIVEN an enabled job whose `computeNextRun(job)` yields a timestamp in the past (e.g. a `once` schedule already passed) or an invalid expression
- WHEN `CronJobs.create(data)` is called with no `next_run_at`
- THEN `next_run_at` stays NULL (the computed value is NOT persisted because it is not strictly in the future)

#### Scenario: Explicit next_run_at is respected

- GIVEN a caller passes `next_run_at = 1700000000000` for an enabled job
- WHEN `CronJobs.create(data)` is called
- THEN the stored `next_run_at` is `1700000000000` (computation is skipped)

#### Scenario: Disabled job creation does not compute

- GIVEN a job created with `enabled = 0` and no `next_run_at`
- WHEN `CronJobs.create(data)` is called
- THEN `next_run_at` stays NULL (no computation performed)

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

### Requirement: Backfill NULL next_run_at

The `CronJobs` service MUST provide a backfill that heals `next_run_at = NULL` rows. The backfill MUST target enabled jobs only, MUST compute each healed value via `computeNextRun(job)`, and MUST be idempotent: re-running it heals no new rows and never changes an already non-NULL `next_run_at`. The backfill MUST NOT touch disabled jobs, and MUST leave untouched any enabled job for which `computeNextRun(job)` yields a timestamp that is **not strictly in the future** (`computed.getTime() > now()` is false). Note: `computeNextRun` returns a **past `Date`** for a `once` schedule that has already passed (`null` only for an invalid expression), so the guard is `computed > now` — never "skip if `null`".

#### Scenario: Backfill heals an enabled job

- GIVEN an enabled cron job with `next_run_at = NULL` and a valid `schedule_expr`
- WHEN the backfill runs
- THEN `next_run_at` is set to the `computeNextRun` value (non-NULL)
- AND the job is now returned by `getDueJobs()` once due

#### Scenario: Backfill is idempotent

- GIVEN an enabled job healed to a non-NULL `next_run_at`
- WHEN the backfill runs again
- THEN the healed `next_run_at` is unchanged and no additional rows are modified

#### Scenario: Invalid or expired jobs left untouched

- GIVEN an enabled job whose `schedule_expr` is invalid, and a `once` job whose schedule has already passed
- WHEN the backfill runs
- THEN both jobs keep `next_run_at = NULL`
- AND no error aborts the backfill for remaining rows

#### Scenario: Disabled jobs are not healed

- GIVEN a disabled job with `next_run_at = NULL`
- WHEN the backfill runs
- THEN the job keeps `next_run_at = NULL`