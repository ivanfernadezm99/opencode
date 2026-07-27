# Cron CLI Specification

## Purpose

Expose cron job lifecycle management through `opencode cron <subcommand>`. Each subcommand delegates to the `CronJobs` service and optionally the scheduler for immediate execution.

## Requirements

### Requirement: Command Structure

The CLI MUST register `cron` as a yargs command under `opencode`. Subcommands: `add`, `list`, `remove`, `pause`, `resume`, `status`, `trigger`. All cron commands MUST set `instance: true` (they need the instance store) except `trigger` which MAY run without a project instance.

#### Scenario: Cron commands are registered

- GIVEN the opencode CLI is invoked
- WHEN running `opencode cron --help`
- THEN the help lists all 7 subcommands with descriptions

### Requirement: Add Command

`opencode cron add <schedule> <prompt>` MUST accept `--name`, `--model`, `--skills`, `--workdir`, `--repeat` (repeat count), `--schedule-kind` (default: `cron`). `<schedule>` value depends on kind: cron expression, seconds integer, or ISO date. Inserts via `CronJobs.create()` and prints the new job's id.

#### Scenario: Create a cron job

- GIVEN the user provides `opencode cron add "0 9 * * 1-5" "Send standup reminder"`
- WHEN the command runs
- THEN a job is created with `schedule_kind="cron"`, `schedule_expr="0 9 * * 1-5"`, and the new job id is printed to stdout

#### Scenario: Create a one-shot job

- GIVEN the user provides `opencode cron add --schedule-kind once "2026-08-01T12:00:00Z" "Deploy release"  `
- WHEN the command runs
- THEN a job with `schedule_kind="once"` is created

### Requirement: List Command

`opencode cron list` MUST output all jobs in a formatted table showing `id` (short), `name`, `schedule_expr`, `state`, `next_run_at`, `last_status`. Jobs SHALL be sorted by `next_run_at` ascending, nulls last.

#### Scenario: List empty

- GIVEN no cron jobs exist
- WHEN running `opencode cron list`
- THEN output shows "No cron jobs found"

#### Scenario: List shows all jobs

- GIVEN 2 cron jobs exist
- WHEN running `opencode cron list`
- THEN a table with 2 rows is printed, sorted by next run time

### Requirement: Remove Command

`opencode cron remove <id>` MUST delete the job via `CronJobs.remove(id)`. SHALL confirm before deletion unless `--force` is passed.

#### Scenario: Remove with confirmation

- GIVEN a job with id `abc-123`exists
- WHEN running `opencode cron remove abc-123 --force`
- THEN the job is deleted and confirmation message printed

#### Scenario: Remove nonexistent job

- GIVEN no job with id `xyz-999`exists
- WHEN running `opencode cron remove xyz-999 --force`
- THEN an error is printed and exit code is non-zero

### Requirement: Pause / Resume

`opencode cron pause <id>` MUST set `enabled=false`. `opencode cron resume <id>` MUST set `enabled=true` and recompute `next_run_at`.

#### Scenario: Pause a job

- GIVEN an enabled job
- WHEN running `opencode cron pause <id>`
- THEN the job's `enabled` is set to false

#### Scenario: Resume recalculates schedule

- GIVEN a paused job with stale `next_run_at`
- WHEN running `opencode cron resume <id>`
- THEN `enabled` becomes true and `next_run_at` is recomputed from now

### Requirement: Status Command

`opencode cron status <id>` MUST print full job details: id, name, prompt, schedule, enabled, state, next_run_at, last_run_at, last_status, last_error, repeat progress.

#### Scenario: Status shows all fields

- GIVEN a job with a completed run
- WHEN running `opencode cron status <id>`
- THEN output includes all DB fields in a readable format

### Requirement: Trigger Command

`opencode cron trigger <id>` MUST run the job immediately regardless of `next_run_at`. Does NOT advance `next_run_at` — the scheduled tick handles the next automatic run. Output is written to the same path as a scheduled run.

#### Scenario: Trigger executes immediately

- GIVEN a due job with `next_run_at` far in the future
- WHEN running `opencode cron trigger <id>`
- THEN the job runs immediately and output is persisted, without altering `next_run_at`
