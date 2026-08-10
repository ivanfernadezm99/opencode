# Delta for cron-job-storage

Change: `cron-update-safety`. Jobs created without an explicit `next_run_at` were persisted with NULL and could never become due; now `create()` self-computes the value and a backfill heals existing NULL rows.

## ADDED Requirements

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

## MODIFIED Requirements

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
